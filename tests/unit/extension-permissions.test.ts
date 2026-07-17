import {
  access,
  appendFile,
  type FileHandle,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { CollectorServer } from "../../src/collector/server.js"
import { addLoopbackPermission, removeLoopbackPermission } from "../../src/probes/extension-permissions.js"
import { ManifestStore } from "../../src/session/manifest-store.js"
import { extensionManifestFixture, pluginHarness } from "../helpers/factories.js"

type PluginHarness = Awaited<ReturnType<typeof pluginHarness>>

async function prepareCollectorStart(harness: PluginHarness): Promise<void> {
  const initial = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
  expect(
    JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: initial.revision,
        state: {
          ...initial,
          reproduction: { method: "load extension", requiresUser: false, confirmed: null },
          phase: "hypotheses",
          hypotheses: [
            {
              id: "hyp_permission",
              rank: 1,
              statement: "the extension transport needs loopback permission",
              confirmationSignals: ["collector receives an event"],
              eliminationSignals: ["collector remains unreachable"],
              status: "open",
              evidenceRefs: [],
            },
            {
              id: "hyp_transport",
              rank: 2,
              statement: "the transport helper is missing",
              confirmationSignals: ["helper import is absent"],
              eliminationSignals: ["helper import is present"],
              status: "open",
              evidenceRefs: [],
            },
          ],
        },
      })) as string,
    ).ok,
  ).toBe(true)
  await harness.selectAgent("debug")
  await harness.completeText(
    "## Working hypotheses\n1. hyp_permission — the extension transport needs loopback permission; confirm: collector receives an event; eliminate: collector remains unreachable.\n2. hyp_transport — the transport helper is missing; confirm: helper import is absent; eliminate: helper import is present.",
  )
  expect(
    JSON.parse(
      (await harness.executeTool("debug_run_start", {
        label: "pre-fix",
        reproduction: "load extension",
        waitingForUser: false,
      })) as string,
    ).ok,
  ).toBe(true)
  const state = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
  expect(
    JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: state.revision,
        state: { ...state, phase: "instrumenting" },
      })) as string,
    ).ok,
  ).toBe(true)
}

function captureCollectorStarts(): {
  handles: Array<Awaited<ReturnType<CollectorServer["start"]>>>
  servers: CollectorServer[]
  restore(): void
} {
  const handles: Array<Awaited<ReturnType<CollectorServer["start"]>>> = []
  const servers: CollectorServer[] = []
  const originalStart = CollectorServer.prototype.start
  const spy = vi.spyOn(CollectorServer.prototype, "start").mockImplementation(async function (this: CollectorServer) {
    servers.push(this)
    const handle = await originalStart.call(this)
    handles.push(handle)
    return handle
  })
  return { handles, servers, restore: () => spy.mockRestore() }
}

async function writableFileHandlePrototype(filename: string): Promise<Pick<FileHandle, "sync">> {
  const handle = await open(filename, "r+")
  const prototype = Object.getPrototypeOf(handle) as Pick<FileHandle, "sync">
  await handle.close()
  return prototype
}

async function expectCollectorClosed(handle: Awaited<ReturnType<CollectorServer["start"]>>): Promise<void> {
  const host = handle.host === "::1" ? "[::1]" : handle.host
  await expect(fetch(`http://${host}:${handle.port}/`)).rejects.toThrow()
}

describe("extension permissions", () => {
  it.each([
    { manifestVersion: 2, property: "permissions" },
    { manifestVersion: 3, property: "host_permissions" },
  ])("adds and removes only the session-owned $property entry", async ({ manifestVersion, property }) => {
    const fixture = await extensionManifestFixture({ manifestVersion, unrelatedEdit: true })
    const change = await addLoopbackPermission(fixture.root, fixture.path, fixture.matchPattern)
    expect(change.property).toBe(property)
    await fixture.addUnrelatedPermission("https://example.test/*")
    await removeLoopbackPermission(fixture.root, fixture.path, change)
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
    const initial = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    expect(
      JSON.parse(
        (await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: initial.revision,
          state: {
            ...initial,
            reproduction: { method: "load extension", requiresUser: false, confirmed: null },
            phase: "hypotheses",
            hypotheses: [
              {
                id: "hyp_permission",
                rank: 1,
                statement: "the extension transport needs loopback permission",
                confirmationSignals: ["collector receives an event"],
                eliminationSignals: ["collector remains unreachable"],
                status: "open",
                evidenceRefs: [],
              },
              {
                id: "hyp_transport",
                rank: 2,
                statement: "the transport helper is missing",
                confirmationSignals: ["helper import is absent"],
                eliminationSignals: ["helper import is present"],
                status: "open",
                evidenceRefs: [],
              },
            ],
          },
        })) as string,
      ).ok,
    ).toBe(true)
    await harness.selectAgent("debug")
    await harness.completeText(
      "## Working hypotheses\n1. hyp_permission — the extension transport needs loopback permission; confirm: collector receives an event; eliminate: collector remains unreachable.\n2. hyp_transport — the transport helper is missing; confirm: helper import is absent; eliminate: helper import is present.",
    )
    expect(
      JSON.parse(
        (await harness.executeTool("debug_run_start", {
          label: "pre-fix",
          reproduction: "load extension",
          waitingForUser: false,
        })) as string,
      ).ok,
    ).toBe(true)
    const beforeInstrumentation = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    expect(
      JSON.parse(
        (await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: beforeInstrumentation.revision,
          state: { ...beforeInstrumentation, phase: "instrumenting" },
        })) as string,
      ).ok,
    ).toBe(true)

    const started = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        transportTargetPath: "debug-transport.mjs",
        extensionManifestPath: "manifest.json",
      })) as string,
    )
    expect(started.ok).toBe(true)
    expect(await readFile(manifestPath, "utf8")).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\*/u)
    await expect(harness.beforeTool("read", { filePath: helperPath })).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await expect(harness.beforeTool("grep", { pattern: "authorization", path: "." })).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await expect(
      harness.beforeTool("grep", { pattern: "authorization", include: "debug-transport.mjs" }),
    ).rejects.toMatchObject({ code: "PERMISSION_MISMATCH" })
    await expect(
      harness.beforeTool("grep", { pattern: "filterUpdateOption\\b", include: "custom.ts" }),
    ).resolves.toBeDefined()
    await expect(
      harness.beforeTool("grep", { pattern: "filterUpdateOption\\b", path: "src/custom.ts" }),
    ).resolves.toBeDefined()

    const cleaned = JSON.parse(
      (await harness.executeTool("debug_cleanup", {
        reason: "unresolved",
        finalReport: {
          outcome: "unresolved",
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

  it("rejects manifest paths that escape through a symlink", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await prepareCollectorStart(harness)
    const outside = await mkdtemp(path.join(tmpdir(), "opencode-debug-manifest-outside-"))
    onTestFinished(() => rm(outside, { recursive: true, force: true }))
    const outsideManifest = path.join(outside, "manifest.json")
    const linkedDirectory = path.join(harness.projectRoot, "linked-extension")
    const original = `${JSON.stringify({ manifest_version: 3, name: "Outside", version: "1" }, null, 2)}\n`
    await writeFile(outsideManifest, original)
    await symlink(outside, linkedDirectory, "dir")

    const result = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        transportTargetPath: "debug-transport.mjs",
        extensionManifestPath: "linked-extension/manifest.json",
      })) as string,
    )

    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_MISMATCH" } })
    expect(await readFile(outsideManifest, "utf8")).toBe(original)
  })

  it("rejects an existing helper target before binding or changing extension permissions", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await prepareCollectorStart(harness)
    const manifestPath = path.join(harness.projectRoot, "manifest.json")
    const helperPath = path.join(harness.projectRoot, "existing-helper.mjs")
    await writeFile(
      manifestPath,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] }, null, 2)}\n`,
    )
    await writeFile(helperPath, "preserve user file\n")
    const captured = captureCollectorStarts()
    onTestFinished(captured.restore)

    const failed = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "existing-helper.mjs",
      })) as string,
    )

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "HELPER_PATH_UNSAFE",
        action: expect.stringContaining("new unused .mjs path"),
      },
    })
    expect(await readFile(helperPath, "utf8")).toBe("preserve user file\n")
    expect(await readFile(manifestPath, "utf8")).not.toContain("127.0.0.1")
    expect(captured.handles).toHaveLength(0)
    const retried = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "retry-helper.mjs",
      })) as string,
    )
    expect(retried.ok).toBe(true)
  })

  it("rolls back a created helper and permission when the manifest commit fails", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await prepareCollectorStart(harness)
    const manifestPath = path.join(harness.projectRoot, "manifest.json")
    const helperPath = path.join(harness.projectRoot, "rollback-helper.mjs")
    await writeFile(
      manifestPath,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] }, null, 2)}\n`,
    )
    const captured = captureCollectorStarts()
    onTestFinished(captured.restore)
    const manifestUpdate = vi
      .spyOn(ManifestStore.prototype, "modify")
      .mockRejectedValueOnce(new Error("fixture manifest commit failure"))
    onTestFinished(() => manifestUpdate.mockRestore())

    const failed = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "rollback-helper.mjs",
      })) as string,
    )
    manifestUpdate.mockRestore()

    expect(failed.ok).toBe(false)
    await expect(access(helperPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(manifestPath, "utf8")).not.toContain("127.0.0.1")
    expect(captured.handles).toHaveLength(1)
    await expectCollectorClosed(captured.handles[0] as Awaited<ReturnType<CollectorServer["start"]>>)
    const retried = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "rollback-helper.mjs",
      })) as string,
    )
    expect(retried.ok).toBe(true)
  })

  it("reports a partial rollback when a changed token-bearing helper cannot be removed", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await prepareCollectorStart(harness)
    const manifestPath = path.join(harness.projectRoot, "manifest.json")
    const helperPath = path.join(harness.projectRoot, "changed-rollback-helper.mjs")
    await writeFile(
      manifestPath,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] }, null, 2)}\n`,
    )
    const captured = captureCollectorStarts()
    onTestFinished(captured.restore)
    const manifestUpdate = vi.spyOn(ManifestStore.prototype, "modify").mockImplementationOnce(async () => {
      await appendFile(helperPath, "\n// concurrent user change\n")
      throw new Error("fixture manifest commit failure")
    })
    onTestFinished(() => manifestUpdate.mockRestore())

    const failed = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "changed-rollback-helper.mjs",
      })) as string,
    )

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "CLEANUP_PARTIAL",
        details: { residues: expect.stringContaining(`${helperPath}:content-mismatch`) },
      },
    })
    expect(await readFile(helperPath, "utf8")).toContain("concurrent user change")
    expect(await readFile(manifestPath, "utf8")).not.toContain("127.0.0.1")
    await expectCollectorClosed(captured.handles[0] as Awaited<ReturnType<CollectorServer["start"]>>)
  })

  it("reports a partial rollback when the loopback permission cannot be removed", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await prepareCollectorStart(harness)
    const manifestPath = path.join(harness.projectRoot, "manifest.json")
    const helperPath = path.join(harness.projectRoot, "permission-rollback-helper.mjs")
    await writeFile(
      manifestPath,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] }, null, 2)}\n`,
    )
    const captured = captureCollectorStarts()
    onTestFinished(captured.restore)
    const manifestUpdate = vi.spyOn(ManifestStore.prototype, "modify").mockImplementationOnce(async () => {
      await writeFile(manifestPath, '{"manifest_version":4}\n')
      throw new Error("fixture manifest commit failure")
    })
    onTestFinished(() => manifestUpdate.mockRestore())

    const failed = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "permission-rollback-helper.mjs",
      })) as string,
    )

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "CLEANUP_PARTIAL",
        details: { residues: expect.stringContaining(`${manifestPath}:manifest-version-changed`) },
      },
    })
    await expect(access(helperPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(manifestPath, "utf8")).toContain('"manifest_version":4')
    await expectCollectorClosed(captured.handles[0] as Awaited<ReturnType<CollectorServer["start"]>>)
  })

  it("preserves atomic permission residue details and removes the provisionally owned match", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await prepareCollectorStart(harness)
    const manifestPath = path.join(harness.projectRoot, "manifest.json")
    const movedPermissionPath = path.join(harness.projectRoot, "moved-permission-manifest.json")
    const helperPath = path.join(harness.projectRoot, "permission-residue-helper.mjs")
    await writeFile(
      manifestPath,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] }, null, 2)}\n`,
    )
    const captured = captureCollectorStarts()
    onTestFinished(captured.restore)
    const prototype = await writableFileHandlePrototype(manifestPath)
    const originalSync = prototype.sync
    let directorySyncs = 0
    const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
      if ((await this.stat()).isDirectory()) {
        directorySyncs += 1
        if (directorySyncs === 2) {
          await rename(manifestPath, movedPermissionPath)
          await writeFile(manifestPath, await readFile(movedPermissionPath))
          throw new Error("injected post-commit permission rewrite failure")
        }
      }
      return originalSync.call(this)
    })
    onTestFinished(() => syncSpy.mockRestore())

    const failed = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "permission-residue-helper.mjs",
      })) as string,
    )

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "CLEANUP_PARTIAL",
        details: {
          path: manifestPath,
          residuePath: expect.stringContaining(".opencode-debug-mode-rewrite-backup-"),
        },
      },
    })
    expect(await readFile(movedPermissionPath, "utf8")).toContain("127.0.0.1")
    expect(await readFile(manifestPath, "utf8")).not.toContain("127.0.0.1")
    await expect(access(helperPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(captured.handles).toHaveLength(1)
    await expectCollectorClosed(captured.handles[0] as Awaited<ReturnType<CollectorServer["start"]>>)
  })

  it("uses manifest-backed cleanup when the listener fails during startup ownership commit", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await prepareCollectorStart(harness)
    const manifestPath = path.join(harness.projectRoot, "manifest.json")
    const helperPath = path.join(harness.projectRoot, "listener-failure-helper.mjs")
    await writeFile(
      manifestPath,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] }, null, 2)}\n`,
    )
    const captured = captureCollectorStarts()
    onTestFinished(captured.restore)
    const originalModify = ManifestStore.prototype.modify
    let failureInjected = false
    const manifestUpdate = vi.spyOn(ManifestStore.prototype, "modify").mockImplementation(async function (
      this: ManifestStore,
      mutate,
    ) {
      if (!failureInjected && captured.servers.length === 1) {
        failureInjected = true
        const listener = (
          captured.servers[0] as unknown as {
            server?: { emit(event: string, error: Error): boolean }
          }
        ).server
        expect(listener).toBeDefined()
        listener?.emit("error", new Error("injected listener failure during manifest commit"))
      }
      return originalModify.call(this, mutate)
    })
    onTestFinished(() => manifestUpdate.mockRestore())

    const failed = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "manifest.json",
        transportTargetPath: "listener-failure-helper.mjs",
      })) as string,
    )

    expect(failureInjected).toBe(true)
    expect(failed).toMatchObject({ ok: false, error: { code: "LOOPBACK_BIND_FAILED" } })
    expect(await readFile(manifestPath, "utf8")).not.toContain("127.0.0.1")
    await expect(access(helperPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(captured.handles).toHaveLength(1)
    await expectCollectorClosed(captured.handles[0] as Awaited<ReturnType<CollectorServer["start"]>>)
  })

  it("rejects malformed or unsafe manifests and handles conservative removal states", async () => {
    const fixture = await extensionManifestFixture({ manifestVersion: 3 })
    await expect(addLoopbackPermission(fixture.root, fixture.path, "https://example.test/*")).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await writeFile(fixture.path, "{broken")
    await expect(addLoopbackPermission(fixture.root, fixture.path, fixture.matchPattern)).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await writeFile(fixture.path, '{"manifest_version":4}\n')
    await expect(addLoopbackPermission(fixture.root, fixture.path, fixture.matchPattern)).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    await writeFile(fixture.path, '{"manifest_version":3,"host_permissions":[1]}\n')
    await expect(addLoopbackPermission(fixture.root, fixture.path, fixture.matchPattern)).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })

    await writeFile(
      fixture.path,
      `${JSON.stringify({ manifest_version: 3, host_permissions: [fixture.matchPattern] })}\n`,
    )
    const preexisting = await addLoopbackPermission(fixture.root, fixture.path, fixture.matchPattern)
    expect(preexisting.addedBySession).toBe(false)
    expect(await removeLoopbackPermission(fixture.root, fixture.path, preexisting)).toEqual({ status: "already-clean" })

    const owned = { ...preexisting, addedBySession: true }
    await writeFile(fixture.path, "{broken")
    expect(await removeLoopbackPermission(fixture.root, fixture.path, owned)).toEqual({
      status: "failed",
      reason: "manifest-invalid",
    })
    await writeFile(fixture.path, '{"manifest_version":2,"permissions":[]}\n')
    expect(await removeLoopbackPermission(fixture.root, fixture.path, owned)).toEqual({
      status: "failed",
      reason: "manifest-version-changed",
    })
    await writeFile(fixture.path, '{"manifest_version":3,"host_permissions":[]}\n')
    expect(await removeLoopbackPermission(fixture.root, fixture.path, owned)).toEqual({ status: "already-clean" })
    await writeFile(
      fixture.path,
      `${JSON.stringify({ manifest_version: 3, host_permissions: [fixture.matchPattern, fixture.matchPattern] })}\n`,
    )
    expect(await removeLoopbackPermission(fixture.root, fixture.path, owned)).toEqual({
      status: "failed",
      reason: "permission-ambiguous",
    })
    await writeFile(fixture.path, '{"manifest_version":3,"host_permissions":1}\n')
    expect(await removeLoopbackPermission(fixture.root, fixture.path, owned)).toEqual({
      status: "failed",
      reason: "permission-structure-changed",
    })
  })
})
