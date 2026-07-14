import { describe, expect, it } from "vitest"
import { launchSupervisorHarness, waitForPidExit } from "../helpers/process-harness.js"

describe("process supervisor", () => {
  it("kills the target tree when its IPC parent disconnects", async () => {
    const harness = await launchSupervisorHarness({ fixture: "long-running-tree" })
    const targetPid = await harness.targetPid()
    harness.disconnect()
    await expect(waitForPidExit(targetPid, 3_000)).resolves.toBe(true)
    await expect(harness.exitCode()).resolves.toBe(0)
  })
})
