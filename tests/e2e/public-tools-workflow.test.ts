import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { createDebugModePlugin } from "../../src/plugin.js"
import { pluginHarness } from "../helpers/factories.js"

function parse(value: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: tool envelopes vary by tool and are asserted at their use sites.
  return JSON.parse(value as string) as { ok: boolean; data: Record<string, any>; error?: { code: string } }
}

describe("public tool workflow", () => {
  it("executes every public tool through one owned session", async () => {
    const tempBase = await mkdtemp(path.join(tmpdir(), "opencode-debug-public-tools-"))
    onTestFinished(() => rm(tempBase, { recursive: true, force: true }))
    const harness = await pluginHarness(createDebugModePlugin({ tempBase }))
    const started = parse(await harness.executeTool("debug_session_start", { keepArtifacts: false }))
    expect(started.ok).toBe(true)
    expect(parse(await harness.executeTool("debug_session_status", {})).data.collector).toBeNull()

    const initial = parse(await harness.executeTool("debug_state_read", {}))
    const state = initial.data.state
    const checkpointed = parse(
      await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: state.revision,
        state: {
          ...state,
          problemSummary: "Observe a runtime value",
          expectedBehavior: "value is 42",
          actualBehavior: "unknown",
          runtimeContext: { kind: "cli", target: "workflow.mjs" },
          reproduction: { method: "node workflow.mjs", requiresUser: false, confirmed: null },
          successCriteria: ["captured value is 42"],
          phase: "hypotheses",
          hypotheses: [
            {
              id: "hyp_value",
              rank: 1,
              statement: "The runtime value is 42",
              confirmationSignals: ["probe reports 42"],
              eliminationSignals: ["probe reports another value"],
              status: "open",
              evidenceRefs: [],
            },
          ],
          nextAction: "capture the value",
        },
      }),
    )
    expect(checkpointed.data.revision).toBe(1)

    const run = parse(
      await harness.executeTool("debug_run_start", {
        label: "pre-fix",
        reproduction: "node workflow.mjs",
        waitingForUser: false,
      }),
    )
    const sourcePath = path.join(harness.projectRoot, "workflow.mjs")
    await writeFile(sourcePath, "const observed = 42\n")
    const prepared = parse(
      await harness.executeTool("debug_probe_prepare", {
        runId: run.data.runId,
        hypothesisId: "hyp_value",
        sourceFile: "workflow.mjs",
        sourceLine: 2,
        sourceColumn: 1,
        message: "observed value",
        captures: [{ label: "observed", path: "observed" }],
        transport: "process",
        sampling: { mode: "every", n: 2 },
      }),
    )
    await writeFile(sourcePath, `const observed = 42\n${prepared.data.markerBlock}\n`)
    expect(parse(await harness.executeTool("debug_probe_register", { probeId: prepared.data.probeId })).ok).toBe(true)

    const check = parse(
      await harness.executeTool("debug_process_capture", {
        approvalClass: "local-deterministic",
        purpose: "instrumentation-check",
        probeIds: [prepared.data.probeId],
        executable: process.execPath,
        args: ["--check", sourcePath],
        cwd: harness.projectRoot,
        env: {},
        runId: run.data.runId,
        timeoutMs: 5_000,
      }),
    )
    expect(check.data.exitCode).toBe(0)

    const captured = parse(
      await harness.executeTool("debug_process_capture", {
        approvalClass: "local-deterministic",
        purpose: "reproduction",
        probeIds: [prepared.data.probeId],
        executable: process.execPath,
        args: [sourcePath],
        cwd: harness.projectRoot,
        env: {},
        runId: run.data.runId,
        timeoutMs: 5_000,
      }),
    )
    expect(captured.data.probeEvents).toBe(1)

    const evidence = parse(
      await harness.executeTool("debug_evidence_read", { runId: run.data.runId, keyword: "observed", limit: 20 }),
    )
    expect(evidence.data.events[0].data).toEqual({ observed: 42 })
    const firstEvent = evidence.data.events[0]
    expect(
      parse(
        await harness.executeTool("debug_evidence_read", {
          hypothesisId: firstEvent.hypothesisId,
          probeId: firstEvent.probeId,
          from: firstEvent.timestamp,
          to: firstEvent.timestamp,
          cursor: "0",
          limit: 20,
        }),
      ).data.events,
    ).toHaveLength(1)
    const collector = parse(
      await harness.executeTool("debug_collector_start", {
        runtime: "web",
        transportTargetPath: "debug-transport.mjs",
      }),
    )
    expect(collector.ok).toBe(true)
    expect(parse(await harness.executeTool("debug_session_status", {})).data.collector.status).toBe("ready")

    const collectorEvent = {
      schemaVersion: 1,
      sessionId: started.data.sessionId,
      runId: run.data.runId,
      runLabel: "pre-fix",
      hypothesisId: "hyp_value",
      probeId: prepared.data.probeId,
      timestamp: new Date().toISOString(),
      message: "sampled observed value",
      source: { file: "workflow.mjs", line: 2 },
      data: { observed: 42 },
    }
    const helperText = await readFile(path.join(harness.projectRoot, collector.data.helperPath), "utf8")
    const authorizationLiteral = /const authorization = ("[^"]+")/u.exec(helperText)?.[1]
    expect(authorizationLiteral).toBeDefined()
    const host = collector.data.host === "::1" ? "[::1]" : collector.data.host
    const response = await fetch(`http://${host}:${collector.data.port}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: JSON.parse(authorizationLiteral as string),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: [collectorEvent, { ...collectorEvent, timestamp: new Date().toISOString() }] }),
    })
    expect(response.status).toBe(202)
    let sampledEvidence = evidence
    for (let attempt = 0; attempt < 50; attempt += 1) {
      sampledEvidence = parse(await harness.executeTool("debug_evidence_read", { limit: 20 }))
      if (!sampledEvidence.ok) throw new Error(JSON.stringify(sampledEvidence.error))
      if (
        sampledEvidence.data.counters.sampled === 1 &&
        sampledEvidence.data.events.some((event: { message: string }) => event.message === "sampled observed value")
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(sampledEvidence.data.counters.sampled).toBe(1)
    expect(
      sampledEvidence.data.events.some((event: { message: string }) => event.message === "sampled observed value"),
    ).toBe(true)

    const cleaned = parse(
      await harness.executeTool("debug_cleanup", {
        reason: "completed",
        finalReport: {
          outcome: "completed",
          rootCause: "The observed value is available at runtime",
          decidingEvidence: [evidence.data.events[0].eventId],
          hypotheses: [{ id: "hyp_value", status: "confirmed", statement: "The runtime value is 42" }],
          fix: "No behavioral change required",
          changedFiles: [],
          verification: ["probe reported 42"],
        },
      }),
    )
    expect(cleaned.data.status).toBe("complete")
    expect(await readFile(sourcePath, "utf8")).toBe("const observed = 42\n\n")
  })
})
