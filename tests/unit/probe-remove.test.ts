import { rm, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { removeOwnedProbe } from "../../src/probes/remove.js"
import { markerFileFixture } from "../helpers/factories.js"

describe("owned marker removal", () => {
  it("removes an exact block while preserving edits around it", async () => {
    const fixture = await markerFileFixture({ before: "const before = 2\n", after: "const after = 3\n" })
    const result = await removeOwnedProbe(fixture.manifestProbe)
    expect(result.status).toBe("success")
    expect(await fixture.read()).toBe("const before = 2\nconst after = 3\n")
  })

  it("preserves a changed owned block as ambiguous", async () => {
    const fixture = await markerFileFixture({ mutateInsideMarker: true })
    const result = await removeOwnedProbe(fixture.manifestProbe)
    expect(result.status).toBe("failed")
    expect(result.reason).toBe("marker-content-mismatch")
    expect(await fixture.read()).toContain("DEBUG-START")
  })

  it("fails closed for missing ownership, ambiguous markers, and missing files", async () => {
    const incomplete = await markerFileFixture({})
    expect(
      await removeOwnedProbe({ ...incomplete.manifestProbe, expectedBlock: undefined, expectedHash: undefined }),
    ).toMatchObject({ status: "failed", reason: "marker-ownership-incomplete" })

    const ambiguous = await markerFileFixture({})
    const original = await ambiguous.read()
    await writeFile(ambiguous.manifestProbe.sourceFile, original + original)
    expect(await removeOwnedProbe(ambiguous.manifestProbe)).toMatchObject({
      status: "failed",
      reason: "marker-ambiguous",
    })

    const missing = await markerFileFixture({})
    await rm(missing.manifestProbe.sourceFile)
    expect(await removeOwnedProbe(missing.manifestProbe)).toMatchObject({ status: "already-clean" })

    const alreadyClean = await markerFileFixture({})
    await writeFile(alreadyClean.manifestProbe.sourceFile, "const preserved = true\n")
    expect(await removeOwnedProbe(alreadyClean.manifestProbe)).toMatchObject({ status: "already-clean" })
  })
})
