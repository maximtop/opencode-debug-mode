import { describe, expect, it } from "vitest"
import {
  validateCheckpointTransition,
  validateCleanupReason,
  validateControlledCommand,
} from "../../src/investigation/gates.js"
import { InvestigationStateSchema } from "../../src/investigation/schema.js"
import { initialInvestigationState } from "../../src/investigation/store.js"
import type { DebugSession } from "../../src/session/registry.js"
import type { CleanupManifest, ManifestProbe } from "../../src/session/types.js"

function waitingState(): ReturnType<typeof initialInvestigationState> {
  return {
    ...initialInvestigationState("2026-07-15T00:00:00.000Z"),
    phase: "waiting_for_reproduction" as const,
    hypotheses: [
      {
        id: "hyp_browser",
        rank: 1,
        statement: "The browser request fails before it reaches the downloader",
        confirmationSignals: ["No downloader response is observed"],
        eliminationSignals: ["A downloader response is observed"],
        status: "open" as const,
        evidenceRefs: [],
      },
      {
        id: "hyp_timeout",
        rank: 2,
        statement: "The downloader times out while following the redirect",
        confirmationSignals: ["The timeout fires before the response"],
        eliminationSignals: ["The response arrives before the timeout"],
        status: "open" as const,
        evidenceRefs: [],
      },
    ],
  }
}

function probe(overrides: Partial<ManifestProbe> = {}): ManifestProbe {
  return {
    id: "probe_browser",
    runId: "run_waiting",
    hypothesisId: "hyp_browser",
    sourceFile: "/project/src/browser.ts",
    sourceLine: 1,
    message: "browser probe",
    transport: "extension-background",
    captures: [],
    sampling: { mode: "every", n: 1 },
    status: "validated",
    validationStatus: "validated",
    markerStart: "/* DEBUG-START fixture */",
    markerEnd: "/* DEBUG-END fixture */",
    ...overrides,
  }
}

function waitingSession(probes: ManifestProbe[]): DebugSession {
  const manifest = {
    projectRoot: "/project",
    collector: { status: "ready" },
    runs: [{ id: "run_waiting", label: "pre-fix", status: "waiting" }],
    probes,
  } as unknown as CleanupManifest
  return {
    manifestStore: { read: async () => manifest },
    investigationStore: {
      read: async () => ({ ...waitingState(), phase: "instrumenting" as const }),
    },
  } as unknown as DebugSession
}

describe("lifecycle command and schema gates", () => {
  it.each([
    ["bash", ["-lc", "touch src.ts"]],
    ["node", ["--eval", "require('node:fs').writeFileSync('src.ts', 'x')"]],
    ["git", ["apply", "fix.patch"]],
    ["npm", ["publish"]],
    ["npx", ["tsx", "script.ts"]],
  ])("rejects write-capable supervised command %s", (executable, args) => {
    expect(() => validateControlledCommand(executable, args)).toThrowError(
      expect.objectContaining({ code: "INVALID_PHASE" }),
    )
  })

  it.each([
    ["node", ["--check", "src.ts"]],
    ["git", ["status", "--short"]],
    ["npm", ["test"]],
  ])("allows direct read/check command %s", (executable, args) => {
    expect(() => validateControlledCommand(executable, args)).not.toThrow()
  })

  it("requires cleanup reason and outcome to agree", () => {
    expect(() => validateCleanupReason("completed", "unresolved")).toThrowError(
      expect.objectContaining({ code: "INVALID_PHASE" }),
    )
    expect(() => validateCleanupReason("completed", "completed")).not.toThrow()
  })

  it("rejects empty or non-falsifiable hypotheses", () => {
    const initial = initialInvestigationState("2026-07-15T00:00:00.000Z")
    expect(
      InvestigationStateSchema.safeParse({
        ...initial,
        hypotheses: [
          {
            id: "hyp_empty",
            rank: 1,
            statement: "",
            confirmationSignals: [],
            eliminationSignals: [],
            status: "open",
            evidenceRefs: [],
          },
        ],
      }).success,
    ).toBe(false)
  })

  it("allows waiting only after every active probe is validated and a browser probe is ready", async () => {
    const session = waitingSession([
      probe(),
      probe({
        id: "probe_process",
        hypothesisId: "hyp_timeout",
        transport: "process",
        status: "validated",
        validationStatus: "validated",
      }),
      probe({ id: "probe_removed", status: "removed", validationStatus: "pending" }),
    ])

    await expect(validateCheckpointTransition(session, waitingState())).resolves.toBeUndefined()
  })

  it("rejects waiting while any non-removed run probe is still pending", async () => {
    const session = waitingSession([
      probe(),
      probe({ id: "probe_abandoned", hypothesisId: "hyp_timeout", status: "planned", validationStatus: "pending" }),
    ])

    await expect(validateCheckpointTransition(session, waitingState())).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
  })

  it("rejects waiting when the run has only validated process probes", async () => {
    const session = waitingSession([probe({ transport: "process" })])

    await expect(validateCheckpointTransition(session, waitingState())).rejects.toMatchObject({
      code: "INVALID_PHASE",
      action: expect.stringContaining("process probe in a test file cannot satisfy"),
    })
  })

  it("does not allow a waiting reproduction to checkpoint back around its Question", async () => {
    const session = waitingSession([probe()])
    session.investigationStore.read = async () => waitingState()

    await expect(
      validateCheckpointTransition(session, { ...waitingState(), phase: "instrumenting" }),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      message: "The prepared human reproduction checkpoint cannot be bypassed",
      action: expect.stringContaining("finish the waiting pre-fix run"),
    })
  })
})
