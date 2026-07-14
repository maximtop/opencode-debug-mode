import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { recoverOrphans } from "../../src/session/orphan-recovery.js"
import { orphanRecoveryFixture } from "../helpers/factories.js"

describe("orphan recovery", () => {
  it("cleans a verified expired manifest and preserves active/unrelated directories", async () => {
    const fixture = await orphanRecoveryFixture()
    const result = await recoverOrphans(fixture.options)
    expect(result.cleaned).toEqual([fixture.expiredSessionId])
    expect(await fixture.exists(fixture.activeDir)).toBe(true)
    expect(await fixture.exists(fixture.unrelatedDir)).toBe(true)
  })

  it("rejects an expired manifest that references a source outside its project", async () => {
    const fixture = await orphanRecoveryFixture()
    await fixture.injectEscapingProbe()

    const result = await recoverOrphans(fixture.options)

    expect(result.cleaned).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(await fixture.readOutside()).toContain("DEBUG-START")
  })

  it("handles missing bases, ignores active sessions and symlinks, and supports custom cleanup", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-orphan-matrix-"))
    onTestFinished(() => rm(container, { recursive: true, force: true }))
    expect(await recoverOrphans({ tempBase: path.join(container, "missing") })).toEqual({
      cleaned: [],
      ignored: [],
      errors: [],
    })

    const active = await orphanRecoveryFixture()
    const activeResult = await recoverOrphans({
      ...active.options,
      activeSessionDirs: new Set([await realpath(active.expiredDir)]),
    })
    expect(activeResult.cleaned).toEqual([])

    const custom = await orphanRecoveryFixture()
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const customResult = await recoverOrphans({ ...custom.options, cleanup })
    expect(customResult.cleaned).toEqual([custom.expiredSessionId])
    expect(cleanup).toHaveBeenCalledOnce()

    const base = path.join(container, "base")
    const target = path.join(container, "target")
    await Promise.all([mkdir(base), mkdir(target)])
    await symlink(target, path.join(base, "session-link"))
    await writeFile(path.join(base, "ordinary-file"), "fixture")
    const ignored = await recoverOrphans({ tempBase: base })
    expect(ignored.ignored.sort()).toEqual(["ordinary-file", "session-link"])
  })
})
