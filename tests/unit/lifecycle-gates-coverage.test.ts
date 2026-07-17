import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { FinalReportInput } from "../../src/cleanup/types.js"
import type { EvidenceStore } from "../../src/evidence/store.js"
import {
  validateCheckpointTransition,
  validateCleanupReason,
  validateCompletedOutcome,
  validateFixAuthorization,
  validateInstrumentationAuthorization,
  validateProcessCapture,
  validateRunFinish,
  validateRunStart,
} from "../../src/investigation/gates.js"
import {
  evidenceDecisionFingerprint,
  hypothesisSemanticFingerprint,
} from "../../src/investigation/lifecycle-receipts.js"
import type { InvestigationState } from "../../src/investigation/schema.js"
import { initialInvestigationState } from "../../src/investigation/store.js"
import { createInitialManifest } from "../../src/session/manifest-store.js"
import type { DebugSession } from "../../src/session/registry.js"
import type { CleanupManifest, ManifestRun } from "../../src/session/types.js"

const now = "2026-07-16T00:00:00.000Z"
const later = "2026-07-16T00:01:00.000Z"
const reproduction = "run the runtime fixture"
const predicate = { kind: "exit-code" as const, operator: "not-equals" as const, value: 0 }

function hypotheses(): InvestigationState["hypotheses"] {
  return [
    {
      id: "hyp_redirect",
      rank: 1,
      statement: "The redirected response is rejected",
      confirmationSignals: ["The redirect reaches a rejected response"],
      eliminationSignals: ["The redirect returns usable content"],
      status: "open",
      evidenceRefs: [],
    },
    {
      id: "hyp_timeout",
      rank: 2,
      statement: "The redirected request exceeds the timeout",
      confirmationSignals: ["The timeout fires before the response"],
      eliminationSignals: ["The response arrives before the timeout"],
      status: "open",
      evidenceRefs: [],
    },
  ]
}

function state(overrides: Partial<InvestigationState> = {}): InvestigationState {
  return {
    ...initialInvestigationState(now),
    phase: "hypotheses",
    reproduction: { method: reproduction, requiresUser: false, confirmed: null },
    hypotheses: hypotheses(),
    ...overrides,
  }
}

function run(overrides: Partial<ManifestRun> = {}): ManifestRun {
  return {
    id: "run_pre",
    label: "pre-fix",
    reproduction,
    status: "running",
    createdAt: now,
    behavioralRevisionAtStart: 0,
    ...overrides,
  }
}

function manifest(overrides: Partial<CleanupManifest> = {}): CleanupManifest {
  return {
    ...createInitialManifest({
      sessionId: "session_fixture",
      trustedSessionHash: "a".repeat(64),
      projectRoot: "/project",
      sessionDir: "/session",
      now,
    }),
    ...overrides,
  }
}

function session(currentState: InvestigationState, currentManifest: CleanupManifest): DebugSession {
  return {
    publicId: "session_fixture",
    projectRoot: "/project",
    investigationStore: { read: vi.fn().mockResolvedValue(currentState) },
    manifestStore: { read: vi.fn().mockResolvedValue(currentManifest) },
  } as unknown as DebugSession
}

function evidence(events: unknown[] = [], found: unknown[] = []): EvidenceStore {
  return {
    read: vi.fn().mockResolvedValue({ events, nextCursor: null }),
    findByIds: vi.fn().mockResolvedValue(found),
  } as unknown as EvidenceStore
}

function report(overrides: Partial<FinalReportInput> = {}): FinalReportInput {
  return {
    outcome: "completed",
    rootCause: "The redirected response is rejected",
    decidingEvidence: ["event_deciding"],
    hypotheses: [
      { id: "hyp_redirect", status: "confirmed", statement: "The redirected response is rejected" },
      { id: "hyp_timeout", status: "eliminated", statement: "The redirected request exceeds the timeout" },
    ],
    fix: "Handle the redirected response",
    changedFiles: ["src/file.ts"],
    verification: ["event_post verified the fix"],
    ...overrides,
  }
}

function decidedState(overrides: Partial<InvestigationState> = {}): InvestigationState {
  const decidedHypotheses = hypotheses()
  decidedHypotheses[0] = {
    ...(decidedHypotheses[0] as (typeof decidedHypotheses)[number]),
    status: "confirmed",
    evidenceRefs: ["event_deciding"],
  }
  decidedHypotheses[1] = {
    ...(decidedHypotheses[1] as (typeof decidedHypotheses)[number]),
    status: "eliminated",
  }
  return state({
    phase: "fixing",
    reproduction: { method: reproduction, requiresUser: false, confirmed: true },
    hypotheses: decidedHypotheses,
    decidingEvidenceIds: ["event_deciding"],
    singleCauseEvidenceRef: "event_deciding",
    decisions: [
      {
        id: "decision_fix",
        summary: "Handle the redirected response",
        evidenceRefs: ["event_deciding"],
        decidedAt: now,
      },
    ],
    fixedFiles: ["src/file.ts"],
    ...overrides,
  })
}

function decidingProbeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "event_deciding",
    sessionId: "session_fixture",
    runId: "run_pre",
    runLabel: "pre-fix",
    probeId: "probe_one",
    hypothesisId: "hyp_redirect",
    kind: "probe",
    receivedAt: "2026-07-16T00:00:30.000Z",
    data: { redirected: true },
    ...overrides,
  }
}

function validatedProbe(currentState: InvestigationState) {
  const confirmed = currentState.hypotheses.find((candidate) => candidate.id === "hyp_redirect")
  if (confirmed === undefined) throw new Error("missing confirmed hypothesis fixture")
  return {
    id: "probe_one",
    runId: "run_pre",
    hypothesisId: "hyp_redirect",
    hypothesisSha256: hypothesisSemanticFingerprint(confirmed),
    sourceFile: "/project/src/file.ts",
    sourceLine: 1,
    message: "observe redirect",
    transport: "process" as const,
    captures: [],
    sampling: { mode: "every" as const, n: 1 },
    status: "validated" as const,
    validationStatus: "validated" as const,
    markerStart: "/* start */",
    markerEnd: "/* end */",
  }
}

describe("lifecycle gate failure paths", () => {
  it("requires a unique two-to-four hypothesis slate", async () => {
    const invalid = state({ hypotheses: [hypotheses()[0] as InvestigationState["hypotheses"][number]] })
    await expect(validateInstrumentationAuthorization(session(invalid, manifest()))).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })

    const duplicate = hypotheses()
    duplicate[1] = { ...(duplicate[1] as (typeof duplicate)[number]), id: "hyp_redirect", rank: 1 }
    await expect(
      validateInstrumentationAuthorization(session(state({ hypotheses: duplicate }), manifest())),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("requires phase and an active pre-fix run before instrumentation", async () => {
    await expect(validateInstrumentationAuthorization(session(state(), manifest()))).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })

    const instrumenting = state({ phase: "instrumenting" })
    await expect(validateInstrumentationAuthorization(session(instrumenting, manifest()))).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })

    await expect(validateInstrumentationAuthorization(session(instrumenting, manifest()))).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })

    await expect(
      validateInstrumentationAuthorization(session(instrumenting, manifest({ runs: [run()] })), "run_pre"),
    ).resolves.toBeUndefined()
  })

  it("requires the first human extension probe to use the actual browser transport", async () => {
    const instrumenting = state({
      phase: "instrumenting",
      runtimeContext: { kind: "extension", target: "MV3 background" },
      reproduction: { method: reproduction, requiresUser: true, confirmed: null },
    })
    const active = manifest({
      runs: [run({ status: "waiting" })],
    })

    await expect(
      validateInstrumentationAuthorization(session(instrumenting, active), "run_pre", "process"),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      action: expect.stringContaining("actual runtime path"),
    })
    await expect(
      validateInstrumentationAuthorization(session(instrumenting, active), "run_pre", "extension-background"),
    ).resolves.toBeUndefined()
  })

  it("canonicalizes the checkpointed run boundary while enforcing lifecycle", async () => {
    const baseline = state({ phase: "baseline" })
    await expect(
      validateRunStart(session(baseline, manifest()), {
        label: "pre-fix",
        reproduction,
        waitingForUser: true,
      }),
    ).resolves.toEqual({ label: "pre-fix", reproduction, waitingForUser: false })
    await expect(
      validateRunStart(
        session(
          state({ phase: "baseline", reproduction: { method: "", requiresUser: false, confirmed: null } }),
          manifest(),
        ),
        {
          label: "pre-fix",
          reproduction: "caller supplied fallback",
          waitingForUser: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("concrete checkpointed reproduction"),
    })
    await expect(
      validateRunStart(session(baseline, manifest()), {
        label: "pre-fix",
        reproduction: "different steps",
        waitingForUser: false,
      }),
    ).resolves.toEqual({ label: "pre-fix", reproduction, waitingForUser: false })
    await expect(
      validateRunStart(session(baseline, manifest({ runs: [run()] })), {
        label: "pre-fix",
        reproduction,
        waitingForUser: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateRunStart(session(state({ phase: "analyzing" }), manifest()), {
        label: "pre-fix",
        reproduction,
        waitingForUser: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateRunStart(session(baseline, manifest()), {
        label: "pre-fix",
        reproduction,
        waitingForUser: false,
      }),
    ).resolves.toEqual({ label: "pre-fix", reproduction, waitingForUser: false })
  })

  it("permits post-fix start only after a current same-path mutation", async () => {
    const verifying = state({ phase: "verifying" })
    await expect(
      validateRunStart(session(verifying, manifest()), {
        label: "post-fix",
        reproduction,
        waitingForUser: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const fixed = manifest({ lastBehavioralMutationAt: now, behavioralRevision: 1 })
    await expect(
      validateRunStart(session(verifying, fixed), {
        label: "post-fix",
        reproduction,
        waitingForUser: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const reproduced = run({ status: "completed", issueReproduced: true, completedAt: later })
    await expect(
      validateRunStart(session(verifying, { ...fixed, runs: [reproduced] }), {
        label: "post-fix",
        reproduction,
        waitingForUser: false,
      }),
    ).resolves.toEqual({ label: "post-fix", reproduction, waitingForUser: false })
  })

  it("rejects invalid process-capture purposes and probe linkage", async () => {
    const instrumenting = state({ phase: "instrumenting" })
    const active = manifest({
      runs: [run()],
      probes: [
        {
          id: "probe_one",
          runId: "run_pre",
          hypothesisId: "hyp_redirect",
          sourceFile: "/project/src/file.ts",
          sourceLine: 1,
          message: "observe redirect",
          transport: "process",
          captures: [],
          sampling: { mode: "every", n: 1 },
          status: "validated",
          validationStatus: "validated",
          markerStart: "/* start */",
          markerEnd: "/* end */",
        },
      ],
    })
    const base = {
      session: session(instrumenting, active),
      runId: "run_pre",
      purpose: "instrumentation-check" as const,
      probeIds: ["probe_one"],
      executable: "node",
      args: ["--check", "src/file.ts"],
      env: {},
      cwd: "/project",
    }
    await expect(validateProcessCapture({ ...base, runId: "missing" })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(validateProcessCapture({ ...base, outcomePredicate: predicate })).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: "Instrumentation checks cannot define the reported issue outcome",
      action: "Omit outcomePredicate from the instrumentation-check capture",
    })
    await expect(validateProcessCapture({ ...base, purpose: "reproduction" })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(validateProcessCapture({ ...base, probeIds: [] })).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(validateProcessCapture({ ...base, probeIds: ["probe_other"] })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(validateProcessCapture({ ...base, args: ["--check", "src/unrelated.ts"] })).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("does not cover every probed source file"),
    })
    await expect(validateProcessCapture(base)).resolves.toBeUndefined()
  })

  it("rejects an instrumentation-check outcome predicate before reading lifecycle state", async () => {
    const investigationRead = vi.fn().mockRejectedValue(new Error("state must not be read"))
    const manifestRead = vi.fn().mockRejectedValue(new Error("manifest must not be read"))
    const currentSession = {
      projectRoot: "/project",
      investigationStore: { read: investigationRead },
      manifestStore: { read: manifestRead },
    } as unknown as DebugSession

    await expect(
      validateProcessCapture({
        session: currentSession,
        runId: "run_pre",
        purpose: "instrumentation-check",
        probeIds: ["probe_one"],
        executable: "node",
        args: ["--check", "src/file.ts"],
        env: {},
        cwd: "/project",
        outcomePredicate: predicate,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: "Instrumentation checks cannot define the reported issue outcome",
      action: "Omit outcomePredicate from the instrumentation-check capture",
    })
    expect(investigationRead).not.toHaveBeenCalled()
    expect(manifestRead).not.toHaveBeenCalled()
  })

  it("recognizes direct source checks without blessing project-wide or unrelated commands", async () => {
    const instrumenting = state({ phase: "instrumenting" })
    const probeEntry = {
      id: "probe_one",
      runId: "run_pre",
      hypothesisId: "hyp_redirect",
      sourceFile: "/project/src/file.ts",
      sourceLine: 1,
      message: "observe redirect",
      transport: "process" as const,
      captures: [],
      sampling: { mode: "every" as const, n: 1 },
      status: "registered" as const,
      validationStatus: "pending" as const,
      markerStart: "/* start */",
      markerEnd: "/* end */",
    }
    const active = manifest({ runs: [run()], probes: [probeEntry] })
    const base = {
      session: session(instrumenting, active),
      runId: "run_pre",
      purpose: "instrumentation-check" as const,
      probeIds: ["probe_one"],
      env: {},
      cwd: "/project",
    }

    await expect(
      validateProcessCapture({ ...base, executable: "node", args: ["--check", "src/file.ts"] }),
    ).resolves.toBeUndefined()
    await expect(
      validateProcessCapture({ ...base, executable: "tsc", args: ["--noEmit", "src/file.ts"] }),
    ).resolves.toBeUndefined()
    await expect(
      validateProcessCapture({ ...base, executable: "tsgo", args: ["--noEmit", "src/file.ts"] }),
    ).resolves.toBeUndefined()
    await expect(
      validateProcessCapture({
        ...base,
        session: session(
          instrumenting,
          manifest({ runs: [run()], probes: [{ ...probeEntry, sourceFile: "src/file.ts" }] }),
        ),
        executable: "node",
        args: ["--check", "src/file.ts"],
      }),
    ).resolves.toBeUndefined()

    await expect(
      validateProcessCapture({ ...base, executable: "npm", args: ["run", "lint", "--", "src/file.ts"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateProcessCapture({ ...base, executable: "npm.cmd", args: ["run", "lint", "--", "src/file.ts"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(validateProcessCapture({ ...base, executable: "tsc", args: ["--noEmit"] })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(
      validateProcessCapture({ ...base, executable: "tsc", args: ["--noEmit", "-p", "tools/tsconfig.json"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateProcessCapture({ ...base, executable: "pnpm", args: ["run-script", "lint:types:mv3"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateProcessCapture({ ...base, executable: "eslint", args: ["src/file.ts", "--no-warn-ignored"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateProcessCapture({ ...base, executable: "prettier", args: ["--check", "src/file.ts"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateProcessCapture({ ...base, executable: "node", args: ["--check", "src/**/*.ts"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateProcessCapture({ ...base, executable: "node", args: ["--test", "src/file.ts"] }),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("does not cover every probed source file"),
    })
    await expect(validateProcessCapture({ ...base, executable: "npm", args: ["test"] })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(validateProcessCapture({ ...base, executable: "yarn", args: ["test"] })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(validateProcessCapture({ ...base, executable: "bun", args: ["test"] })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(
      validateProcessCapture({ ...base, cwd: "/elsewhere", executable: "tsc", args: ["--noEmit"] }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateProcessCapture({
        ...base,
        executable: "git",
        args: ["diff", "--check", "--", "src/file.ts"],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("does not cover every probed source file"),
    })
    await expect(
      validateProcessCapture({
        ...base,
        executable: "vitest",
        args: ["run", "src/file.ts", "--passWithNoTests"],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("does not cover every probed source file"),
    })
    await expect(
      validateProcessCapture({
        ...base,
        executable: "npm",
        args: ["test", "--", "src/file.ts", "--passWithNoTests"],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: expect.stringContaining("does not cover every probed source file"),
    })
  })

  it("requires verification to match the fixed revision and baseline predicate", async () => {
    const post = run({
      id: "run_post",
      label: "post-fix",
      status: "running",
      createdAt: later,
      behavioralRevisionAtStart: 1,
      outcomePredicate: predicate,
    })
    const base = {
      runId: "run_post",
      purpose: "verification" as const,
      probeIds: [],
      executable: "node",
      args: ["--check", "src/file.ts"],
      env: {},
      cwd: "/project",
      outcomePredicate: predicate,
    }
    await expect(
      validateProcessCapture({
        ...base,
        session: session(state({ phase: "instrumenting" }), manifest({ runs: [post] })),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const verifying = state({ phase: "verifying" })
    const fixed = manifest({
      lastBehavioralMutationAt: now,
      behavioralRevision: 1,
      runs: [run({ status: "completed", issueReproduced: true, completedAt: later }), post],
    })
    await expect(validateProcessCapture({ ...base, session: session(verifying, fixed) })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    fixed.runs[0] = { ...(fixed.runs[0] as ManifestRun), outcomePredicate: predicate }
    await expect(validateProcessCapture({ ...base, session: session(verifying, fixed) })).resolves.toBeUndefined()
  })

  it("validates observed deterministic and human run outcomes", async () => {
    const current = state({ phase: "baseline" })
    const active = run({ outcomePredicate: predicate })
    await expect(
      validateRunFinish(session(current, manifest({ runs: [active] })), evidence(), active, {
        status: "failed",
        issueReproduced: null,
        observationSource: "deterministic",
      }),
    ).resolves.toBeUndefined()
    await expect(
      validateRunFinish(session(current, manifest({ runs: [active] })), evidence(), active, {
        status: "completed",
        issueReproduced: null,
        observationSource: "deterministic",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateRunFinish(session(current, manifest({ runs: [active] })), evidence(), active, {
        status: "completed",
        issueReproduced: true,
        observationSource: "human",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(
      validateRunFinish(session(current, manifest({ runs: [active] })), evidence(), active, {
        status: "completed",
        issueReproduced: true,
        observationSource: "deterministic",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const processResult = {
      eventId: "event_process",
      kind: "process.result",
      data: {
        purpose: "reproduction",
        probeIds: ["probe_one"],
        probeEvents: 1,
        matchingProbeEvents: 1,
        matchingProbeEventIds: ["event_deciding"],
        outcomePredicate: predicate,
        exitCode: 1,
        timedOut: false,
        issueReproduced: true,
      },
    }
    const probeEvent = decidingProbeEvent()
    await expect(
      validateRunFinish(
        session(current, manifest({ runs: [active], probes: [validatedProbe(current)] })),
        evidence([probeEvent, processResult]),
        active,
        {
          status: "completed",
          issueReproduced: true,
          observationSource: "deterministic",
        },
      ),
    ).resolves.toBeUndefined()
  })

  it("rejects a reproduced exit when the supervised capture crossed zero selected probe events", async () => {
    const current = state({ phase: "baseline" })
    const active = run({ outcomePredicate: predicate })
    const processResult = {
      eventId: "event_process",
      kind: "process.result",
      data: {
        purpose: "reproduction",
        probeIds: ["probe_one"],
        probeEvents: 0,
        matchingProbeEvents: 0,
        matchingProbeEventIds: [],
        outcomePredicate: predicate,
        exitCode: 1,
        timedOut: false,
        issueReproduced: true,
      },
    }

    await expect(
      validateRunFinish(
        session(current, manifest({ runs: [active], probes: [validatedProbe(current)] })),
        evidence([decidingProbeEvent({ eventId: "event_from_earlier_capture" }), processResult]),
        active,
        {
          status: "completed",
          issueReproduced: true,
          observationSource: "deterministic",
          observation: "The unrelated test command failed before it reached the instrumented runtime path",
        },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: "The supervised reproduction did not cross a registered active validated runtime probe boundary",
      action: expect.stringContaining("do not treat an unrelated process exit failure as the reported symptom"),
    })
  })

  it("blocks incomplete fixing checkpoints before evidence lookup", async () => {
    const baseManifest = manifest()
    await expect(validateFixAuthorization(session(state(), baseManifest), evidence(), state())).resolves.toBeUndefined()
    await expect(
      validateFixAuthorization(
        session(state({ phase: "fixing" }), baseManifest),
        evidence(),
        state({ phase: "fixing" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const reproduced = state({
      phase: "fixing",
      reproduction: { method: reproduction, requiresUser: false, confirmed: true },
    })
    await expect(
      validateFixAuthorization(session(reproduced, baseManifest), evidence(), reproduced),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    const confirmedHypotheses = hypotheses()
    confirmedHypotheses[0] = {
      ...(confirmedHypotheses[0] as (typeof confirmedHypotheses)[number]),
      status: "confirmed",
    }
    const confirmed = { ...reproduced, hypotheses: confirmedHypotheses }
    await expect(
      validateFixAuthorization(session(confirmed, baseManifest), evidence(), confirmed),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    const deciding = {
      ...confirmed,
      decidingEvidenceIds: ["event_deciding"],
      hypotheses: confirmed.hypotheses.map((item) =>
        item.id === "hyp_redirect" ? { ...item, evidenceRefs: ["event_deciding"] } : item,
      ),
      singleCauseEvidenceRef: "event_other",
    }
    await expect(validateFixAuthorization(session(deciding, baseManifest), evidence(), deciding)).rejects.toMatchObject(
      {
        code: "INVALID_PHASE",
      },
    )
    const scoped = {
      ...deciding,
      singleCauseEvidenceRef: "event_deciding",
      decisions: [
        { id: "decision_fix", summary: "Handle the redirect", evidenceRefs: ["event_deciding"], decidedAt: now },
      ],
      fixedFiles: ["src/file.ts"],
    }
    await expect(validateFixAuthorization(session(scoped, baseManifest), evidence(), scoped)).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    expect(evidenceDecisionFingerprint(scoped)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it("blocks premature verification and completed reports", async () => {
    await expect(
      validateCheckpointTransition(
        session(state({ phase: "instrumenting" }), manifest()),
        state({ phase: "instrumenting" }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(
      validateCheckpointTransition(session(state({ phase: "verifying" }), manifest()), state({ phase: "verifying" })),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(
      validateCheckpointTransition(
        session(state({ phase: "verifying" }), manifest({ lastBehavioralMutationAt: now, behavioralRevision: 1 })),
        state({ phase: "verifying" }),
      ),
    ).resolves.toBeUndefined()

    await expect(
      validateCompletedOutcome(session(state(), manifest()), evidence(), report({ outcome: "unresolved" })),
    ).resolves.toMatchObject({ outcome: "unresolved" })
    await expect(validateCompletedOutcome(session(state(), manifest()), evidence(), report())).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    const verifying = state({ phase: "verifying" })
    await expect(validateCompletedOutcome(session(verifying, manifest()), evidence(), report())).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    const confirmedHypotheses = hypotheses()
    confirmedHypotheses[0] = {
      ...(confirmedHypotheses[0] as (typeof confirmedHypotheses)[number]),
      status: "confirmed",
      evidenceRefs: ["event_deciding"],
    }
    const decided = { ...verifying, hypotheses: confirmedHypotheses, decidingEvidenceIds: ["event_deciding"] }
    await expect(
      validateCompletedOutcome(session(decided, manifest()), evidence(), report({ decidingEvidence: [] })),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("rejects absolute capture arguments outside the project", async () => {
    const current = state({ phase: "instrumenting" })
    await expect(
      validateProcessCapture({
        session: session(current, manifest({ runs: [run()] })),
        runId: "run_pre",
        purpose: "instrumentation-check",
        probeIds: [],
        executable: "node",
        args: ["--check", path.join(path.parse(process.cwd()).root, "outside.ts")],
        env: {},
        cwd: "/project",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("accepts a fully bound runtime decision and completed same-path report", async () => {
    const decided = decidedState()
    const preFix = run({
      status: "completed",
      completedAt: later,
      issueReproduced: true,
      observationSource: "deterministic",
      outcomePredicate: predicate,
    })
    const probe = validatedProbe(decided)
    const decisionManifest = manifest({ runs: [preFix], probes: [probe] })
    const decidingEvent = decidingProbeEvent()

    await expect(
      validateFixAuthorization(session(decided, decisionManifest), evidence([], [decidingEvent]), decided),
    ).resolves.toBeUndefined()

    const refined = decidedState({
      hypotheses: decided.hypotheses.map((hypothesis) =>
        hypothesis.id === "hyp_redirect"
          ? { ...hypothesis, statement: "Runtime evidence confirms the redirected response is rejected" }
          : hypothesis,
      ),
    })
    await expect(
      validateFixAuthorization(session(refined, decisionManifest), evidence([], [decidingEvent]), refined),
    ).resolves.toBeUndefined()

    const postFix: ManifestRun = {
      ...run(),
      id: "run_post",
      label: "post-fix",
      status: "completed",
      createdAt: "2026-07-16T00:02:00.000Z",
      completedAt: "2026-07-16T00:03:00.000Z",
      issueReproduced: false,
      observationSource: "deterministic",
      behavioralRevisionAtStart: 1,
      outcomePredicate: predicate,
    }
    const completedState = decidedState({ phase: "cleaning" })
    const completedManifest = manifest({
      lastBehavioralMutationAt: later,
      behavioralRevision: 1,
      behavioralMutations: [{ revision: 1, completedAt: later, tool: "edit", paths: ["src/file.ts"] }],
      runs: [preFix, postFix],
      probes: [{ ...validatedProbe(completedState), status: "removed" }],
    })
    const postEvent = {
      eventId: "event_post",
      sessionId: "session_fixture",
      runId: "run_post",
      runLabel: "post-fix",
      hypothesisId: "hyp_redirect",
      kind: "process.result",
      receivedAt: "2026-07-16T00:02:30.000Z",
      data: { purpose: "verification" },
    }
    const completedEvidence = {
      findByIds: vi.fn().mockResolvedValue([decidingEvent]),
      read: vi.fn().mockImplementation(async ({ runId, cursor }: { runId: string; cursor?: string }) => ({
        events: runId === "run_post" && cursor === undefined ? [postEvent] : [],
        nextCursor: runId === "run_post" && cursor === undefined ? "done" : null,
      })),
    } as unknown as EvidenceStore

    await expect(
      validateCompletedOutcome(session(completedState, completedManifest), completedEvidence, report()),
    ).resolves.toMatchObject({
      outcome: "completed",
      decidingEvidence: ["event_deciding"],
      changedFiles: ["src/file.ts"],
      verification: [expect.stringContaining("event_post")],
    })
    expect(completedEvidence.read).toHaveBeenCalledTimes(2)
  })

  it("accepts a replied human reproduction receipt", async () => {
    const humanState = state({
      phase: "baseline",
      reproduction: { method: reproduction, requiresUser: true, confirmed: null },
    })
    const waiting = run({
      status: "waiting",
      reproductionFingerprint: "fixture-fingerprint",
    })
    const humanManifest = manifest({
      runs: [waiting],
      humanCheckpoints: [
        {
          requestId: "question_fixture",
          runId: waiting.id,
          purpose: "reproduction",
          reproductionFingerprint: "fixture-fingerprint",
          questionSha256: "a".repeat(64),
          status: "replied",
          issueReproduced: true,
          askedAt: now,
          repliedAt: later,
        },
      ],
    })

    await expect(
      validateRunFinish(session(humanState, humanManifest), evidence(), waiting, {
        status: "completed",
        issueReproduced: true,
        observationSource: "human",
      }),
    ).resolves.toBeUndefined()
  })

  it.each([
    [
      "an unbound predicate",
      {
        purpose: "reproduction",
        outcomePredicate: { kind: "broken" },
        exitCode: 1,
        timedOut: false,
        issueReproduced: true,
      },
    ],
    [
      "an invalid exit code",
      { purpose: "reproduction", outcomePredicate: predicate, exitCode: "1", timedOut: false, issueReproduced: true },
    ],
    [
      "a mismatched derived result",
      { purpose: "reproduction", outcomePredicate: predicate, exitCode: 1, timedOut: false, issueReproduced: false },
    ],
  ])("rejects deterministic evidence with %s", async (_label, data) => {
    const active = run({ outcomePredicate: predicate })
    const processResult = { kind: "process.result", data }
    await expect(
      validateRunFinish(
        session(state({ phase: "baseline" }), manifest({ runs: [active] })),
        evidence([processResult]),
        active,
        {
          status: "completed",
          issueReproduced: true,
          observationSource: "deterministic",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("accepts prepared human runs and project-contained absolute capture paths", async () => {
    const human = state({
      phase: "baseline",
      reproduction: { method: reproduction, requiresUser: true, confirmed: null },
    })
    await expect(
      validateRunStart(session(human, manifest()), {
        label: "pre-fix",
        reproduction,
        waitingForUser: true,
      }),
    ).resolves.toEqual({ label: "pre-fix", reproduction, waitingForUser: true })

    const instrumenting = state({ phase: "instrumenting" })
    const activeManifest = manifest({
      runs: [run()],
      probes: [
        {
          ...validatedProbe(instrumenting),
          hypothesisSha256: undefined,
        },
      ],
    })
    await expect(
      validateProcessCapture({
        session: session(instrumenting, activeManifest),
        runId: "run_pre",
        purpose: "instrumentation-check",
        probeIds: ["probe_one"],
        executable: "node",
        args: ["--check", "/project/src/file.ts"],
        env: {},
        cwd: "/project",
      }),
    ).resolves.toBeUndefined()
  })

  it("covers terminal cleanup combinations and the legacy fix timestamp", async () => {
    expect(() => validateCleanupReason("cancelled", "completed")).toThrowError(
      expect.objectContaining({ code: "INVALID_PHASE" }),
    )
    expect(() => validateCleanupReason("cancelled", "unresolved")).not.toThrow()
    expect(() => validateCleanupReason("custom", "completed")).not.toThrow()

    await expect(
      validateCheckpointTransition(
        session(state({ phase: "cleaning" }), manifest({ fixStartedAt: now, behavioralRevision: 1 })),
        state({ phase: "cleaning" }),
      ),
    ).resolves.toBeUndefined()
  })
})
