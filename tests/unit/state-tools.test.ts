import { tool } from "@opencode-ai/plugin"
import { describe, expect, it, vi } from "vitest"
import { hypothesisSlateFingerprint } from "../../src/investigation/lifecycle-receipts.js"
import { type InvestigationState, InvestigationStateSchema } from "../../src/investigation/schema.js"
import { initialInvestigationState } from "../../src/investigation/store.js"
import type { CleanupManifest } from "../../src/session/types.js"
import { createStateCheckpointTool, createStateReadTool } from "../../src/tools/state-tools.js"
import { toolContextFixture } from "../helpers/factories.js"

const recoveryNow = "2026-07-16T00:00:00.000Z"
const recoveryMethod = "open the MV3 extension and run Check for updates"

function recoveryState(requiresUser = false): InvestigationState {
  return {
    ...initialInvestigationState(recoveryNow),
    phase: "analyzing" as const,
    runtimeContext: { kind: "extension" as const, target: "mv3" },
    reproduction: { method: recoveryMethod, requiresUser, confirmed: null },
    hypotheses: [
      {
        id: "hyp_redirect",
        rank: 1,
        statement: "redirect handling fails",
        confirmationSignals: ["redirected request fails"],
        eliminationSignals: ["redirected request succeeds"],
        status: "open" as const,
        evidenceRefs: [],
      },
      {
        id: "hyp_timeout",
        rank: 2,
        statement: "timeout fires first",
        confirmationSignals: ["timeout wins"],
        eliminationSignals: ["response wins"],
        status: "open" as const,
        evidenceRefs: [],
      },
    ],
  }
}

function recoveryRun(status: CleanupManifest["runs"][number]["status"] = "failed"): CleanupManifest["runs"][number] {
  return {
    id: "run_first",
    label: "pre-fix",
    reproduction: recoveryMethod,
    status,
    createdAt: recoveryNow,
    ...(["completed", "failed", "timed_out", "cancelled"].includes(status)
      ? { completedAt: "2026-07-16T00:01:00.000Z" }
      : {}),
  }
}

function recoveryManifest(
  currentState: ReturnType<typeof recoveryState>,
  overrides: Partial<CleanupManifest> = {},
): CleanupManifest {
  return {
    runs: [recoveryRun()],
    probes: [],
    behavioralRevision: 0,
    behavioralMutations: [],
    visibleHypothesesAt: recoveryNow,
    visibleHypothesesSha256: hypothesisSlateFingerprint(currentState),
    ...overrides,
  } as CleanupManifest
}

function promotedRecoveryState(currentState: ReturnType<typeof recoveryState>) {
  return {
    ...structuredClone(currentState),
    phase: "hypotheses" as const,
    loopIteration: currentState.loopIteration + 1,
    reproduction: { ...currentState.reproduction, requiresUser: true },
    hypotheses: currentState.hypotheses.map((hypothesis) => ({
      ...hypothesis,
      statement: `${hypothesis.statement} in the interactive runtime`,
    })),
  }
}

function recoveryCheckpointTool(currentState: ReturnType<typeof recoveryState>, manifest: CleanupManifest) {
  const checkpoint = vi.fn().mockImplementation(async (_revision: number, candidate: typeof currentState) => ({
    state: { ...candidate, revision: 1 },
    bytes: 1,
  }))
  const modify = vi
    .fn()
    .mockImplementation(async (mutate: (value: CleanupManifest) => CleanupManifest) => mutate(manifest))
  const session = {
    projectRoot: "/project",
    manifestStore: { read: vi.fn().mockResolvedValue(manifest), modify },
    investigationStore: { read: vi.fn().mockResolvedValue(currentState), checkpoint },
  }
  const registry = {
    requireOwned: vi.fn().mockResolvedValue(session),
    touch: vi.fn().mockResolvedValue(undefined),
  }
  return {
    checkpoint,
    modify,
    tool: createStateCheckpointTool(registry as never, () => ({}) as never),
  }
}

describe("debug_state_read", () => {
  it("contains unexpected storage failures behind the public envelope", async () => {
    const tool = createStateReadTool({ requireOwned: vi.fn().mockRejectedValue(new Error("secret")) } as never)
    const result = JSON.parse((await tool.execute({}, toolContextFixture())) as string)
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Checkpoint is unavailable", retryable: false },
    })
  })

  it("returns canonical visible hypotheses and run-start arguments", async () => {
    const state = {
      ...initialInvestigationState("2026-07-16T00:00:00.000Z"),
      reproduction: { method: "open the MV3 extension", requiresUser: true, confirmed: null },
      hypotheses: [
        {
          id: "hyp_redirect",
          rank: 1,
          statement: "redirect handling fails",
          confirmationSignals: ["redirected request fails"],
          eliminationSignals: ["redirected request succeeds"],
          status: "open" as const,
          evidenceRefs: [],
        },
        {
          id: "hyp_timeout",
          rank: 2,
          statement: "timeout fires first",
          confirmationSignals: ["timeout wins"],
          eliminationSignals: ["response wins"],
          status: "open" as const,
          evidenceRefs: [],
        },
      ],
    }
    const session = {
      projectRoot: "/project",
      manifestStore: { read: vi.fn().mockResolvedValue({ runs: [], probes: [] }) },
      investigationStore: { readRecovery: vi.fn().mockResolvedValue({ ok: true, state, warnings: [] }) },
    }
    const tool = createStateReadTool({ requireOwned: vi.fn().mockResolvedValue(session) } as never)

    const result = JSON.parse((await tool.execute({}, toolContextFixture())) as string)

    expect(result.data.visibilityReceiptMarkdown).toContain("## Working hypotheses")
    expect(result.data.visibilityReceiptMarkdown).toContain("1. hyp_redirect — redirect handling fails")
    expect(result.data.preFixRunStartArgs).toEqual({
      label: "pre-fix",
      reproduction: "open the MV3 extension",
      waitingForUser: true,
    })
  })

  it("returns the canonical evidence-decision receipt for classified hypotheses", async () => {
    const state = {
      ...initialInvestigationState("2026-07-16T00:00:00.000Z"),
      hypotheses: [
        {
          id: "hyp_redirect",
          rank: 1,
          statement: "redirect handling fails",
          confirmationSignals: ["redirected request fails"],
          eliminationSignals: ["redirected request succeeds"],
          status: "confirmed" as const,
          evidenceRefs: ["event_redirect"],
        },
        {
          id: "hyp_timeout",
          rank: 2,
          statement: "timeout fires first",
          confirmationSignals: ["timeout wins"],
          eliminationSignals: ["response wins"],
          status: "eliminated" as const,
          evidenceRefs: ["event_timing"],
        },
      ],
      decidingEvidenceIds: ["event_redirect", "event_timing"],
    }
    const session = {
      projectRoot: "/project",
      manifestStore: { read: vi.fn().mockResolvedValue({ runs: [], probes: [] }) },
      investigationStore: { readRecovery: vi.fn().mockResolvedValue({ ok: true, state, warnings: [] }) },
    }
    const stateRead = createStateReadTool({ requireOwned: vi.fn().mockResolvedValue(session) } as never)

    const result = JSON.parse((await stateRead.execute({}, toolContextFixture())) as string)

    expect(result.data.evidenceDecisionReceiptMarkdown).toBe(
      [
        "## Evidence decision",
        "- hyp_redirect: confirmed — event_redirect",
        "- hyp_timeout: eliminated — event_timing",
        "Deciding evidence: event_redirect, event_timing",
      ].join("\n"),
    )
  })

  it("returns canonical Question arguments for the single prepared waiting run", async () => {
    const procedure = "subscribe to the raw URL, rename the repo, change content, and run Check for updates"
    const state = {
      ...initialInvestigationState("2026-07-16T00:00:00.000Z"),
      phase: "waiting_for_reproduction" as const,
      reproduction: { method: procedure, requiresUser: true, confirmed: null },
    }
    const manifest = {
      runs: [
        {
          id: "run_fixture",
          label: "pre-fix",
          status: "waiting",
          reproduction: procedure,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      probes: [],
    }
    const session = {
      projectRoot: "/project",
      manifestStore: { read: vi.fn().mockResolvedValue(manifest) },
      investigationStore: { readRecovery: vi.fn().mockResolvedValue({ ok: true, state, warnings: [] }) },
    }
    const stateRead = createStateReadTool({ requireOwned: vi.fn().mockResolvedValue(session) } as never)

    const result = JSON.parse((await stateRead.execute({}, toolContextFixture())) as string)

    expect(result.data.preparedQuestionArgs).toMatchObject({
      questions: [
        {
          header: "Reproduce",
          question: expect.stringContaining(procedure),
          multiple: false,
          custom: false,
          options: [{ label: "Reproduced" }, { label: "Did not reproduce" }, { label: "Could not complete" }],
        },
      ],
    })
  })

  it("returns canonical manifest probe statuses without rewriting mismatched identities", async () => {
    const state = {
      ...initialInvestigationState("2026-07-16T00:00:00.000Z"),
      probeRefs: [
        {
          id: "probe_matching",
          runId: "run_fixture",
          hypothesisId: "hyp_fixture",
          sourceFile: "src/file.ts",
          status: "registered" as const,
        },
        {
          id: "probe_wrong_source",
          runId: "run_fixture",
          hypothesisId: "hyp_fixture",
          sourceFile: "src/other.ts",
          status: "ambiguous" as const,
        },
        {
          id: "probe_wrong_run",
          runId: "run_other",
          hypothesisId: "hyp_fixture",
          sourceFile: "src/file.ts",
          status: "registered" as const,
        },
      ],
    }
    const session = {
      projectRoot: "/project",
      manifestStore: {
        read: vi.fn().mockResolvedValue({
          runs: [
            {
              id: "run_fixture",
              label: "pre-fix",
              status: "waiting",
              issueReproduced: null,
              reproduction: "open the extension",
              createdAt: "2026-07-16T00:00:00.000Z",
            },
          ],
          probes: [
            {
              id: "probe_matching",
              runId: "run_fixture",
              hypothesisId: "hyp_fixture",
              sourceFile: "/project/src/file.ts",
              status: "validated",
            },
            {
              id: "probe_wrong_source",
              runId: "run_fixture",
              hypothesisId: "hyp_fixture",
              sourceFile: "/project/src/file.ts",
              status: "removed",
            },
            {
              id: "probe_wrong_run",
              runId: "run_fixture",
              hypothesisId: "hyp_fixture",
              sourceFile: "/project/src/file.ts",
              status: "validated",
            },
          ],
        }),
      },
      investigationStore: {
        readRecovery: vi.fn().mockResolvedValue({ ok: true, state, warnings: [] }),
      },
    }
    const tool = createStateReadTool({ requireOwned: vi.fn().mockResolvedValue(session) } as never)

    const result = JSON.parse((await tool.execute({}, toolContextFixture())) as string)

    expect(result.data.state.probeRefs).toEqual([
      expect.objectContaining({ id: "probe_matching", status: "validated" }),
      expect.objectContaining({ id: "probe_wrong_source", status: "ambiguous" }),
      expect.objectContaining({ id: "probe_wrong_run", status: "registered" }),
    ])
    expect(result.data.state.runs).toEqual([
      {
        id: "run_fixture",
        label: "pre-fix",
        status: "waiting",
        issueReproduced: null,
        evidenceRefs: [],
      },
    ])
  })
})

describe("debug_state_checkpoint", () => {
  it("exposes the complete investigation state schema to OpenCode", () => {
    const checkpoint = createStateCheckpointTool({} as never, () => ({}) as never)
    const stateSchema = checkpoint.args.state as unknown as typeof InvestigationStateSchema
    const jsonSchema = tool.schema.toJSONSchema(stateSchema as never) as {
      properties?: Record<
        string,
        {
          description?: string
          properties?: Record<string, { description?: string }>
        }
      >
      required?: string[]
    }

    expect(stateSchema).toBe(InvestigationStateSchema)
    expect(stateSchema.safeParse({ phase: "hypotheses" }).success).toBe(false)
    expect(jsonSchema.properties).toMatchObject({
      schemaVersion: expect.any(Object),
      hypotheses: expect.any(Object),
      reproduction: expect.any(Object),
      cleanup: expect.any(Object),
    })
    expect(jsonSchema.required).toEqual(
      expect.arrayContaining(["schemaVersion", "hypotheses", "reproduction", "cleanup"]),
    )
    expect(jsonSchema.properties?.reproduction?.description).toContain("gated false-to-true recovery")
    expect(jsonSchema.properties?.reproduction?.properties?.requiresUser?.description).toContain(
      "provided procedure requires a person to interact with a browser, extension, device, or other external state",
    )
    expect(jsonSchema.properties?.reproduction?.properties?.requiresUser?.description).toContain(
      "existing command that can be supervised by debug_process_capture already reproduces the exact same runtime symptom",
    )
    expect(jsonSchema.properties?.reproduction?.properties?.requiresUser?.description).toContain(
      "local Node, fetch, mock, fixture, or test approximation does not justify false",
    )
    expect(jsonSchema.properties?.reproduction?.properties?.requiresUser?.description).toContain(
      "true can never become false",
    )
    expect(checkpoint.description).toContain("reproduction.requiresUser=true")
    expect(checkpoint.description).toContain("true can never become false")
  })

  it("returns an actionable STATE_INVALID envelope for an incomplete state", async () => {
    const checkpoint = createStateCheckpointTool(
      { requireOwned: vi.fn().mockResolvedValue({}) } as never,
      () => ({}) as never,
    )
    const result = JSON.parse(
      (await checkpoint.execute(
        { expectedRevision: 0, state: { phase: "hypotheses" } } as never,
        toolContextFixture(),
      )) as string,
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "STATE_INVALID",
        message: "Checkpoint must contain the complete investigation state returned by debug_state_read",
        retryable: false,
        action: expect.stringContaining("state.schemaVersion"),
        details: {
          issueCount: expect.any(Number),
          listedIssueCount: expect.any(Number),
          issueSummary: expect.stringContaining("state.schemaVersion (invalid_value)"),
        },
      },
    })
  })

  it("accepts a complete checkpoint serialized as JSON", async () => {
    const state = recoveryState()
    const { checkpoint, tool } = recoveryCheckpointTool(state, recoveryManifest(state, { runs: [] }))

    const result = JSON.parse(
      (await tool.execute(
        { expectedRevision: 0, state: JSON.stringify(state) } as never,
        toolContextFixture(),
      )) as string,
    )

    expect(result).toMatchObject({ ok: true, data: { revision: 1 } })
    expect(checkpoint).toHaveBeenCalledWith(0, state)
  })

  it("identifies missing nested hypothesis fields without echoing checkpoint values", async () => {
    const checkpoint = createStateCheckpointTool(
      { requireOwned: vi.fn().mockResolvedValue({}) } as never,
      () => ({}) as never,
    )
    const state = InvestigationStateSchema.parse({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-07-15T10:00:00.000Z",
      problemSummary: "sensitive summary",
      expectedBehavior: "expected",
      actualBehavior: "actual",
      runtimeContext: { kind: "extension", target: "mv3" },
      reproduction: { method: "steps", requiresUser: true, confirmed: null },
      successCriteria: [],
      phase: "hypotheses",
      loopIteration: 0,
      singleCauseEvidenceRef: null,
      hypotheses: [
        {
          id: "hypothesis-one",
          rank: 1,
          statement: "statement",
          confirmationSignals: ["confirm"],
          eliminationSignals: ["eliminate"],
          status: "open",
          evidenceRefs: [],
          invalidatedBy: "",
        },
      ],
      completedChecks: [],
      runs: [],
      probeRefs: [],
      decidingEvidenceIds: [],
      developerConfirmations: [],
      decisions: [],
      nextAction: "instrument",
      instrumentedFiles: [],
      fixedFiles: [],
      cleanup: { status: "not_started", completedResources: [] },
    })
    const incomplete = structuredClone(state) as Record<string, unknown>
    delete (incomplete.hypotheses as Array<Record<string, unknown>>)[0]?.eliminationSignals

    const result = JSON.parse(
      (await checkpoint.execute({ expectedRevision: 0, state: incomplete } as never, toolContextFixture())) as string,
    )

    expect(result.error).toMatchObject({
      code: "STATE_INVALID",
      action: expect.stringContaining("state.hypotheses[0].eliminationSignals"),
      details: {
        issueCount: 1,
        listedIssueCount: 1,
        issueSummary: "state.hypotheses[0].eliminationSignals (invalid_type)",
      },
    })
    expect(JSON.stringify(result)).not.toContain("sensitive summary")
  })

  it("reconciles durable probe statuses from the manifest before checkpointing", async () => {
    const state = {
      ...initialInvestigationState("2026-07-16T00:00:00.000Z"),
      probeRefs: [
        {
          id: "probe_validated",
          runId: "run_fixture",
          hypothesisId: "hyp_fixture",
          sourceFile: "src/file.ts",
          status: "registered" as const,
        },
        {
          id: "probe_removed",
          runId: "run_fixture",
          hypothesisId: "hyp_fixture",
          sourceFile: "src/file.ts",
          status: "ambiguous" as const,
        },
      ],
    }
    const checkpoint = vi
      .fn()
      .mockImplementation(async (_revision: number, candidate: typeof state) => ({ state: candidate, bytes: 1 }))
    const session = {
      projectRoot: "/project",
      manifestStore: {
        read: vi.fn().mockResolvedValue({
          runs: [],
          probes: [
            {
              id: "probe_validated",
              runId: "run_fixture",
              hypothesisId: "hyp_fixture",
              sourceFile: "/project/src/file.ts",
              status: "validated",
            },
            {
              id: "probe_removed",
              runId: "run_fixture",
              hypothesisId: "hyp_fixture",
              sourceFile: "/project/src/file.ts",
              status: "removed",
            },
          ],
        }),
      },
      investigationStore: { read: vi.fn().mockResolvedValue(state), checkpoint },
    }
    const registry = {
      requireOwned: vi.fn().mockResolvedValue(session),
      touch: vi.fn().mockResolvedValue(undefined),
    }
    const tool = createStateCheckpointTool(registry as never, () => ({}) as never)

    const result = JSON.parse((await tool.execute({ expectedRevision: 0, state }, toolContextFixture())) as string)

    expect(result.ok).toBe(true)
    expect(checkpoint).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        probeRefs: [
          expect.objectContaining({ id: "probe_validated", status: "validated" }),
          expect.objectContaining({ id: "probe_removed", status: "removed" }),
        ],
      }),
    )
  })

  it("promotes a mistaken deterministic boundary to a human checkpoint at a safe new iteration", async () => {
    const currentState = recoveryState()
    const candidate = promotedRecoveryState(currentState)
    const { checkpoint, tool } = recoveryCheckpointTool(currentState, recoveryManifest(currentState))

    const result = JSON.parse(
      (await tool.execute({ expectedRevision: 0, state: candidate }, toolContextFixture())) as string,
    )

    expect(result.ok).toBe(true)
    expect(result.data.preFixRunStartArgs).toEqual({
      label: "pre-fix",
      reproduction: recoveryMethod,
      waitingForUser: true,
    })
    expect(checkpoint).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        phase: "hypotheses",
        loopIteration: 1,
        reproduction: expect.objectContaining({ requiresUser: true }),
      }),
    )
  })

  it.each([
    "planned",
    "running",
    "waiting",
  ] as const)("rejects false-to-true promotion while a %s run is nonterminal", async (status) => {
    const currentState = recoveryState()
    const { checkpoint, tool } = recoveryCheckpointTool(
      currentState,
      recoveryManifest(currentState, { runs: [recoveryRun(status)] }),
    )

    const result = JSON.parse(
      (await tool.execute(
        { expectedRevision: 0, state: promotedRecoveryState(currentState) },
        toolContextFixture(),
      )) as string,
    )

    expect(result.error).toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("safe new hypothesis iteration"),
      action: expect.stringContaining("Finish or cancel every nonterminal run"),
      details: { allRunsTerminal: false },
    })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it("never permits a human reproduction boundary to be demoted to deterministic", async () => {
    const currentState = recoveryState(true)
    const candidate = {
      ...promotedRecoveryState(currentState),
      reproduction: { ...currentState.reproduction, requiresUser: false },
    }
    const { checkpoint, tool } = recoveryCheckpointTool(currentState, recoveryManifest(currentState))

    const result = JSON.parse(
      (await tool.execute({ expectedRevision: 0, state: candidate }, toolContextFixture())) as string,
    )

    expect(result.error).toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("frozen after the first baseline run starts"),
      action: expect.stringContaining("Never change reproduction.requiresUser from true to false"),
    })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it.each([
    [
      "runtime kind",
      (candidate: ReturnType<typeof promotedRecoveryState>) => ({
        ...candidate,
        runtimeContext: { ...candidate.runtimeContext, kind: "web" as const },
      }),
    ],
    [
      "reproduction method",
      (candidate: ReturnType<typeof promotedRecoveryState>) => ({
        ...candidate,
        reproduction: { ...candidate.reproduction, method: `${candidate.reproduction.method} twice` },
      }),
    ],
  ] as const)("rejects promotion when the %s changes", async (_label, mutate) => {
    const currentState = recoveryState()
    const candidate = mutate(promotedRecoveryState(currentState))
    const { checkpoint, tool } = recoveryCheckpointTool(currentState, recoveryManifest(currentState))

    const result = JSON.parse(
      (await tool.execute({ expectedRevision: 0, state: candidate }, toolContextFixture())) as string,
    )

    expect(result.error).toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("safe new hypothesis iteration"),
      action: expect.stringContaining("Keep runtimeContext.kind and reproduction.method unchanged"),
    })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it("rejects promotion after a deterministic pre-fix run reproduced the symptom", async () => {
    const currentState = recoveryState()
    const reproduced = {
      ...recoveryRun("completed"),
      observationSource: "deterministic" as const,
      issueReproduced: true,
    }
    const { checkpoint, tool } = recoveryCheckpointTool(
      currentState,
      recoveryManifest(currentState, { runs: [reproduced] }),
    )

    const result = JSON.parse(
      (await tool.execute(
        { expectedRevision: 0, state: promotedRecoveryState(currentState) },
        toolContextFixture(),
      )) as string,
    )

    expect(result.error).toMatchObject({
      code: "INVALID_PHASE",
      details: { deterministicPreFixReproduced: true },
    })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it.each([
    ["fix start", { fixStartedAt: recoveryNow }],
    ["mutation timestamp", { lastBehavioralMutationAt: recoveryNow }],
    ["behavioral revision", { behavioralRevision: 1 }],
    [
      "mutation receipt",
      {
        behavioralMutations: [{ revision: 1, tool: "edit", paths: ["src/file.ts"], completedAt: recoveryNow }],
      },
    ],
  ] as const)("rejects promotion after %s", async (_label, manifestMutation) => {
    const currentState = recoveryState()
    const { checkpoint, tool } = recoveryCheckpointTool(
      currentState,
      recoveryManifest(currentState, manifestMutation as Partial<CleanupManifest>),
    )

    const result = JSON.parse(
      (await tool.execute(
        { expectedRevision: 0, state: promotedRecoveryState(currentState) },
        toolContextFixture(),
      )) as string,
    )

    expect(result.error).toMatchObject({
      code: "INVALID_PHASE",
      details: { behavioralMutationStarted: true },
    })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it.each(["current", "incoming"] as const)("rejects promotion with %s deciding evidence", async (source) => {
    const currentState = {
      ...recoveryState(),
      decidingEvidenceIds: source === "current" ? ["event_deciding"] : [],
    }
    const candidate = {
      ...promotedRecoveryState(currentState),
      decidingEvidenceIds: source === "incoming" ? ["event_deciding"] : currentState.decidingEvidenceIds,
    }
    const { checkpoint, tool } = recoveryCheckpointTool(currentState, recoveryManifest(currentState))

    const result = JSON.parse(
      (await tool.execute({ expectedRevision: 0, state: candidate }, toolContextFixture())) as string,
    )

    expect(result.error).toMatchObject({
      code: "INVALID_PHASE",
      details: { decidingEvidencePresent: true },
    })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it.each([
    ["the phase does not return to hypotheses", { phase: "analyzing" as const }],
    ["loopIteration does not increase", { loopIteration: 0 }],
  ] as const)("rejects promotion when %s", async (_label, invalidIteration) => {
    const currentState = recoveryState()
    const candidate = { ...promotedRecoveryState(currentState), ...invalidIteration }
    const { checkpoint, tool } = recoveryCheckpointTool(currentState, recoveryManifest(currentState))

    const result = JSON.parse(
      (await tool.execute({ expectedRevision: 0, state: candidate }, toolContextFixture())) as string,
    )

    expect(result.error).toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("safe new hypothesis iteration"),
    })
    expect(checkpoint).not.toHaveBeenCalled()
  })
})
