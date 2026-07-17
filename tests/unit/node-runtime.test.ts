import { realpathSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { resolveNodeRuntime, sanitizedSupervisorEnvironment } from "../../src/process/node-runtime.js"

describe("Node supervisor runtime", () => {
  it("uses the genuine current Node runtime", () => {
    expect(resolveNodeRuntime()).toBe(realpathSync(process.execPath))
  })

  it("never reuses a Bun/OpenCode executable and resolves absolute PATH candidates", () => {
    const inspected: string[] = []
    const resolved = resolveNodeRuntime({
      execPath: "/Applications/OpenCode/opencode",
      releaseName: "node",
      versions: { node: "24.0.0", bun: "1.2.0" },
      pathValue: "relative:/opt/toolchain/bin",
      platform: "darwin",
      fallbackDirectories: [],
      validateCandidate: (candidate) => {
        inspected.push(candidate)
        return candidate === "/opt/toolchain/bin/node" ? "/canonical/node" : undefined
      },
    })

    expect(resolved).toBe("/canonical/node")
    expect(inspected).toEqual(["/opt/toolchain/bin/node"])
    expect(inspected).not.toContain("/Applications/OpenCode/opencode")
  })

  it("uses node.exe from an absolute Windows PATH entry", () => {
    expect(
      resolveNodeRuntime({
        execPath: "C:\\OpenCode\\opencode.exe",
        releaseName: "node",
        versions: { node: "24.0.0", bun: "1.2.0" },
        pathValue: "relative;C:\\Program Files\\nodejs",
        platform: "win32",
        fallbackDirectories: [],
        validateCandidate: (candidate) => (candidate === "C:\\Program Files\\nodejs\\node.exe" ? candidate : undefined),
      }),
    ).toBe("C:\\Program Files\\nodejs\\node.exe")
  })

  it("fails safely when no compatible Node runtime is available", () => {
    expect(() =>
      resolveNodeRuntime({
        execPath: "/Applications/OpenCode/opencode",
        releaseName: "node",
        versions: { node: "24.0.0", bun: "1.2.0" },
        pathValue: "relative",
        platform: "darwin",
        fallbackDirectories: [],
        validateCandidate: () => undefined,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROCESS_START_FAILED", action: expect.any(String) }))
  })

  it("removes Node code-injection variables from the supervisor environment", () => {
    expect(
      sanitizedSupervisorEnvironment({
        PATH: "/usr/bin",
        HOME: "/home/fixture",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
        NODE_PATH: "/tmp/modules",
        NODE_V8_COVERAGE: "/tmp/coverage",
        LD_PRELOAD: "/tmp/inject.so",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        GIT_CONFIG_COUNT: "1",
        DATABASE_URL: "postgres://user:password@localhost/db",
        GH_TOKEN: "secret-token",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/fixture" })
  })
})
