import { describe, expect, it, vi } from "vitest"
import { EVENT_SCHEMA_VERSION } from "../../src/core/constants.js"
import type { EvidenceStore } from "../../src/evidence/store.js"
import { initialInvestigationState } from "../../src/investigation/store.js"
import { createInitialManifest } from "../../src/session/manifest-store.js"
import type { DebugSession, SessionRegistry } from "../../src/session/registry.js"
import type { ManifestRun } from "../../src/session/types.js"
import { createRunFinishTool } from "../../src/tools/run-tools.js"
import { toolContextFixture } from "../helpers/factories.js"

const timestamp = "2026-07-16T00:00:00.000Z"
const predicate = { kind: "exit-code" as const, operator: "not-equals" as const, value: 0 }

function fixture(matchingProbe: boolean) {
  const run: ManifestRun = {
    id: "run_pre",
    label: "pre-fix",
    reproduction: "exercise the instrumented runtime path",
    outcomePredicate: predicate,
    status: "running",
    createdAt: timestamp,
  }
  const state = {
    ...initialInvestigationState(timestamp),
    phase: "baseline" as const,
    reproduction: { method: run.reproduction, requiresUser: false, confirmed: null },
    hypotheses: [
      {
        id: "hyp_runtime",
        rank: 1,
        statement: "the runtime boundary fails",
        confirmationSignals: ["the probe emits before failure"],
        eliminationSignals: ["the probe emits after success"],
        status: "open" as const,
        evidenceRefs: [],
      },
      {
        id: "hyp_setup",
        rank: 2,
        statement: "test setup fails first",
        confirmationSignals: ["the probe never emits"],
        eliminationSignals: ["the probe emits"],
        status: "open" as const,
        evidenceRefs: [],
      },
    ],
  }
  const manifest = {
    ...createInitialManifest({
      sessionId: "session_fixture",
      trustedSessionHash: "a".repeat(64),
      projectRoot: "/project",
      sessionDir: "/session",
      now: timestamp,
    }),
    runs: [run],
    probes: [
      {
        id: "probe_runtime",
        runId: run.id,
        hypothesisId: "hyp_runtime",
        sourceFile: "/project/src/runtime.ts",
        sourceLine: 1,
        message: "runtime boundary",
        transport: "process" as const,
        captures: [],
        sampling: { mode: "every" as const, n: 1 },
        status: "validated" as const,
        validationStatus: "validated" as const,
        markerStart: "/* start */",
        markerEnd: "/* end */",
      },
    ],
  }
  const probeEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: "event_probe",
    receivedAt: timestamp,
    timestamp,
    sessionId: manifest.sessionId,
    runId: run.id,
    runLabel: run.label,
    hypothesisId: "hyp_runtime",
    probeId: "probe_runtime",
    kind: "probe",
    message: "runtime boundary",
    data: { reached: true },
    source: { file: "src/runtime.ts", line: 1 },
    sanitization: { flags: [], droppedKeys: 0, storedBytes: 16 },
  }
  const processResult = {
    ...probeEvent,
    eventId: "event_process",
    hypothesisId: "hyp_process",
    probeId: "probe_process",
    kind: "process.result",
    message: "reproduction process completed",
    data: {
      purpose: "reproduction",
      probeIds: ["probe_runtime"],
      probeEvents: matchingProbe ? 1 : 0,
      matchingProbeEvents: matchingProbe ? 1 : 0,
      matchingProbeEventIds: matchingProbe ? [probeEvent.eventId] : [],
      outcomePredicate: predicate,
      exitCode: 1,
      timedOut: false,
      issueReproduced: true,
    },
  }
  const append = vi.fn().mockResolvedValue({ status: "accepted", event: { eventId: "event_observation" } })
  const evidence = {
    read: vi.fn().mockResolvedValue({
      events: [matchingProbe ? probeEvent : { ...probeEvent, eventId: "event_from_earlier_capture" }, processResult],
      nextCursor: null,
    }),
    append,
  } as unknown as EvidenceStore
  const session = {
    publicId: manifest.sessionId,
    investigationStore: { read: vi.fn().mockResolvedValue(state) },
    manifestStore: { read: vi.fn().mockResolvedValue(manifest) },
  } as unknown as DebugSession
  const complete = vi.fn().mockResolvedValue({ ...run, status: "completed", issueReproduced: true })
  const runs = { require: vi.fn().mockResolvedValue(run), complete }
  const registry = { requireOwned: vi.fn().mockResolvedValue(session), touch: vi.fn() } as unknown as SessionRegistry
  const tool = createRunFinishTool(
    registry,
    () => runs as never,
    () => evidence,
  )
  return { tool, append, complete }
}

describe("debug_run_finish runtime evidence gate", () => {
  it("rejects an unrelated failing exit when the selected runtime probe emitted nothing", async () => {
    const { tool, append, complete } = fixture(false)

    const result = JSON.parse(
      (await tool.execute(
        {
          runId: "run_pre",
          status: "completed",
          issueReproduced: true,
          observationSource: "deterministic",
          observation: "The unrelated test setup failed before the instrumented path ran",
        },
        toolContextFixture(),
      )) as string,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_PHASE",
        action: expect.stringContaining("prepared human reproduction Question"),
      },
    })
    expect(append).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it("accepts the same deterministic outcome when a selected active validated probe emitted", async () => {
    const { tool, append, complete } = fixture(true)

    const result = JSON.parse(
      (await tool.execute(
        {
          runId: "run_pre",
          status: "completed",
          issueReproduced: true,
          observationSource: "deterministic",
          observation: "The selected runtime boundary emitted before the failing exit",
        },
        toolContextFixture(),
      )) as string,
    )

    expect(result).toMatchObject({ ok: true, data: { issueReproduced: true } })
    expect(append).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledOnce()
  })
})
