import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ProjectFileRewriteRollbackError,
  removeExactCanonicalProjectFile,
  rewriteCanonicalProjectFile,
} from "../../src/probes/source-safety.js"
import { withTempProject } from "../helpers/temp-project.js"

const renameRace = vi.hoisted(() => ({
  armed: false,
  source: "",
  ownedBackup: "",
  attacker: "",
}))

const rewriteRace = vi.hoisted(() => ({
  armed: false,
  source: "",
  originalBackup: "",
  attacker: "",
}))

const installRace = vi.hoisted(() => ({
  armed: false,
  source: "",
  attacker: "",
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    link: async (existingPath: string, newPath: string) => {
      if (installRace.armed && newPath === installRace.source && existingPath.includes("rewrite-next")) {
        installRace.armed = false
        await actual.writeFile(newPath, installRace.attacker)
      }
      return actual.link(existingPath, newPath)
    },
    rename: async (oldPath: string, newPath: string) => {
      if (rewriteRace.armed && oldPath === rewriteRace.source && newPath.includes("rewrite-backup")) {
        rewriteRace.armed = false
        await actual.rename(oldPath, rewriteRace.originalBackup)
        await actual.writeFile(oldPath, rewriteRace.attacker)
      }
      if (renameRace.armed && oldPath === renameRace.source && newPath.includes(".opencode-debug-mode-delete-")) {
        renameRace.armed = false
        await actual.rename(oldPath, renameRace.ownedBackup)
        await actual.writeFile(oldPath, renameRace.attacker)
      }
      return actual.rename(oldPath, newPath)
    },
  }
})

afterEach(() => {
  renameRace.armed = false
  rewriteRace.armed = false
  installRace.armed = false
})

describe("probe source removal races", () => {
  it("restores rather than deletes a file swapped immediately before quarantine", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "debug-transport.mjs")
      const ownedBackup = path.join(paths.projectRoot, "owned-backup.mjs")
      const owned = Buffer.from("owned helper\n")
      const attacker = "concurrent replacement\n"
      await writeFile(source, owned)
      Object.assign(renameRace, {
        armed: true,
        source,
        ownedBackup,
        attacker,
      })

      await expect(
        removeExactCanonicalProjectFile(
          paths.projectRoot,
          source,
          createHash("sha256").update(owned).digest("hex"),
          owned.byteLength,
        ),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })
      await expect(readFile(source, "utf8")).resolves.toBe(attacker)
      await expect(readFile(ownedBackup, "utf8")).resolves.toBe(owned.toString())
      await expect(readdir(paths.projectRoot)).resolves.not.toEqual(
        expect.arrayContaining([expect.stringContaining(".opencode-debug-mode-delete-")]),
      )
    }))

  it("never overwrites a replacement installed immediately before rewrite quarantine", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const originalBackup = path.join(paths.projectRoot, "concurrent-original-backup.ts")
      const original = "export const original = true\n"
      const replacement = "export const replacement = true\n"
      const attacker = "export const concurrent = true\n"
      await writeFile(source, original)
      Object.assign(rewriteRace, {
        armed: true,
        source,
        originalBackup,
        attacker,
      })

      await expect(rewriteCanonicalProjectFile(paths.projectRoot, source, original, replacement)).resolves.toBe(false)
      await expect(readFile(source, "utf8")).resolves.toBe(attacker)
      await expect(readFile(originalBackup, "utf8")).resolves.toBe(original)
      await expect(readdir(paths.projectRoot)).resolves.not.toEqual(
        expect.arrayContaining([expect.stringContaining(".opencode-debug-mode-rewrite-")]),
      )
    }))

  it("uses a no-replace staged commit when a writer fills the quarantined destination", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const original = "export const original = true\n"
      const replacement = "export const replacement = true\n"
      const attacker = "export const concurrent = true\n"
      await writeFile(source, original)
      Object.assign(installRace, { armed: true, source, attacker })

      await expect(
        rewriteCanonicalProjectFile(paths.projectRoot, source, original, replacement),
      ).rejects.toBeInstanceOf(ProjectFileRewriteRollbackError)
      await expect(readFile(source, "utf8")).resolves.toBe(attacker)
      const entries = await readdir(paths.projectRoot)
      const backup = entries.find((entry) => entry.includes(".opencode-debug-mode-rewrite-backup-"))
      expect(backup).toBeDefined()
      await expect(readFile(path.join(paths.projectRoot, backup as string), "utf8")).resolves.toBe(original)
      expect(entries).not.toEqual(expect.arrayContaining([expect.stringContaining("rewrite-next")]))
    }))
})
