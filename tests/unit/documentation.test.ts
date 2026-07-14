import { access, readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("open-source documentation", () => {
  it.each([
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/lifecycle.md",
    "ATTRIBUTION.md",
    "LICENSE",
  ])("includes %s", async (file) => expect(access(file)).resolves.toBeUndefined())

  it("documents v1 boundaries and private defaults", async () => {
    const readme = await readFile("README.md", "utf8")
    expect(readme).toContain("OpenCode 1.17")
    expect(readme).toContain("Node.js 20")
    expect(readme).toContain("keepArtifacts=false")
    expect(readme).toContain("JavaScript and TypeScript")
    expect(readme).not.toMatch(/Python probes are supported|Go probes are supported/)
  })

  it("documents npm installation and the exact maintainer release procedure", async () => {
    const readme = await readFile("README.md", "utf8")
    const contributing = await readFile("CONTRIBUTING.md", "utf8")

    expect(readme).toContain("npm install @maximtop/opencode-debug-mode")
    expect(readme).toContain('"plugin": ["@maximtop/opencode-debug-mode"]')
    expect(contributing).toContain("npm version patch --no-git-tag-version")
    expect(contributing).toContain('git tag -a vX.Y.Z -m "vX.Y.Z"')
    expect(contributing).toContain("git push origin vX.Y.Z")
    expect(contributing).toContain("`latest`")
    expect(contributing).toContain("`beta`")
    expect(contributing).toContain("`next`")
    expect(contributing).toContain("Trusted Publisher")
    expect(contributing).toContain("NPM_TOKEN")
  })

  it("uses Node.js 24 actions without a redundant Node.js version matrix", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8")
    expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(3)
    expect(workflow.match(/actions\/setup-node@v7/g)).toHaveLength(3)
    expect(workflow.match(/node-version: 24/g)).toHaveLength(3)
    expect(workflow).not.toContain("node: [20, 22]")
    expect(workflow).not.toContain("matrix.node")
    expect(workflow).toMatch(/^ {2}push:\n {4}branches: \["\*\*"\]$/m)
  })
})
