import { afterEach, describe, expect, it, vi } from "vitest"

async function loadWith(readFile: ReturnType<typeof vi.fn>) {
  vi.resetModules()
  vi.doMock("node:fs/promises", () => ({ readFile }))
  const metadata = await import("../../src/core/package-metadata.js")
  return metadata.readPackageVersion()
}

afterEach(() => {
  vi.doUnmock("node:fs/promises")
  vi.resetModules()
})

describe("package metadata errors", () => {
  it("propagates a package metadata read error", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" })
    await expect(loadWith(vi.fn().mockRejectedValue(denied))).rejects.toBe(denied)
  })

  it("rejects missing package metadata", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    await expect(loadWith(vi.fn().mockRejectedValue(missing))).rejects.toThrow("unavailable")
  })

  it.each(["null", "{}", '{"version":""}', '{"version":1}'])("rejects invalid package metadata: %s", async (text) => {
    await expect(loadWith(vi.fn().mockResolvedValue(text))).rejects.toThrow(/version|metadata/iu)
  })
})
