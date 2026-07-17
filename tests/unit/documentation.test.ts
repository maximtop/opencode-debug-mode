import { access, readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("open-source documentation", () => {
  it.each([
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/lifecycle.md",
    "docs/behavioral-acceptance.md",
    "ATTRIBUTION.md",
    "LICENSE",
  ])("includes %s", async (file) => expect(access(file)).resolves.toBeUndefined())

  it("documents v1 boundaries and private defaults", async () => {
    const readme = await readFile("README.md", "utf8")
    expect(readme).toContain("OpenCode 1.17")
    expect(readme).toContain("Node.js 20")
    expect(readme).toContain("keepArtifacts=false")
    expect(readme).toContain("JavaScript and TypeScript")
    expect(readme).toContain("Safe local investigation and temporary instrumentation proceed autonomously")
    expect(readme).toContain("whether the issue reproduced")
    expect(readme).toContain("whether the same reproduction is now fixed")
    expect(readme).toContain("A provided browser, extension, device, or external-state procedure")
    expect(readme).toContain("`reproduction.requiresUser=true`")
    expect(readme).toContain("existing supervised command already reproduces the exact same runtime symptom")
    expect(readme).toContain("a local Node, fetch, mock, fixture, or test approximation is not equivalent")
    expect(readme).toContain("After the first baseline run starts, `true` can never become `false`")
    expect(readme).toContain("A mistaken `false` can become `true` only when every run is terminal")
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
    expect(contributing).toContain("Do not add `NODE_AUTH_TOKEN` or `NPM_TOKEN`")
    expect(contributing).toContain("disallows token-based publication")
    expect(contributing).toContain("gh workflow run release.yml --ref master -f tag=vX.Y.Z")
    expect(contributing).toContain("Keep the temporary `master` policy until the complete run succeeds")
  })

  it("documents the small autonomous behavioral release gate and large-repository smoke test", async () => {
    const acceptance = await readFile("docs/behavioral-acceptance.md", "utf8")
    const contributing = await readFile("CONTRIBUTING.md", "utf8")

    expect(acceptance).toContain("tokenguard/deepseek-v4-flash")
    expect(acceptance).toContain("two consecutive unchanged passes")
    expect(acceptance).toContain("fixtures/feature-flag-bug")
    expect(acceptance).toContain("registered process probes around the may-fail `readFile` boundary")
    expect(acceptance).toContain("`encodeURI` to `encodeURIComponent` correction")
    expect(acceptance).toContain("reach idle without asking a question")
    expect(acceptance).toContain("--profile ag-55256")
    expect(acceptance).toContain("not a model-facing gate")
    expect(contributing).toContain("tokenguard/deepseek-v4-flash")
    expect(contributing).toContain("two consecutive unchanged")
  })

  it("uses Node.js 24 actions without a redundant Node.js version matrix", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8")
    expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(1)
    expect(workflow.match(/actions\/setup-node@v7/g)).toHaveLength(1)
    expect(workflow.match(/node-version: 24/g)).toHaveLength(1)
    expect(workflow).not.toContain("node: [20, 22]")
    expect(workflow).not.toContain("matrix.")
    expect(workflow).not.toContain("windows-latest")
    expect(workflow).not.toContain("macos-latest")
    expect(workflow).toContain("npm run test:integration")
    expect(workflow).not.toContain("opencode-compat")
    expect(workflow).toMatch(/^ {2}push:\n {4}branches: \["\*\*"\]$/m)
  })
})
