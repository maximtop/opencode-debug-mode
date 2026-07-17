import { createHash } from "node:crypto"
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  canonicalProjectFile,
  createCanonicalProjectFile,
  ProjectFileRewriteRollbackError,
  readCanonicalProjectFile,
  removeExactCanonicalProjectFile,
  rewriteCanonicalProjectFile,
  sourceCodeContextAt,
} from "../../src/probes/source-safety.js"
import { withTempProject } from "../helpers/temp-project.js"

afterEach(() => {
  vi.restoreAllMocks()
})

async function writableFileHandlePrototype(filename: string): Promise<Pick<FileHandle, "sync" | "write">> {
  const handle = await open(filename, "r+")
  const prototype = Object.getPrototypeOf(handle) as Pick<FileHandle, "sync" | "write">
  await handle.close()
  return prototype
}

describe("probe source safety", () => {
  it("distinguishes executable code from strings, comments, regexes, and template text", () => {
    const marker = "OWNED_MARKER"
    for (const source of [
      `const value = '${marker}'`,
      `const value = "${marker}"`,
      `const value = \`${marker}\``,
      `// ${marker}\nconst value = 1`,
      `/* ${marker} */ const value = 1`,
      `const value = /${marker}/u`,
    ]) {
      expect(sourceCodeContextAt(source, source.indexOf(marker)).inCode).toBe(false)
    }

    const executable = `function run() {\n  ${marker}\n}`
    expect(sourceCodeContextAt(executable, executable.indexOf(marker))).toMatchObject({
      inCode: true,
      braceDepth: 1,
    })
    const templateExpression = `const value = \`prefix ${"${"}(() => { ${marker} })()} suffix\``
    expect(sourceCodeContextAt(templateExpression, templateExpression.indexOf(marker))).toMatchObject({
      inCode: true,
      braceDepth: 1,
    })
  })

  it("reports the innermost unmatched delimiter at candidate statement boundaries", () => {
    const call = ["async function load() {", "  const value = await download(", "    url,", "  );", "}"].join("\n")
    expect(sourceCodeContextAt(call, call.indexOf("  );"))).toMatchObject({
      inCode: true,
      innermostDelimiter: "(",
    })

    const array = "const values = [\n  first,\n]"
    expect(sourceCodeContextAt(array, array.indexOf("  first"))).toMatchObject({
      inCode: true,
      innermostDelimiter: "[",
    })

    const callback = [
      "await download(",
      "  async () => {",
      "    const value = 1",
      "    return value",
      "  },",
      ")",
    ].join("\n")
    expect(sourceCodeContextAt(callback, callback.indexOf("    return value"))).toMatchObject({
      inCode: true,
      innermostDelimiter: "{",
    })
  })

  it("rejects a source path replaced by an out-of-project symlink", () =>
    withTempProject(async ({ root, paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const outside = path.join(path.dirname(root), "outside.ts")
      await Promise.all([writeFile(source, "export const value = 1\n"), writeFile(outside, "outside\n")])
      await expect(canonicalProjectFile(paths.projectRoot, source)).resolves.toBe(source)
      await expect(readCanonicalProjectFile(paths.projectRoot, source)).resolves.toContain("value")

      await rm(source)
      await symlink(outside, source)
      await expect(canonicalProjectFile(paths.projectRoot, source)).rejects.toMatchObject({
        code: "HELPER_PATH_UNSAFE",
      })
      await expect(readCanonicalProjectFile(paths.projectRoot, source)).rejects.toMatchObject({
        code: "HELPER_PATH_UNSAFE",
      })
    }))

  it("never follows an intermediate symlink while removing a hash-owned file", () =>
    withTempProject(async ({ root, paths }) => {
      const outside = path.join(path.dirname(root), "outside")
      const content = Buffer.from("owned helper\n")
      await mkdir(outside)
      await writeFile(path.join(outside, "debug-transport.mjs"), content)
      await symlink(outside, path.join(paths.projectRoot, "generated"), "dir")

      await expect(
        removeExactCanonicalProjectFile(
          paths.projectRoot,
          path.join(paths.projectRoot, "generated", "debug-transport.mjs"),
          createHash("sha256").update(content).digest("hex"),
          content.byteLength,
        ),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })
      await expect(readFile(path.join(outside, "debug-transport.mjs"), "utf8")).resolves.toBe(content.toString())
    }))

  it("completes positional rewrites when the filesystem reports short writes", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const original = "export const original = true\n"
      const replacement = "export const replacement = 'longer than the original source'\n"
      await writeFile(source, original)
      const prototype = await writableFileHandlePrototype(source)
      const originalWrite = prototype.write
      const boundedWrite = originalWrite as unknown as (
        this: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>
      vi.spyOn(prototype, "write").mockImplementation(function (
        this: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        return boundedWrite.call(this, buffer, offset, Math.min(length, 3), position)
      } as typeof originalWrite)

      await expect(rewriteCanonicalProjectFile(paths.projectRoot, source, original, replacement)).resolves.toBe(true)
      await expect(readFile(source, "utf8")).resolves.toBe(replacement)
    }))

  it("atomically replaces source through a same-directory staged inode while preserving mode", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const original = "export const original = true\n"
      const replacement = "export const replacement = true\n"
      await writeFile(source, original)
      await chmod(source, 0o754)
      const before = await stat(source)

      await expect(rewriteCanonicalProjectFile(paths.projectRoot, source, original, replacement)).resolves.toBe(true)

      const after = await stat(source)
      expect(await readFile(source, "utf8")).toBe(replacement)
      expect(after.mode & 0o777).toBe(before.mode & 0o777)
      if (process.platform !== "win32") expect(after.ino).not.toBe(before.ino)
      expect(await readdir(paths.projectRoot)).not.toEqual(
        expect.arrayContaining([expect.stringContaining(".opencode-debug-mode-rewrite-")]),
      )
    }))

  it("restores the exact original source when a rewrite fails after writing", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const original = "export const original = true\n"
      const replacement = "export const replacement = false\n"
      await writeFile(source, original)
      const before = await stat(source)
      const prototype = await writableFileHandlePrototype(source)
      const originalSync = prototype.sync
      vi.spyOn(prototype, "sync")
        .mockImplementationOnce(async () => {
          throw new Error("injected sync failure")
        })
        .mockImplementation(function (this: FileHandle) {
          return originalSync.call(this)
        })

      await expect(rewriteCanonicalProjectFile(paths.projectRoot, source, original, replacement)).rejects.toThrow(
        "injected sync failure",
      )
      await expect(readFile(source, "utf8")).resolves.toBe(original)
      expect((await stat(source)).ino).toBe(before.ino)
    }))

  it("restores the exact original source when a positional write fails after a short write", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const original = "export const original = true\n"
      const replacement = "export const replacement = 'substantially longer'\n"
      await writeFile(source, original)
      const prototype = await writableFileHandlePrototype(source)
      const originalWrite = prototype.write
      const boundedWrite = originalWrite as unknown as (
        this: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>
      let writeCalls = 0
      vi.spyOn(prototype, "write").mockImplementation(function (
        this: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        writeCalls += 1
        if (writeCalls === 1) return boundedWrite.call(this, buffer, offset, 3, position)
        if (writeCalls === 2) return Promise.reject(new Error("injected positional write failure"))
        return boundedWrite.call(this, buffer, offset, length, position)
      } as typeof originalWrite)

      await expect(rewriteCanonicalProjectFile(paths.projectRoot, source, original, replacement)).rejects.toThrow(
        "injected positional write failure",
      )
      await expect(readFile(source, "utf8")).resolves.toBe(original)
    }))

  it("reports a typed rollback failure without overwriting a concurrent replacement", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "source.ts")
      const movedReplacement = path.join(paths.projectRoot, "concurrent-moved-replacement.ts")
      const original = "export const original = true\n"
      const replacement = "export const replacement = true\n"
      const concurrent = "export const concurrent = true\n"
      await writeFile(source, original)
      const prototype = await writableFileHandlePrototype(source)
      const originalSync = prototype.sync
      let directorySyncs = 0
      vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
        if ((await this.stat()).isDirectory()) {
          directorySyncs += 1
          if (directorySyncs === 2) {
            await rename(source, movedReplacement)
            await writeFile(source, concurrent)
            throw new Error("injected post-commit directory sync failure")
          }
        }
        return originalSync.call(this)
      })

      await expect(
        rewriteCanonicalProjectFile(paths.projectRoot, source, original, replacement),
      ).rejects.toBeInstanceOf(ProjectFileRewriteRollbackError)
      expect(await readFile(source, "utf8")).toBe(concurrent)
      expect(await readFile(movedReplacement, "utf8")).toBe(replacement)
      expect(await readdir(paths.projectRoot)).toEqual(
        expect.arrayContaining([expect.stringContaining(".opencode-debug-mode-rewrite-backup-")]),
      )
    }))

  it("quarantines failed creation cleanup without deleting a concurrent replacement", () =>
    withTempProject(async ({ paths }) => {
      const target = path.join(paths.projectRoot, "debug-transport.mjs")
      const movedCreated = path.join(paths.projectRoot, "moved-created-helper.mjs")
      const created = "export const owned = true\n"
      const concurrent = "export const concurrent = true\n"
      const fixtureSource = path.join(paths.projectRoot, "source.ts")
      await writeFile(fixtureSource, "export {}\n")
      const prototype = await writableFileHandlePrototype(fixtureSource)
      const originalSync = prototype.sync
      vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
        if ((await this.stat()).isDirectory()) {
          await rename(target, movedCreated)
          await writeFile(target, concurrent)
          throw new Error("injected creation directory sync failure")
        }
        return originalSync.call(this)
      })

      await expect(createCanonicalProjectFile(paths.projectRoot, target, created)).rejects.toMatchObject({
        code: "CLEANUP_PARTIAL",
        details: { path: target },
      })
      expect(await readFile(target, "utf8")).toBe(concurrent)
      expect(await readFile(movedCreated, "utf8")).toBe(created)
    }))

  it("removes an exact owned file through quarantine without leaving temporary entries", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "debug-transport.mjs")
      const content = Buffer.from("owned helper\n")
      await writeFile(source, content)

      await expect(
        removeExactCanonicalProjectFile(
          paths.projectRoot,
          source,
          createHash("sha256").update(content).digest("hex"),
          content.byteLength,
        ),
      ).resolves.toBe("success")
      await expect(readdir(paths.projectRoot)).resolves.not.toEqual(
        expect.arrayContaining([expect.stringContaining(".opencode-debug-mode-delete-")]),
      )
      await expect(readFile(source, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }))
})
