import { createHash } from "node:crypto"
import { type FileHandle, mkdir, open, readFile, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  canonicalProjectFileExists,
  createCanonicalProjectFile,
  readCanonicalProjectFile,
  removeExactCanonicalProjectFile,
  rewriteCanonicalProjectFile,
  sourceCodeContextAt,
} from "../../src/probes/source-safety.js"
import { withTempProject } from "../helpers/temp-project.js"

afterEach(() => {
  vi.restoreAllMocks()
})

async function fileHandlePrototype(filename: string): Promise<FileHandle> {
  const handle = await open(filename, "r+")
  const prototype = Object.getPrototypeOf(handle) as FileHandle
  await handle.close()
  return prototype
}

describe("probe source safety edge coverage", () => {
  it("creates a canonical nested file exactly once and reports its existence", () =>
    withTempProject(async ({ paths }) => {
      const filename = path.join(paths.projectRoot, "private", "nested", "transport.mjs")
      const content = new TextEncoder().encode("export const token = 'redacted'\n")

      await expect(canonicalProjectFileExists(paths.projectRoot, filename)).resolves.toBe(false)
      await expect(createCanonicalProjectFile(paths.projectRoot, filename, content, 0o640)).resolves.toBeUndefined()
      await expect(canonicalProjectFileExists(paths.projectRoot, filename)).resolves.toBe(true)
      await expect(readCanonicalProjectFile(paths.projectRoot, filename)).resolves.toBe(
        new TextDecoder().decode(content),
      )
      expect((await stat(filename)).mode & 0o777).toBe(0o640)

      await expect(createCanonicalProjectFile(paths.projectRoot, filename, "replacement\n")).rejects.toMatchObject({
        code: "EEXIST",
      })
      await expect(readFile(filename, "utf8")).resolves.toBe(new TextDecoder().decode(content))
    }))

  it("rejects paths outside the project and non-directory parent components", () =>
    withTempProject(async ({ root, paths }) => {
      const outside = path.join(root, "..", "outside.ts")
      await expect(canonicalProjectFileExists(paths.projectRoot, outside)).rejects.toMatchObject({
        code: "HELPER_PATH_UNSAFE",
      })

      const parentFile = path.join(paths.projectRoot, "not-a-directory")
      await writeFile(parentFile, "ordinary file\n")
      await expect(
        createCanonicalProjectFile(paths.projectRoot, path.join(parentFile, "transport.mjs"), "owned\n"),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })

      const leafDirectory = path.join(paths.projectRoot, "source.ts")
      await mkdir(leafDirectory)
      await expect(canonicalProjectFileExists(paths.projectRoot, leafDirectory)).rejects.toMatchObject({
        code: "HELPER_PATH_UNSAFE",
      })
    }))

  it("maps a requested symlink-root path onto the canonical project without following leaf links", () =>
    withTempProject(async ({ root, paths }) => {
      const alias = path.join(root, "project-alias")
      await symlink(paths.projectRoot, alias, "dir")
      const requested = path.join(alias, "generated", "transport.mjs")
      const canonical = path.join(paths.projectRoot, "generated", "transport.mjs")

      await createCanonicalProjectFile(alias, requested, "owned helper\n")

      await expect(readFile(canonical, "utf8")).resolves.toBe("owned helper\n")
      await expect(readCanonicalProjectFile(alias, requested)).resolves.toBe("owned helper\n")
    }))

  it("cleans up a newly created file when durable creation fails", () =>
    withTempProject(async ({ paths }) => {
      const seed = path.join(paths.projectRoot, "seed.ts")
      const filename = path.join(paths.projectRoot, "generated", "transport.mjs")
      await writeFile(seed, "seed\n")
      const prototype = await fileHandlePrototype(seed)
      vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("injected create sync failure"))

      await expect(createCanonicalProjectFile(paths.projectRoot, filename, "secret\n")).rejects.toThrow(
        "injected create sync failure",
      )
      await expect(canonicalProjectFileExists(paths.projectRoot, filename)).resolves.toBe(false)
    }))

  it("returns closed-world removal outcomes without changing unowned content", () =>
    withTempProject(async ({ paths }) => {
      const filename = path.join(paths.projectRoot, "transport.mjs")
      const content = Buffer.from("user-owned content\n")
      const correctHash = createHash("sha256").update(content).digest("hex")

      await expect(
        removeExactCanonicalProjectFile(paths.projectRoot, filename, correctHash, content.byteLength),
      ).resolves.toBe("already-clean")
      await writeFile(filename, content)
      await expect(
        removeExactCanonicalProjectFile(paths.projectRoot, filename, correctHash, content.byteLength + 1),
      ).resolves.toBe("content-mismatch")
      await expect(
        removeExactCanonicalProjectFile(paths.projectRoot, filename, "0".repeat(64), content.byteLength),
      ).resolves.toBe("content-mismatch")
      await expect(readFile(filename)).resolves.toEqual(content)
    }))

  it("does not rewrite when the caller's expected source is stale", () =>
    withTempProject(async ({ paths }) => {
      const filename = path.join(paths.projectRoot, "source.ts")
      await writeFile(filename, "export const current = true\n")

      await expect(
        rewriteCanonicalProjectFile(
          paths.projectRoot,
          filename,
          "export const stale = true\n",
          "export const replacement = true\n",
        ),
      ).resolves.toBe(false)
      await expect(readFile(filename, "utf8")).resolves.toBe("export const current = true\n")
    }))

  it("rolls back when a positional write makes no progress", () =>
    withTempProject(async ({ paths }) => {
      const filename = path.join(paths.projectRoot, "source.ts")
      const original = "export const original = true\n"
      await writeFile(filename, original)
      const prototype = await fileHandlePrototype(filename)
      const originalWrite = prototype.write
      vi.spyOn(prototype, "write")
        .mockImplementationOnce(async function (
          this: FileHandle,
          buffer: Uint8Array,
        ): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
          return { bytesWritten: 0, buffer }
        } as typeof originalWrite)
        .mockImplementation(function (this: FileHandle, ...args: Parameters<FileHandle["write"]>) {
          return Reflect.apply(originalWrite, this, args)
        } as FileHandle["write"])

      await expect(
        rewriteCanonicalProjectFile(paths.projectRoot, filename, original, "export const replacement = false\n"),
      ).rejects.toThrow("Project file write made no progress")
      await expect(readFile(filename, "utf8")).resolves.toBe(original)
    }))

  it("leaves source untouched when staged rewrite durability fails before commit", () =>
    withTempProject(async ({ paths }) => {
      const filename = path.join(paths.projectRoot, "source.ts")
      const original = "export const original = true\n"
      await writeFile(filename, original)
      const prototype = await fileHandlePrototype(filename)
      vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("injected rewrite sync failure"))

      await expect(
        rewriteCanonicalProjectFile(paths.projectRoot, filename, original, "export const replacement = false\n"),
      ).rejects.toThrow("injected rewrite sync failure")
      await expect(readFile(filename, "utf8")).resolves.toBe(original)
    }))

  it("scans completed lexical constructs and nested template expressions", () => {
    const templateExpression = ["  const template = `prefix $", "{(() => { return { nested: 1 } })()} tail`;\n"].join(
      "",
    )
    const completed = [
      "// line comment closes\n",
      "/* block comment closes */\n",
      `${String.raw`const single = 'escaped \' quote';`}\n`,
      `${String.raw`const double = "escaped \" quote";`}\n`,
      `${String.raw`const expression = /[a/]+\//giu.test(single);`}\n`,
      "const number = 12.34;\n",
      "const escapedTemplate = `escaped \\x tail`;\n",
      "async function run() {\n",
      "  await /value/u;\n",
      templateExpression,
      "  return expression ? number : 0;\n",
      "}\n",
    ].join("")

    expect(sourceCodeContextAt(completed, completed.length)).toEqual({ inCode: true, braceDepth: 0 })
    expect(sourceCodeContextAt("const value = [1]", "const value = [1]".length)).toEqual({
      inCode: true,
      braceDepth: 0,
    })
  })

  it("treats invalid offsets and unterminated lexical constructs as non-code", () => {
    expect(sourceCodeContextAt("code", -1)).toEqual({ inCode: false, braceDepth: 0 })
    expect(sourceCodeContextAt("code", 5)).toEqual({ inCode: false, braceDepth: 0 })
    expect(sourceCodeContextAt("code", 0.5)).toEqual({ inCode: false, braceDepth: 0 })
    for (const source of ["'unterminated", '"unterminated', "`unterminated", "/* unterminated", "/[unterminated/"]) {
      expect(sourceCodeContextAt(source, source.length).inCode).toBe(false)
    }
  })
})
