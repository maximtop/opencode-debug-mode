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

  it.skipIf(process.platform === "win32")(
    "uses the default shell-free Windows executor when none is injected",
    async () => {
      const result = await terminateTree(999_999_998, {
        platform: "win32",
        gracefulMs: 0,
        forceMs: 0,
      })

      expect(result).toMatchObject({ graceful: false, forced: false, remaining: false })
      expect(result.errors).toEqual(["ENOENT", "ENOENT"])
    },
  )

  it("normalizes untyped execution errors without exposing their messages", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("sensitive executor failure"))
    const result = await terminateTree(999_999_997, {
      platform: "win32",
      execute,
      gracefulMs: 0,
      forceMs: 0,
    })

    expect(result.errors).toEqual(["termination-failed", "termination-failed"])
  })

  it("returns immediately when a Unix process group is already absent", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" })
    })

    await expect(terminateTree(1234, { platform: "darwin" })).resolves.toMatchObject({
      graceful: false,
      forced: false,
      remaining: false,
      errors: [],
    })
    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM")
  })

  it("records non-ESRCH Unix termination failures", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true
      throw Object.assign(new Error("denied"), { code: signal === "SIGTERM" ? "EACCES" : "EPERM" })
    })

    await expect(terminateTree(1234, { platform: "linux", gracefulMs: 0, forceMs: 0 })).resolves.toMatchObject({
      graceful: false,
      forced: false,
      remaining: true,
      errors: ["EACCES", "EPERM"],
    })
    expect(kill).toHaveBeenCalledWith(-1234, "SIGKILL")
  })
})
