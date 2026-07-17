import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { LIMITS } from "../../src/core/constants.js"
import { SessionRegistry } from "../../src/session/registry.js"
import { projectContextFixture, registryFixture } from "../helpers/factories.js"
import { FakeClock } from "../helpers/fake-clock.js"

describe("session registry", () => {
  it("waits for an in-flight session start before serving parallel lifecycle tools", async () => {
    const registry = await registryFixture(new FakeClock("2026-07-13T00:00:00.000Z"))
    const starting = registry.start("parallel", projectContextFixture())
    const reading = registry.requireOwned("parallel")

    const [started, read] = await Promise.all([starting, reading])

    expect(read.publicId).toBe(started.publicId)
  })

  it("settles in-flight starts during close without retaining a session directory", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-registry-close-start-"))
    onTestFinished(() => rm(container, { recursive: true, force: true }))
    const project = path.join(container, "project")
    const sessions = path.join(container, "sessions")
    await mkdir(project)
    const registry = new SessionRegistry(sessions)

    const starting = registry.start("closing", { directory: project, worktree: project })
    await Promise.all([registry.closeAll(), registry.closeAll()])

    await expect(starting).rejects.toMatchObject({ code: "NO_ACTIVE_SESSION" })
    const entries = await readdir(sessions).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    expect(entries.filter((entry) => entry.startsWith("session-"))).toEqual([])
    expect(registry.listActive()).toEqual([])
  })

  it("isolates trusted OpenCode sessions and rehydrates the matching one", async () => {
    const clock = new FakeClock("2026-07-13T00:00:00.000Z")
    const first = await registryFixture(clock)
    const a = await first.start("trusted-A", projectContextFixture())
    const b = await first.start("trusted-B", projectContextFixture())
    expect(a.publicId).not.toBe(b.publicId)
    await expect(first.requireOwned("trusted-C")).rejects.toMatchObject({ code: "NO_ACTIVE_SESSION" })
    const restarted = await registryFixture(clock)
    expect((await restarted.requireOwned("trusted-A")).publicId).toBe(a.publicId)
  })

  it("validates startup scope and retention options", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-registry-validation-"))
    onTestFinished(() => rm(container, { recursive: true, force: true }))
    const project = path.join(container, "project")
    const outside = path.join(container, "outside")
    await Promise.all([mkdir(project), mkdir(outside)])
    const registry = new SessionRegistry(path.join(container, "sessions"))
    onTestFinished(() => registry.closeAll())

    await expect(
      registry.start("retention", { directory: project, worktree: project }, { keepArtifacts: true }),
    ).rejects.toMatchObject({ code: "DESTINATION_REQUIRED" })
    await expect(registry.start("outside", { directory: outside, worktree: project })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    })
    expect(await registry.hasTrusted("missing")).toBe(false)
  })

  it("touches activity, protects leased sessions, expires idle sessions, and closes idempotently", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-registry-lifecycle-"))
    onTestFinished(() => rm(container, { recursive: true, force: true }))
    const project = path.join(container, "project")
    await mkdir(project)
    const clock = new FakeClock("2026-07-13T00:00:00.000Z")
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const registry = new SessionRegistry(path.join(container, "sessions"), clock, cleanup)
    const session = await registry.start("trusted", { directory: project, worktree: project })

    clock.advance(1_000)
    await registry.touch("trusted")
    expect((await session.manifestStore.read()).lastActivityAt).toBe(clock.now().toISOString())
    const release = await registry.acquireLease("trusted", "process")
    clock.advance(LIMITS.idleMs + 1)
    await registry.sweep()
    expect(cleanup).not.toHaveBeenCalled()
    release()
    release()
    await registry.sweep()
    expect(cleanup).toHaveBeenCalledWith(session, "idle-expired")
    expect(registry.listActive()).toEqual([])

    registry.forgetTrusted("trusted")
    await registry.closeAll()
    await registry.closeAll()
    await expect(registry.requireOwned("trusted")).rejects.toMatchObject({ code: "NO_ACTIVE_SESSION" })
  })

  it("rejects sessions owned by a different registry", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-registry-ownership-"))
    onTestFinished(() => rm(container, { recursive: true, force: true }))
    const project = path.join(container, "project")
    await mkdir(project)
    const first = new SessionRegistry(path.join(container, "first"))
    const second = new SessionRegistry(path.join(container, "second"))
    onTestFinished(async () => {
      await first.closeAll()
      await second.closeAll()
    })
    const session = await first.start("trusted", { directory: project, worktree: project })
    await expect(second.touchSession(session)).rejects.toMatchObject({ code: "SESSION_OWNERSHIP_MISMATCH" })
    expect(() => second.acquireLeaseForSession(session, "waiting")).toThrowError(
      expect.objectContaining({ code: "SESSION_OWNERSHIP_MISMATCH" }),
    )
  })
})
