import { describe, expect, it } from "vitest"
import {
  absolutePathEntries,
  resolveExecutablePath,
  sanitizeExecutablePath,
} from "../../src/process/executable-resolver.js"

describe("executable resolver", () => {
  it("ignores empty and relative PATH entries and resolves an absolute candidate", () => {
    const inspected: string[] = []
    const resolved = resolveExecutablePath("tool", {
      pathValue: ":relative:/opt/tools/bin:/opt/tools/bin",
      platform: "linux",
      fallbackDirectories: [],
      validateCandidate: (candidate) => {
        inspected.push(candidate)
        return candidate === "/opt/tools/bin/tool" ? "/canonical/tool" : undefined
      },
    })

    expect(resolved).toBe("/canonical/tool")
    expect(inspected).toEqual(["/opt/tools/bin/tool"])
    expect(absolutePathEntries(":relative:/usr/bin:/usr/bin:/bin", "linux")).toEqual(["/usr/bin", "/bin"])
    expect(sanitizeExecutablePath(":relative:/usr/bin:/usr/bin:/bin", "linux")).toBe("/usr/bin:/bin")
  })

  it("resolves Windows executable suffixes only from accepted absolute directories", () => {
    const inspected: string[] = []
    const resolved = resolveExecutablePath("git", {
      pathValue: "relative;C:\\project\\bin;C:\\Program Files\\Git\\cmd",
      platform: "win32",
      fallbackDirectories: [],
      allowDirectory: (directory) => directory.toLowerCase().endsWith("\\program files\\git\\cmd"),
      validateCandidate: (candidate) => {
        inspected.push(candidate)
        return candidate.toLowerCase().endsWith("\\git\\cmd\\git.exe") ? "C:\\Git\\git.exe" : undefined
      },
    })

    expect(resolved).toBe("C:\\Git\\git.exe")
    expect(inspected).toEqual(["C:\\Program Files\\Git\\cmd\\git.exe"])
  })

  it("returns undefined when every absolute candidate is rejected", () => {
    expect(
      resolveExecutablePath("git", {
        pathValue: "/project/bin:/usr/bin",
        platform: "linux",
        fallbackDirectories: [],
        allowDirectory: (directory) => directory === "/usr/bin",
        validateCandidate: () => undefined,
      }),
    ).toBeUndefined()
  })
})
