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

  it("uses Node.js 24 actions without dropping the Node.js 20/22 matrix", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8")
    expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(3)
    expect(workflow.match(/actions\/setup-node@v7/g)).toHaveLength(3)
    expect(workflow).toContain("node: [20, 22]")
    expect(workflow).toContain(`node-version: \${{ matrix.node }}`)
  })
})
