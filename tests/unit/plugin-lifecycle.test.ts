import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { LIMITS } from "../../src/core/constants.js"
import { createDebugModePlugin } from "../../src/index.js"
import { pluginHarness } from "../helpers/factories.js"
import { FakeClock } from "../helpers/fake-clock.js"

describe("OpenCode plugin lifecycle", () => {
  it("cleans owned sessions on deletion and dispose", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await harness.event({ type: "session.deleted", properties: { info: { id: "session-A" } } })
    expect(harness.cleanup).toHaveBeenCalledWith("session-A", "session-deleted")
    await harness.dispose()
    expect(harness.registry.closeAll).toHaveBeenCalled()
  })

  it("ignores unrelated lifecycle events and deletion of a non-debug session", async () => {
    const harness = await pluginHarness()
    await expect(harness.event({ type: "server.connected", properties: {} })).resolves.toBeUndefined()
    await expect(
      harness.event({ type: "session.deleted", properties: { info: { id: "not-active" } } }),
    ).resolves.toBeUndefined()
  })

  it("rejects extension permission requests outside their runtime and project scope", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    const mismatch = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "web",
        extensionManifestPath: "manifest.json",
      })) as string,
    )
    expect(mismatch.error.code).toBe("PERMISSION_MISMATCH")

    const outside = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        extensionManifestPath: "../manifest.json",
      })) as string,
    )
    expect(outside.error.code).toBe("PERMISSION_MISMATCH")
  })

  it("supports explicit retention and reports checkpoint recovery through status", async () => {
    const harness = await pluginHarness()
    const destination = path.join(harness.projectRoot, "retained")
    await mkdir(destination)
    const started = JSON.parse(
      (await harness.executeTool("debug_session_start", {
        keepArtifacts: true,
        retentionDestination: destination,
      })) as string,
    )
    expect(started.ok).toBe(true)
    const [sessionDirectory] = await readdir(path.join(harness.projectRoot, "sessions"))
    await rm(path.join(harness.projectRoot, "sessions", sessionDirectory as string, "investigation-state.json"))
    const status = JSON.parse((await harness.executeTool("debug_session_status", {})) as string)
    expect(status.data).toMatchObject({ phase: "recovery-required" })
  })

  it("tears down the session directory when the composed registry expires it", async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-plugin-expiry-"))
    const tempBase = path.join(container, "sessions")
    onTestFinished(() => rm(container, { recursive: true, force: true }))
    const clock = new FakeClock("2026-07-13T00:00:00.000Z")
    await pluginHarness(createDebugModePlugin({ clock, tempBase }), { activeSessions: ["idle-session"] })
    expect(await readdir(tempBase)).toHaveLength(1)

    clock.advance(LIMITS.idleMs + 1)
    await vi.advanceTimersByTimeAsync(30_000)
    vi.useRealTimers()
    for (let attempt = 0; attempt < 100 && (await readdir(tempBase)).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(await readdir(tempBase)).toEqual([])
  })
})
