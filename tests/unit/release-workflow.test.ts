import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

function getJob(workflow: string, name: string): string {
  const marker = `  ${name}:\n`
  const start = workflow.indexOf(marker)
  expect(start, `missing ${name} job`).toBeGreaterThanOrEqual(0)

  const bodyStart = start + marker.length
  const remainder = workflow.slice(bodyStart)
  const nextJob = remainder.search(/^ {2}[a-z][\w-]*:\n/m)
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob)
}

describe("release workflow", () => {
  it("runs one ordered release pipeline for version tags", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8")
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"))
    const jobNames = [...jobs.matchAll(/^ {2}([a-z][\w-]*):\n/gm)].map((match) => match[1])

    expect(workflow).toMatch(/^ {2}push:\n {4}tags: \["v\*"\]$/m)
    expect(workflow).not.toMatch(/^ {2}release:\s*$/m)
    expect(workflow).toContain(`group: release-\${{ github.ref_name }}`)
    expect(workflow).toContain("cancel-in-progress: false")
    expect(jobNames).toEqual(["prepare", "create-github-release", "publish-npm"])
    expect(getJob(workflow, "create-github-release")).toContain("needs: prepare")
    expect(getJob(workflow, "publish-npm")).toContain("needs: [prepare, create-github-release]")
  })

  it("prepares and uploads exactly one verified package", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8")
    const prepare = getJob(workflow, "prepare")

    expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(1)
    expect(workflow.match(/actions\/setup-node@v7/g)).toHaveLength(2)
    expect(workflow.match(/actions\/upload-artifact@v7/g)).toHaveLength(1)
    expect(workflow.match(/actions\/download-artifact@v8/g)).toHaveLength(2)
    expect(workflow.match(/node-version: 24/g)).toHaveLength(2)
    expect(workflow.match(/package-manager-cache: false/g)).toHaveLength(2)
    expect(workflow.match(/^\s+npm pack --json /gm)).toHaveLength(1)
    expect(prepare).toContain("fetch-depth: 0")
    expect(prepare).toContain("refs/remotes/origin/master")
    expect(prepare).toContain(`\${GITHUB_REF}^{commit}`)
    expect(prepare).toContain("npm ci")
    expect(prepare).toContain("npm run check")
    expect(prepare).toContain("npm run test:e2e")
    expect(prepare).toContain("integrity")
    expect(prepare).toContain("sha256")
    expect(prepare).toContain("overwrite: true")
    expect(prepare.indexOf("Verify the tagged commit belongs to master")).toBeLessThan(
      prepare.indexOf("node scripts/release-metadata.ts"),
    )
  })

  it("uses minimal permissions and verifies reruns before mutating registries", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8")
    const createRelease = getJob(workflow, "create-github-release")
    const publish = getJob(workflow, "publish-npm")

    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(createRelease).toMatch(/permissions:\n {6}contents: write/)
    expect(createRelease).not.toContain("id-token")
    expect(createRelease).toContain("gh release create")
    expect(createRelease).toContain("--generate-notes")
    expect(createRelease).toContain("--prerelease")
    expect(createRelease).toContain("gh release download")
    expect(createRelease).toContain("cmp")

    expect(publish).toContain("environment: npm")
    expect(publish).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write/)
    expect(publish).not.toContain("contents: write")
    expect(publish).toContain("npm view")
    expect(publish).toContain("dist.integrity")
    expect(publish).toContain("E404")
    expect(publish).toContain(`NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`)
    expect(publish).toContain('npm publish "release/$TARBALL" --access public --tag "$NPM_TAG" --provenance')
    expect(publish).not.toContain("npm pack")
    expect(publish).not.toContain("npm run build")
    expect(publish).not.toContain("npm ci")
  })
})
