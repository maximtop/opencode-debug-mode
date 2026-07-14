import { access, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { addLoopbackPermission, removeLoopbackPermission } from "../../src/probes/extension-permissions.js"
import { extensionManifestFixture, pluginHarness } from "../helpers/factories.js"

describe("extension permissions", () => {
  it.each([
    { manifestVersion: 2, property: "permissions" },
    { manifestVersion: 3, property: "host_permissions" },
  ])("adds and removes only the session-owned $property entry", async ({ manifestVersion, property }) => {
    const fixture = await extensionManifestFixture({ manifestVersion, unrelatedEdit: true })
    const change = await addLoopbackPermission(fixture.path, fixture.matchPattern)
    expect(change.property).toBe(property)
    await fixture.addUnrelatedPermission("https://example.test/*")
    await removeLoopbackPermission(fixture.path, change)
    const text = await fixture.read()
    expect(text).toContain("https://example.test/*")
    expect(text).not.toContain(fixture.matchPattern)
  })

  it("tracks and removes a permission through the composed plugin workflow", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    const manifestPath = path.join(harness.projectRoot, "manifest.json")
    const helperPath = path.join(harness.projectRoot, "debug-transport.mjs")
    await writeFile(
      manifestPath,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] }, null, 2)}\n`,
    )

    const started = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        transportTargetPath: "debug-transport.mjs",
        extensionManifestPath: "manifest.json",
      })) as string,
    )
    expect(started.ok).toBe(true)
    expect(await readFile(manifestPath, "utf8")).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\*/u)

    const cleaned = JSON.parse(
      (await harness.executeTool("debug_cleanup", {
        reason: "completed",
        finalReport: {
          outcome: "completed",
          rootCause: "fixture",
          decidingEvidence: [],
          hypotheses: [],
          fix: "fixture",
          changedFiles: [],
          verification: ["fixture"],
        },
      })) as string,
    )
    expect(cleaned.data.resources.permissions).toEqual([{ status: "success", location: "manifest.json" }])
    expect(await readFile(manifestPath, "utf8")).not.toContain("127.0.0.1")
    await expect(access(helperPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects malformed or unsafe manifests and handles conservative removal states", async () => {
    const fixture = await extensionManifestFixture({ manifestVersion: 3 })
    await expect(addLoopbackPermission(fixture.path, "https://example.test/*")).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await writeFile(fixture.path, "{broken")
    await expect(addLoopbackPermission(fixture.path, fixture.matchPattern)).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await writeFile(fixture.path, '{"manifest_version":4}\n')
    await expect(addLoopbackPermission(fixture.path, fixture.matchPattern)).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await writeFile(fixture.path, '{"manifest_version":3,"host_permissions":[1]}\n')
    await expect(addLoopbackPermission(fixture.path, fixture.matchPattern)).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })

    await writeFile(
      fixture.path,
      `${JSON.stringify({ manifest_version: 3, host_permissions: [fixture.matchPattern] })}\n`,
    )
    const preexisting = await addLoopbackPermission(fixture.path, fixture.matchPattern)
    expect(preexisting.addedBySession).toBe(false)
    expect(await removeLoopbackPermission(fixture.path, preexisting)).toEqual({ status: "already-clean" })

    const owned = { ...preexisting, addedBySession: true }
    await writeFile(fixture.path, "{broken")
    expect(await removeLoopbackPermission(fixture.path, owned)).toEqual({
      status: "failed",
      reason: "manifest-invalid",
    })
    await writeFile(fixture.path, '{"manifest_version":2,"permissions":[]}\n')
    expect(await removeLoopbackPermission(fixture.path, owned)).toEqual({
      status: "failed",
      reason: "manifest-version-changed",
    })
    await writeFile(fixture.path, '{"manifest_version":3,"host_permissions":[]}\n')
    expect(await removeLoopbackPermission(fixture.path, owned)).toEqual({ status: "already-clean" })
    await writeFile(
      fixture.path,
      `${JSON.stringify({ manifest_version: 3, host_permissions: [fixture.matchPattern, fixture.matchPattern] })}\n`,
    )
    expect(await removeLoopbackPermission(fixture.path, owned)).toEqual({
      status: "failed",
      reason: "permission-ambiguous",
    })
    await writeFile(fixture.path, '{"manifest_version":3,"host_permissions":1}\n')
    expect(await removeLoopbackPermission(fixture.path, owned)).toEqual({
      status: "failed",
      reason: "permission-structure-changed",
    })
  })
})
