import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { createDebugModePlugin } from "../../src/plugin.js"
import { pluginHarness } from "../helpers/factories.js"

function parse(value: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: error-matrix envelopes vary by tool and are asserted at their use sites.
  return JSON.parse(value as string) as { ok: boolean; data?: Record<string, any>; error?: { code: string } }
}

const report = {
  outcome: "abandoned",
  rootCause: "not active",
  decidingEvidence: [],
  hypotheses: [],
  fix: "none",
  changedFiles: [],
  verification: [],
}

describe("public tool errors", () => {
  it("returns ownership-safe errors for every session-bound tool", async () => {
    const tempBase = await mkdtemp(path.join(tmpdir(), "opencode-debug-tool-errors-"))
    onTestFinished(() => rm(tempBase, { recursive: true, force: true }))
    const harness = await pluginHarness(createDebugModePlugin({ tempBase }))
    const calls: Array<[string, Record<string, unknown>]> = [
      ["debug_session_status", {}],
      ["debug_state_read", {}],
      ["debug_state_checkpoint", { expectedRevision: 0, state: {} }],
      ["debug_run_start", { label: "pre-fix", reproduction: "fixture", waitingForUser: false }],
      [
        "debug_run_finish",
        {
          runId: "run_missing",
          status: "cancelled",
          issueReproduced: null,
          observationSource: "deterministic",
          observation: "not active",
        },
      ],
      [
        "debug_process_capture",
        {
          approvalClass: "local-deterministic",
          purpose: "reproduction",
          probeIds: [],
          executable: process.execPath,
          args: ["--version"],
          cwd: harness.projectRoot,
          env: {},
          runId: "run_missing",
          timeoutMs: 100,
        },
      ],
      ["debug_collector_start", { runtime: "web", transportTargetPath: "debug-transport.mjs" }],
      [
        "debug_probe_prepare",
        {
          runId: "run_missing",
          hypothesisId: "hyp_missing",
          sourceFile: "missing.js",
          sourceLine: 1,
          message: "fixture",
          captures: [],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        },
      ],
      ["debug_probe_register", { probeId: "probe_missing" }],
      ["debug_probe_remove", { probeId: "probe_missing" }],
      ["debug_evidence_read", { limit: 10 }],
      ["debug_cleanup", { reason: "abandoned", finalReport: report }],
    ]

    for (const [name, args] of calls) {
      expect(parse(await harness.executeTool(name, args)).error?.code, name).toBe("NO_ACTIVE_SESSION")
    }
  })

  it("surfaces duplicate, stale, unsafe, approval, and collector errors", async () => {
    const tempBase = await mkdtemp(path.join(tmpdir(), "opencode-debug-tool-active-errors-"))
    onTestFinished(() => rm(tempBase, { recursive: true, force: true }))
    const harness = await pluginHarness(createDebugModePlugin({ tempBase }), { activeSessions: ["session-A"] })
    expect(parse(await harness.executeTool("debug_session_start", { keepArtifacts: false })).error?.code).toBe(
      "SESSION_EXISTS",
    )
    const state = parse(await harness.executeTool("debug_state_read", {})).data?.state
    const activeState = {
      ...state,
      phase: "hypotheses",
      reproduction: { method: "fixture", requiresUser: false, confirmed: null },
      hypotheses: [
        {
          id: "hyp_active",
          rank: 1,
          statement: "fixture",
          confirmationSignals: ["yes"],
          eliminationSignals: ["no"],
          status: "open",
          evidenceRefs: [],
        },
        {
          id: "hyp_secondary",
          rank: 2,
          statement: "secondary fixture",
          confirmationSignals: ["secondary yes"],
          eliminationSignals: ["secondary no"],
          status: "open",
          evidenceRefs: [],
        },
      ],
    }
    expect(
      parse(await harness.executeTool("debug_state_checkpoint", { expectedRevision: 0, state: activeState })).ok,
    ).toBe(true)
    await harness.selectAgent("debug")
    await harness.completeText(
      "## Working hypotheses\n1. hyp_active — fixture; confirm: yes; eliminate: no.\n2. hyp_secondary — secondary fixture; confirm: secondary yes; eliminate: secondary no.",
    )
    expect(
      parse(await harness.executeTool("debug_state_checkpoint", { expectedRevision: 99, state })).error?.code,
    ).toBe("STALE_REVISION")
    const run = parse(
      await harness.executeTool("debug_run_start", {
        label: "pre-fix",
        reproduction: "agent-paraphrased fixture",
        waitingForUser: true,
      }),
    )
    expect(run).toMatchObject({
      ok: true,
      data: { status: "running" },
      warnings: [{ code: "RUN_INPUT_CANONICALIZED" }],
    })
    const beforeInstrumentation = parse(await harness.executeTool("debug_state_read", {})).data?.state
    expect(
      parse(
        await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: beforeInstrumentation.revision,
          state: { ...beforeInstrumentation, phase: "instrumenting" },
        }),
      ).ok,
    ).toBe(true)
    expect(
      parse(
        await harness.executeTool("debug_probe_prepare", {
          runId: run.data?.runId,
          hypothesisId: "hyp_active",
          sourceFile: "../escape.js",
          sourceLine: 1,
          message: "fixture",
          captures: [],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        }),
      ).error?.code,
    ).toBe("HELPER_PATH_UNSAFE")
    expect(parse(await harness.executeTool("debug_probe_register", { probeId: "probe_missing" })).error?.code).toBe(
      "MARKER_MISSING",
    )
    expect(parse(await harness.executeTool("debug_probe_remove", { probeId: "probe_missing" })).error?.code).toBe(
      "MARKER_MISSING",
    )

    expect(parse(await harness.executeTool("debug_collector_start", { runtime: "web" })).error?.code).toBe(
      "HELPER_PATH_UNSAFE",
    )
    expect(
      parse(
        await harness.executeTool("debug_collector_start", {
          runtime: "web",
          transportTargetPath: "debug-transport.mjs",
        }),
      ).ok,
    ).toBe(true)
    expect(
      parse(
        await harness.executeTool("debug_collector_start", {
          runtime: "web",
          transportTargetPath: "another-debug-transport.mjs",
        }),
      ).error?.code,
    ).toBe("COLLECTOR_EXISTS")

    await writeFile(path.join(harness.projectRoot, "noop.mjs"), "void 0\n")
    const denied = parse(
      await harness.executeTool(
        "debug_process_capture",
        {
          approvalClass: "credentials",
          purpose: "instrumentation-check",
          probeIds: [],
          executable: process.execPath,
          args: ["noop.mjs"],
          cwd: harness.projectRoot,
          env: {},
          runId: run.data?.runId,
          timeoutMs: 1_000,
        },
        "session-A",
        { ask: vi.fn().mockRejectedValue(new Error("denied")) },
      ),
    )
    expect(denied.error?.code).toBe("INVALID_PHASE")
  })
})
