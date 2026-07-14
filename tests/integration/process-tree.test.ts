import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { terminateTree } from "../../src/process/tree.js"

describe("process tree termination integration", () => {
  it.skipIf(process.platform === "win32")("terminates a detached process group", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    })
    expect(child.pid).toBeTypeOf("number")
    const result = await terminateTree(child.pid as number, { gracefulMs: 200, forceMs: 500 })
    expect(result.remaining).toBe(false)
  })

  it.skipIf(process.platform === "win32")("forces a detached group that ignores graceful termination", async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    )
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once("data", () => resolve())
      child.once("error", reject)
    })
    const result = await terminateTree(child.pid as number, { gracefulMs: 50, forceMs: 500 })
    expect(result).toMatchObject({ graceful: true, forced: true, remaining: false })
  })
})
