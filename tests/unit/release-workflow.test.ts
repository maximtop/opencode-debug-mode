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
    expect(workflow).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:$/m)
    expect(workflow).toMatch(/ {6}tag:\n {8}description: .+\n {8}required: true\n {8}type: string/)
    expect(workflow).not.toMatch(/^ {2}release:\s*$/m)
    expect(workflow).toContain(`group: release-\${{ inputs.tag || github.ref_name }}`)
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
    expect(prepare).toContain(`ref: refs/tags/\${{ inputs.tag || github.ref_name }}`)
    expect(prepare).toContain("refs/remotes/origin/master")
    expect(prepare).toContain(`TAG: \${{ inputs.tag || github.ref_name }}`)
    expect(prepare).toContain(`git rev-parse --verify "refs/tags/\${TAG}^{commit}"`)
    expect(prepare).toContain('[[ "$checked_out_commit" != "$tagged_commit" ]]')
    expect(prepare).not.toContain("GITHUB_REF")
    expect(prepare).toContain(`steps.pack.outputs.tarball || steps.recover.outputs.tarball`)
    expect(prepare).toContain("Recover prepared package from existing GitHub Release")
    expect(prepare).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(prepare).toContain("gh release download")
    expect(prepare).toContain("package/package.json")
    expect(prepare).toContain("Existing GitHub Release must contain exactly one tarball and checksum")
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
    expect(createRelease).toContain(`RECOVERY: \${{ github.event_name == 'workflow_dispatch' }}`)
    expect(createRelease).toContain(`TAG: \${{ inputs.tag || github.ref_name }}`)
    expect(createRelease).toContain("Manual recovery requires an existing GitHub Release")
    expect(createRelease).toContain("Existing GitHub Release is missing required asset")

    expect(publish).toContain("environment: npm")
    expect(publish).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write/)
    expect(publish).not.toContain("contents: write")
    expect(publish).toContain("npm view")
    expect(publish).toContain("dist.integrity")
    expect(publish).toContain("E404")
    expect(publish).toContain(`TAG: \${{ inputs.tag || github.ref_name }}`)
    expect(publish).toContain(`NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`)
    expect(publish).toContain('npm publish "./release/$TARBALL" --access public --tag "$NPM_TAG" --provenance')
    expect(publish).not.toContain("npm pack")
    expect(publish).not.toContain("npm run build")
    expect(publish).not.toContain("npm ci")
  })
})
