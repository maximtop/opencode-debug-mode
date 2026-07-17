import { writeFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { PROCESS_EVENT_PREFIX } from "../../src/core/constants.js"
import { EvidenceStore } from "../../src/evidence/store.js"
import { createProcessServiceFixture } from "../helpers/factories.js"

describe("process capture service", () => {
  it("reports stdout, stderr, timing, exit, run, and probe evidence", async () => {
    const fixture = await createProcessServiceFixture()
    const result = await fixture.service.capture({
      runId: fixture.runId,
      executable: process.execPath,
      args: [fixture.script("emit-output-and-probe.mjs")],
      cwd: fixture.projectRoot,
      env: {},
      timeoutMs: 5_000,
      probeIds: ["probe_A"],
      outcomePredicate: { kind: "exit-code", operator: "not-equals", value: 0 },
    })
    expect(result).toMatchObject({
      exitCode: 7,
      timedOut: false,
      runId: fixture.runId,
      probeIds: ["probe_A"],
      matchingProbeEvents: 1,
      issueReproduced: true,
      outcomePredicate: { kind: "exit-code", operator: "not-equals", value: 0 },
    })
    expect(result.stdoutEvents).toBeGreaterThan(0)
    expect(result.stderrEvents).toBeGreaterThan(0)
    expect(result.probeEvents).toBe(1)
    expect(result.resultEvidenceId).toMatch(/^event_/u)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    const owned = (await fixture.session.manifestStore.read()).processes.find(
      (candidate) => candidate.id === result.processId,
    )
    expect(owned).toMatchObject({ status: "exited", exitCode: 7 })
    expect(owned?.targetPid).toBeTypeOf("number")
    const resultEvent = (
      await new EvidenceStore(fixture.session.paths.evidenceFile).read({ eventIds: [result.resultEvidenceId] })
    ).events[0]
    expect(resultEvent?.data).toMatchObject({
      exitCode: 7,
      timedOut: false,
      probeIds: ["probe_A"],
      probeEvents: 1,
      matchingProbeEvents: 1,
      matchingProbeEventIds: [expect.stringMatching(/^event_/u)],
      issueReproduced: true,
      outcomePredicate: { kind: "exit-code", operator: "not-equals", value: 0 },
    })
  })

  it("bounds long output, ignores malformed probe candidates, and reports timeouts", async () => {
    const fixture = await createProcessServiceFixture()
    const noisy = fixture.script("noisy.mjs")
    await writeFile(
      noisy,
      `console.log("")\nconsole.log("x".repeat(9000))\nconsole.error(${JSON.stringify(
        `${PROCESS_EVENT_PREFIX}{broken}`,
      )})\nconsole.error(${JSON.stringify(`${PROCESS_EVENT_PREFIX}${JSON.stringify({ nope: true })}`)})\n`,
    )
    const bounded = await fixture.service.capture({
      runId: fixture.runId,
      executable: process.execPath,
      args: [noisy],
      cwd: fixture.projectRoot,
      env: {},
      timeoutMs: 5_000,
    })
    expect(bounded.stdoutEvents).toBe(1)
    expect(bounded.stderrEvents).toBe(1)
    expect(bounded.probeEvents).toBe(0)

    const hanging = fixture.script("hanging.mjs")
    await writeFile(hanging, "setInterval(() => {}, 1000)\n")
    const timed = await fixture.service.capture({
      runId: fixture.runId,
      executable: process.execPath,
      args: [hanging],
      cwd: fixture.projectRoot,
      env: {},
      timeoutMs: 50,
    })
    expect(timed).toMatchObject({ timedOut: true, signal: "SIGTERM" })
  })

  it("does not reuse a selected probe event from an earlier capture in the same run", async () => {
    const fixture = await createProcessServiceFixture()
    const capture = {
      runId: fixture.runId,
      executable: process.execPath,
      cwd: fixture.projectRoot,
      env: {},
      timeoutMs: 5_000,
      probeIds: ["probe_A"],
      outcomePredicate: { kind: "exit-code" as const, operator: "not-equals" as const, value: 0 },
    }
    const crossed = await fixture.service.capture({
      ...capture,
      args: [fixture.script("emit-output-and-probe.mjs")],
    })
    expect(crossed).toMatchObject({ probeEvents: 1, matchingProbeEvents: 1 })

    const unrelatedFailure = fixture.script("unrelated-failure.mjs")
    await writeFile(unrelatedFailure, "process.exitCode = 7\n")
    const missed = await fixture.service.capture({ ...capture, args: [unrelatedFailure] })

    expect(missed).toMatchObject({ probeEvents: 0, matchingProbeEvents: 0 })
    const resultEvent = (
      await new EvidenceStore(fixture.session.paths.evidenceFile).read({ eventIds: [missed.resultEvidenceId] })
    ).events[0]
    expect(resultEvent?.data).toMatchObject({
      probeIds: ["probe_A"],
      probeEvents: 0,
      matchingProbeEvents: 0,
      matchingProbeEventIds: [],
      issueReproduced: true,
    })
  })

  it("rejects an unknown run before starting a supervisor", async () => {
    const fixture = await createProcessServiceFixture()
    await expect(
      fixture.service.capture({
        runId: "run_missing",
        executable: process.execPath,
        args: ["--version"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" })
  })

  it("forks the supervisor with an explicit Node runtime and no inherited exec arguments", async () => {
    const forkSupervisor = vi.fn(() => {
      throw new Error("stop after capturing options")
    })
    const nodeExecutable = "/trusted/runtime/node"
    const fixture = await createProcessServiceFixture({
      nodeExecutable,
      forkSupervisor: forkSupervisor as unknown as typeof import("node:child_process").fork,
    })

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable: process.execPath,
        args: ["--version"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "PROCESS_START_FAILED" })
    expect(forkSupervisor).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ execPath: nodeExecutable, execArgv: [] }),
    )
  })
})
