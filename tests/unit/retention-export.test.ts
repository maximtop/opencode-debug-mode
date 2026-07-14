import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { finalizeRetainedBundle, stageRetainedBundle } from "../../src/cleanup/export.js"
import { retainedBundleFixture } from "../helpers/factories.js"

describe("retained bundle", () => {
  it("exports sanitized evidence/state/report without ownership secrets", async () => {
    const fixture = await retainedBundleFixture()
    const staged = await stageRetainedBundle(fixture.input)
    const result = await finalizeRetainedBundle(staged, fixture.cleanupResult)
    const names = await fixture.list(result.path)
    expect(names.sort()).toEqual(["bundle-manifest.json", "evidence.ndjson", "investigation-state.json", "report.md"])
    for (const name of names) {
      const text = await readFile(`${result.path}/${name}`, "utf8")
      expect(text).not.toContain(fixture.token)
      expect(text).not.toContain(fixture.secretFixture)
    }
    expect(await readFile(`${result.path}/investigation-state.json`, "utf8")).toContain("[REDACTED]")
  })

  it("rejects disabled, nested, malformed, and secret-containing exports without leaving partial data", async () => {
    const fixture = await retainedBundleFixture()
    await expect(stageRetainedBundle({ ...fixture.input, keepArtifacts: false })).rejects.toMatchObject({
      code: "DESTINATION_REQUIRED",
    })
    await expect(
      stageRetainedBundle({ ...fixture.input, destination: fixture.input.sessionDir }),
    ).rejects.toMatchObject({
      code: "EXPORT_FAILED",
    })
    await writeFile(fixture.input.stateFile, "not-json")
    await expect(stageRetainedBundle(fixture.input)).rejects.toMatchObject({ code: "EXPORT_FAILED" })

    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-retention-failure-"))
    onTestFinished(() => rm(container, { recursive: true, force: true }))
    const partialPath = path.join(container, "partial")
    await mkdir(partialPath)
    for (const name of ["evidence.ndjson", "investigation-state.json"])
      await writeFile(path.join(partialPath, name), "{}\n")
    const secret = "fixture-secret"
    await expect(
      finalizeRetainedBundle(
        {
          partialPath,
          finalPath: path.join(container, "final"),
          token: secret,
          securityValues: [],
          report: { ...fixture.input.finalReport, rootCause: secret },
          eventCount: 0,
        },
        fixture.cleanupResult,
      ),
    ).rejects.toMatchObject({ code: "EXPORT_FAILED" })
  })
})
