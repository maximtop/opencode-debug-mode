import { writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { PROCESS_EVENT_PREFIX } from "../../src/core/constants.js"
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
    })
    expect(result).toMatchObject({ exitCode: 7, timedOut: false, runId: fixture.runId })
    expect(result.stdoutEvents).toBeGreaterThan(0)
    expect(result.stderrEvents).toBeGreaterThan(0)
    expect(result.probeEvents).toBe(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
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
})
