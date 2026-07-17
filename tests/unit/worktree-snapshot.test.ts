import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { isTrustedGitDirectory, WorktreeSnapshot } from "../../src/process/worktree-snapshot.js"

const containers: string[] = []
const execFileAsync = promisify(execFile)

async function fixture(): Promise<{ projectRoot: string; storageRoot: string }> {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-snapshot-test-"))
  containers.push(container)
  const projectRoot = path.join(container, "project")
  const storageRoot = path.join(container, "storage")
  await mkdir(path.join(projectRoot, "src"), { recursive: true })
  await mkdir(storageRoot)
  return { projectRoot, storageRoot }
}

afterEach(async () => {
  await Promise.all(containers.splice(0).map((container) => rm(container, { force: true, recursive: true })))
})

describe("supervised worktree snapshot", () => {
  it("matches Windows trusted Git directories exactly", () => {
    const environment = {
      SystemRoot: "D:\\Windows",
      ProgramFiles: "D:\\Program Files",
      "ProgramFiles(x86)": "D:\\Program Files (x86)",
    }

    expect(isTrustedGitDirectory("D:\\Windows\\System32", "win32", environment)).toBe(true)
    expect(isTrustedGitDirectory("D:\\Program Files\\Git\\cmd", "win32", environment)).toBe(true)
    expect(isTrustedGitDirectory("d:\\program files (x86)\\git\\BIN", "win32", environment)).toBe(true)
    expect(isTrustedGitDirectory("D:\\repo\\Windows\\System32", "win32", environment)).toBe(false)
    expect(isTrustedGitDirectory("D:\\tmp\\Program Files\\Git\\cmd", "win32", environment)).toBe(false)
    expect(isTrustedGitDirectory("D:\\Program Files\\Git\\cmd\\nested", "win32", environment)).toBe(false)
  })

  it.skipIf(process.platform === "win32")("never executes a project PATH shim before the baseline exists", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const shimDirectory = path.join(projectRoot, "bin")
    const shim = path.join(shimDirectory, "git")
    const sentinel = path.join(projectRoot, "shim-ran")
    await mkdir(shimDirectory)
    await writeFile(shim, `#!/bin/sh\nprintf shim > ${JSON.stringify(sentinel)}\nexit 1\n`)
    await chmod(shim, 0o755)

    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot, { gitPathValue: shimDirectory })

    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await snapshot.dispose()
  })

  it("restores changed, deleted, and newly-created project files", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const changed = path.join(projectRoot, "src", "changed.ts")
    const deleted = path.join(projectRoot, "src", "deleted.ts")
    const created = path.join(projectRoot, "src", "created.ts")
    await writeFile(changed, "export const value = 1\n")
    await writeFile(deleted, "export const kept = true\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot)

    await writeFile(changed, "export const value = 2\n")
    await rm(deleted)
    await writeFile(created, "export const injected = true\n")

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["src/changed.ts", "src/created.ts", "src/deleted.ts"],
      restored: true,
      restorationFailures: 0,
    })
    await expect(readFile(changed, "utf8")).resolves.toBe("export const value = 1\n")
    await expect(readFile(deleted, "utf8")).resolves.toBe("export const kept = true\n")
    await expect(readFile(created, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("fails closed on a parent-directory symlink without following it outside the project", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const source = path.join(projectRoot, "src", "behavior.ts")
    const outside = path.join(path.dirname(projectRoot), "outside")
    await mkdir(outside)
    await writeFile(source, "export const safe = true\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot)

    await rm(path.join(projectRoot, "src"), { recursive: true })
    await symlink(outside, path.join(projectRoot, "src"))

    const reconciliation = await snapshot.reconcile()
    expect(reconciliation).toMatchObject({
      restored: false,
      restorationFailures: 1,
      residuePaths: ["src/behavior.ts"],
    })
    expect(reconciliation.changedPaths).toEqual(["src", "src/behavior.ts"])
    await expect(readFile(source, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(path.join(outside, "behavior.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await snapshot.dispose()
  })

  it("excludes only the package-owned session directory when storage is inside the project", async () => {
    const { projectRoot } = await fixture()
    const storageRoot = path.join(projectRoot, "sessions", "session-owned")
    const ownedManifest = path.join(storageRoot, "manifest.json")
    const siblingSource = path.join(projectRoot, "sessions", "user-source.ts")
    await mkdir(storageRoot, { recursive: true })
    await writeFile(ownedManifest, '{"revision":0}\n')
    await writeFile(siblingSource, "export const value = 1\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot)

    await writeFile(ownedManifest, '{"revision":1}\n')
    await writeFile(path.join(storageRoot, "evidence.ndjson"), '{"event":1}\n')
    await writeFile(siblingSource, "export const value = 2\n")

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["sessions/user-source.ts"],
      restored: true,
      restorationFailures: 0,
      residuePaths: [],
    })
    await expect(readFile(ownedManifest, "utf8")).resolves.toBe('{"revision":1}\n')
    await expect(readFile(path.join(storageRoot, "evidence.ndjson"), "utf8")).resolves.toBe('{"event":1}\n')
    await expect(readFile(siblingSource, "utf8")).resolves.toBe("export const value = 1\n")
  })

  it("preserves a concurrent replacement instead of overwriting it during restoration", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const source = path.join(projectRoot, "src", "behavior.ts")
    await writeFile(source, "export const value = 'baseline'\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot, {
      beforeRestore: async (relativePath) => {
        if (relativePath === "src/behavior.ts") await writeFile(source, "export const value = 'user-edit'\n")
      },
    })
    await writeFile(source, "export const value = 'command-edit'\n")

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["src/behavior.ts"],
      restored: false,
      restorationFailures: 1,
      residuePaths: ["src/behavior.ts"],
    })
    await expect(readFile(source, "utf8")).resolves.toBe("export const value = 'user-edit'\n")
    await snapshot.dispose()
  })

  it("restores a replaced symlink and removes a newly-created symlink", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const existingLink = path.join(projectRoot, "src", "current.ts")
    const newLink = path.join(projectRoot, "src", "injected.ts")
    await writeFile(path.join(projectRoot, "src", "original.ts"), "export const original = true\n")
    await writeFile(path.join(projectRoot, "src", "replacement.ts"), "export const replacement = true\n")
    await symlink("./original.ts", existingLink)
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot)

    await rm(existingLink)
    await symlink("./replacement.ts", existingLink)
    await symlink("./replacement.ts", newLink)

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["src/current.ts", "src/injected.ts"],
      restored: true,
      restorationFailures: 0,
      residuePaths: [],
    })
    await expect(readlink(existingLink)).resolves.toBe("./original.ts")
    await expect(readlink(newLink)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("fails closed when a protected file disappears immediately before restoration", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const source = path.join(projectRoot, "src", "behavior.ts")
    await writeFile(source, "export const value = 'baseline'\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot, {
      beforeRestore: async (relativePath) => {
        if (relativePath === "src/behavior.ts") await rm(source)
      },
    })
    await writeFile(source, "export const value = 'command-edit'\n")

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["src/behavior.ts"],
      restored: false,
      restorationFailures: 1,
      residuePaths: ["src/behavior.ts"],
    })
    await expect(readFile(source, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await snapshot.dispose()
  })

  it("fails closed if Git discovery becomes unavailable after a Git-backed snapshot", async () => {
    const { projectRoot, storageRoot } = await fixture()
    await writeFile(path.join(projectRoot, "src", "tracked.ts"), "export const tracked = true\n")
    await execFileAsync("git", ["init"], { cwd: projectRoot })
    await execFileAsync("git", ["add", "--all"], { cwd: projectRoot })
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot)

    await rm(path.join(projectRoot, ".git"), { recursive: true })

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: [],
      restored: false,
      restorationFailures: 1,
      residuePaths: [],
    })
    await snapshot.dispose()
  })

  it("rejects a second reconciliation attempt", async () => {
    const { projectRoot, storageRoot } = await fixture()
    await writeFile(path.join(projectRoot, "src", "stable.ts"), "export const stable = true\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot)

    await expect(snapshot.reconcile()).resolves.toMatchObject({ restored: true })
    await expect(snapshot.reconcile()).rejects.toThrow("Worktree snapshot was already reconciled")
  })

  it("preserves a concurrent file-to-symlink replacement", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const source = path.join(projectRoot, "src", "behavior.ts")
    await writeFile(source, "export const value = 'baseline'\n")
    await writeFile(path.join(projectRoot, "src", "user.ts"), "export const user = true\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot, {
      beforeRestore: async (relativePath) => {
        if (relativePath !== "src/behavior.ts") return
        await rm(source)
        await symlink("./user.ts", source)
      },
    })
    await writeFile(source, "export const value = 'command-edit'\n")

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["src/behavior.ts"],
      restored: false,
      restorationFailures: 1,
      residuePaths: ["src/behavior.ts"],
    })
    await expect(readlink(source)).resolves.toBe("./user.ts")
    await snapshot.dispose()
  })

  it("preserves a concurrent replacement of a file deleted by the command", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const source = path.join(projectRoot, "src", "behavior.ts")
    await writeFile(source, "export const value = 'baseline'\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot, {
      beforeRestore: async (relativePath) => {
        if (relativePath === "src/behavior.ts") await writeFile(source, "export const value = 'user-edit'\n")
      },
    })
    await rm(source)

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["src/behavior.ts"],
      restored: false,
      restorationFailures: 1,
      residuePaths: ["src/behavior.ts"],
    })
    await expect(readFile(source, "utf8")).resolves.toBe("export const value = 'user-edit'\n")
    await snapshot.dispose()
  })

  it("fails closed when a safe parent is replaced by a symlink immediately before restoration", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const sourceDirectory = path.join(projectRoot, "src")
    const source = path.join(sourceDirectory, "behavior.ts")
    const outside = path.join(path.dirname(projectRoot), "outside-race")
    await mkdir(outside)
    await writeFile(source, "export const value = 'baseline'\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot, {
      beforeRestore: async (relativePath) => {
        if (relativePath !== "src/behavior.ts") return
        await rm(sourceDirectory, { recursive: true })
        await symlink(outside, sourceDirectory)
      },
    })
    await writeFile(source, "export const value = 'command-edit'\n")

    const reconciliation = await snapshot.reconcile()
    expect(reconciliation).toMatchObject({ restored: false, residuePaths: ["src/behavior.ts"] })
    expect(reconciliation.changedPaths).toEqual(["src", "src/behavior.ts"])
    await expect(readFile(path.join(outside, "behavior.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await snapshot.dispose()
  })

  it("ignores only package residue names discovered after the snapshot", async () => {
    const { projectRoot } = await fixture()
    const missingStorageRoot = path.join(path.dirname(projectRoot), "storage-not-created")
    const source = path.join(projectRoot, "src", "stable.ts")
    const residue = path.join(projectRoot, "src", ".opencode-debug-residue-fixture")
    await writeFile(source, "export const stable = true\n")
    const snapshot = await WorktreeSnapshot.create(projectRoot, missingStorageRoot)
    await writeFile(residue, "preserve for explicit recovery\n")

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: [],
      restored: true,
      restorationFailures: 0,
    })
    await expect(readFile(residue, "utf8")).resolves.toBe("preserve for explicit recovery\n")
  })

  it("rejects a sparse project file that exceeds the protected snapshot byte limit", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const oversized = path.join(projectRoot, "src", "oversized.bin")
    await writeFile(oversized, "")
    await truncate(oversized, 1024 * 1024 * 1024 + 1)

    await expect(WorktreeSnapshot.create(projectRoot, storageRoot)).rejects.toMatchObject({
      code: "PROCESS_START_FAILED",
      message: expect.stringContaining("1 GiB"),
    })
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "wraps snapshot filesystem failures with a safe actionable error",
    async () => {
      const { projectRoot, storageRoot } = await fixture()
      const unreadable = path.join(projectRoot, "src", "unreadable.ts")
      await writeFile(unreadable, "export const secret = true\n")
      await chmod(unreadable, 0)
      try {
        await expect(WorktreeSnapshot.create(projectRoot, storageRoot)).rejects.toMatchObject({
          code: "PROCESS_START_FAILED",
          message: "The protected worktree snapshot could not be created",
          action: expect.stringContaining("file permissions"),
        })
      } finally {
        await chmod(unreadable, 0o600)
      }
    },
  )

  it.skipIf(process.platform === "win32")("reports a newly-created special file as residue", async () => {
    const { projectRoot, storageRoot } = await fixture()
    const fifo = path.join(projectRoot, "src", "injected.pipe")
    const snapshot = await WorktreeSnapshot.create(projectRoot, storageRoot)
    await execFileAsync("mkfifo", [fifo])

    await expect(snapshot.reconcile()).resolves.toMatchObject({
      changedPaths: ["src/injected.pipe"],
      restored: false,
      restorationFailures: 1,
      residuePaths: ["src/injected.pipe"],
    })
    await snapshot.dispose()
  })
})
