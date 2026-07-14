import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("package metadata", () => {
  it("publishes one ESM OpenCode plugin for Node 20+", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"))
    expect(pkg.name).toBe("opencode-debug-mode")
    expect(pkg.type).toBe("module")
    expect(pkg.engines.node).toBe(">=20")
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBe(">=1.17.0 <2")
    expect(pkg.exports["."].import).toBe("./dist/index.js")
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "assets", "README.md", "LICENSE"]))
  })
})
