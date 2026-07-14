import { describe, expect, it } from "vitest"
import { createProcessServiceFixture } from "../helpers/factories.js"

describe("process capture integration", () => {
  it("captures a real nonzero process without buffering full output", async () => {
    const fixture = await createProcessServiceFixture()
    const result = await fixture.service.capture({
      runId: fixture.runId,
      executable: process.execPath,
      args: [fixture.script("emit-output-and-probe.mjs")],
      cwd: fixture.projectRoot,
      env: {},
      timeoutMs: 5_000,
    })
    expect(result.exitCode).toBe(7)
    expect(result.probeEvents).toBe(1)
  })
})
