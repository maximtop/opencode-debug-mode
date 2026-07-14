import { describe, expect, it, vi } from "vitest"
import { terminateTree } from "../../src/process/tree.js"

describe("process tree termination", () => {
  it("uses taskkill without a shell on Windows", async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0 })
    await terminateTree(1234, { platform: "win32", execute, gracefulMs: 10, forceMs: 10 })
    expect(execute).toHaveBeenNthCalledWith(1, "taskkill", ["/PID", "1234", "/T"])
    expect(execute).toHaveBeenNthCalledWith(2, "taskkill", ["/PID", "1234", "/T", "/F"])
  })

  it("rejects invalid PIDs and safely records Windows execution errors", async () => {
    expect(await terminateTree(0)).toMatchObject({ remaining: false, errors: ["invalid-pid"] })
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const execute = vi.fn().mockRejectedValue(missing)
    const result = await terminateTree(999_999_999, {
      platform: "win32",
      execute,
      gracefulMs: 0,
      forceMs: 0,
    })
    expect(result.errors).toEqual(["ENOENT", "ENOENT"])
  })
})
