import { createHash } from "node:crypto"
import { readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ProbeRegistry } from "../../src/probes/registry.js"
import { removeOwnedProbe } from "../../src/probes/remove.js"
import { createInitialManifest, ManifestStore } from "../../src/session/manifest-store.js"
import { withTempProject } from "../helpers/temp-project.js"

describe("probe registry", () => {
  it("accepts only safe capture paths in project-contained JS/TS files", () =>
    withTempProject(async ({ paths }) => {
      const source = `${paths.projectRoot}/example.ts`
      await writeFile(source, "export const value = 1\n")
      const store = new ManifestStore(paths.manifestFile)
      const manifest = createInitialManifest({
        sessionId: "session_A",
        trustedSessionHash: "a".repeat(64),
        projectRoot: paths.projectRoot,
        sessionDir: paths.sessionDir,
        now: "2026-07-13T00:00:00.000Z",
      })
      await store.create({
        ...manifest,
        runs: [
          {
            id: "run_A",
            label: "pre-fix",
            reproduction: "test",
            status: "running",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
      })
      const registry = new ProbeRegistry(store, paths.projectRoot, async (id) =>
        id === "hyp_A" ? "a".repeat(64) : undefined,
      )
      const probe = await registry.plan({
        runId: "run_A",
        hypothesisId: "hyp_A",
        sourceFile: "example.ts",
        sourceLine: 1,
        message: "value",
        captures: [{ label: "value", path: "observed.current" }],
        transport: "process",
        sampling: { mode: "every", n: 1 },
      })
      expect(probe.id).toMatch(/^probe_/)
      expect(probe.expectedHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(probe.markerEditHash).toBe(
        createHash("sha256")
          .update(JSON.stringify({ oldString: probe.markerEdit.oldString, newString: probe.markerEdit.newString }))
          .digest("hex"),
      )
      expect(probe.markerEdit).toEqual({
        filePath: source,
        oldString: "export const value = 1\n",
        newString: `${probe.markerBlock}\nexport const value = 1\n`,
      })
      expect(probe.sourceLineText).toBe("export const value = 1")
      expect(probe.sourceContext).toContainEqual({ line: 1, text: "export const value = 1" })

      await expect(
        registry.plan({
          runId: "run_missing",
          hypothesisId: "hyp_A",
          sourceFile: "example.ts",
          sourceLine: 1,
          message: "missing run",
          captures: [],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        }),
      ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" })
      await expect(
        registry.plan({
          runId: "run_A",
          hypothesisId: "hyp_missing",
          sourceFile: "example.ts",
          sourceLine: 1,
          message: "missing hypothesis",
          captures: [],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        }),
      ).rejects.toMatchObject({ code: "STATE_INVALID" })
      for (const invalid of [
        { sourceLine: 0, message: "value", sourceFile: "example.ts" },
        { sourceLine: 1, message: "", sourceFile: "example.ts" },
        { sourceLine: 1, message: "value", sourceFile: "example.py" },
        { sourceLine: 1, message: "value", sourceFile: "../outside.ts" },
      ]) {
        await expect(
          registry.plan({
            runId: "run_A",
            hypothesisId: "hyp_A",
            captures: [],
            transport: "process",
            sampling: { mode: "every", n: 1 },
            ...invalid,
          }),
        ).rejects.toBeDefined()
      }
      await expect(
        registry.plan({
          runId: "run_A",
          hypothesisId: "hyp_A",
          sourceFile: "example.ts",
          sourceLine: 1,
          message: "unsafe",
          captures: [{ label: "value", path: "value()" }],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_CAPTURE" })

      await expect(registry.register(probe.id)).rejects.toMatchObject({ code: "MARKER_MISSING" })
      await writeFile(source, `${probe.markerBlock}\n${probe.markerBlock}\n`)
      await expect(registry.register(probe.id)).rejects.toMatchObject({ code: "MARKER_MISMATCH" })
      await writeFile(source, `${probe.markerBlock}\nexport const value = 1\n`)
      await registry.register(probe.id)
      await expect(registry.requireValidatedForRun("run_A")).rejects.toMatchObject({ code: "PROBE_NOT_VALIDATED" })
      await expect(registry.validate(["probe_missing"])).rejects.toMatchObject({ code: "MARKER_MISMATCH" })
      await registry.validate([probe.id])
      await expect(registry.requireValidatedForRun("run_A")).resolves.toBeUndefined()

      const event = {
        schemaVersion: 1 as const,
        sessionId: "session_A",
        runId: "run_A",
        runLabel: "pre-fix" as const,
        hypothesisId: "hyp_A",
        probeId: probe.id,
        timestamp: "2026-07-13T00:00:00.000Z",
        message: "runtime",
        source: { file: "untrusted.ts", line: 999 },
        data: { value: 1 },
      }
      expect(await registry.validateEvent(event)).toMatchObject({ source: { file: "example.ts", line: 1 } })
      await expect(registry.validateEvent({ ...event, sessionId: "foreign" })).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
      })
      await expect(registry.remove(probe.id)).resolves.toMatchObject({
        status: "removed",
        validationStatus: "validated",
      })
    }))

  it("returns a unique native-EOL edit before the selected line and rejects interior blanks", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "repeated.ts")
      const original = [
        "function first(value: number) {",
        "  return value",
        "}",
        "function second(value: number) {",
        "  return value",
        "}",
        "",
      ].join("\r\n")
      await writeFile(source, original)
      const store = new ManifestStore(paths.manifestFile)
      const manifest = createInitialManifest({
        sessionId: "session_A",
        trustedSessionHash: "a".repeat(64),
        projectRoot: paths.projectRoot,
        sessionDir: paths.sessionDir,
        now: "2026-07-13T00:00:00.000Z",
      })
      await store.create({
        ...manifest,
        runs: [
          {
            id: "run_A",
            label: "pre-fix",
            reproduction: "test",
            status: "running",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
      })
      const registry = new ProbeRegistry(store, paths.projectRoot, async () => "a".repeat(64))
      const probe = await registry.plan({
        runId: "run_A",
        hypothesisId: "hyp_A",
        sourceFile: "repeated.ts",
        sourceLine: 5,
        sourceColumn: 12,
        message: "second return",
        captures: [{ label: "value", path: "value" }],
        transport: "process",
        sampling: { mode: "every", n: 1 },
      })

      expect(probe.sourceColumn).toBe(12)
      expect(probe.markerEdit.filePath).toBe(source)
      expect(original.split(probe.markerEdit.oldString)).toHaveLength(2)
      expect(probe.markerEdit.oldString).toContain("function second")
      expect(probe.markerEdit.newString.indexOf(probe.markerBlock)).toBeLessThan(
        probe.markerEdit.newString.indexOf("  return value"),
      )
      for (const value of [probe.markerBlock, probe.markerEdit.oldString, probe.markerEdit.newString]) {
        expect(value.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u)
      }
      const instrumented = original.replace(probe.markerEdit.oldString, probe.markerEdit.newString)
      expect(instrumented.indexOf(probe.markerBlock)).toBeGreaterThan(instrumented.indexOf("function second"))
      expect(instrumented.indexOf(probe.markerBlock)).toBeLessThan(instrumented.lastIndexOf("  return value"))
      await writeFile(source, instrumented)
      await expect(registry.register(probe.id)).resolves.toMatchObject({ status: "registered" })

      await writeFile(source, "const before = true\n\nconst after = true\n")
      await expect(
        registry.plan({
          runId: "run_A",
          hypothesisId: "hyp_A",
          sourceFile: "repeated.ts",
          sourceLine: 2,
          sourceColumn: 1,
          message: "blank boundary",
          captures: [],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        }),
      ).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("non-empty executable boundary"),
      })

      const callSource = [
        "async function load(customFilter: { filterDownloadPageUrl: string }) {",
        "  const downloadData = await FiltersDownloader.downloadWithRaw(",
        "    customFilter.filterDownloadPageUrl,",
        "    { force: true },",
        "  );",
        "  return downloadData",
        "}",
        "",
      ].join("\n")
      await writeFile(source, callSource)
      const callPlan = (sourceLine: number) =>
        registry.plan({
          runId: "run_A",
          hypothesisId: "hyp_A",
          sourceFile: "repeated.ts",
          sourceLine,
          message: "download result",
          captures: [{ label: "downloadData", path: "downloadData" }],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        })

      await expect(callPlan(5)).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("expression delimiter ("),
        action: expect.stringContaining("after the containing call"),
      })
      await expect(callPlan(2)).rejects.toMatchObject({
        code: "UNSAFE_CAPTURE",
        message: expect.stringContaining("before the selected declaration initializes it"),
      })

      const afterCall = await callPlan(6)
      const misplaced = callSource.replace("  );", `${afterCall.markerBlock}\n  );`)
      await writeFile(source, misplaced)
      await expect(registry.register(afterCall.id)).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("executable statement boundary"),
      })

      const callbackSource = [
        "async function load() {",
        "  await withDownload(",
        "    async () => {",
        "      const downloadData = await getDownload()",
        "      return downloadData",
        "    },",
        "  )",
        "}",
        "",
      ].join("\n")
      await writeFile(source, callbackSource)
      await expect(callPlan(5)).resolves.toMatchObject({ sourceLineText: "      return downloadData" })
    }))

  it("rejects non-executable markers, post-registration changes, and replaced source links", () =>
    withTempProject(async ({ root, paths }) => {
      const source = path.join(paths.projectRoot, "example.ts")
      const outside = path.join(path.dirname(root), "outside.ts")
      await Promise.all([writeFile(source, "export const value = 1\n"), writeFile(outside, "outside\n")])
      const store = new ManifestStore(paths.manifestFile)
      const manifest = createInitialManifest({
        sessionId: "session_A",
        trustedSessionHash: "a".repeat(64),
        projectRoot: paths.projectRoot,
        sessionDir: paths.sessionDir,
        now: "2026-07-13T00:00:00.000Z",
      })
      await store.create({
        ...manifest,
        runs: [
          {
            id: "run_A",
            label: "pre-fix",
            reproduction: "test",
            status: "running",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
      })
      const registry = new ProbeRegistry(store, paths.projectRoot, async () => "a".repeat(64))
      const plan = () =>
        registry.plan({
          runId: "run_A",
          hypothesisId: "hyp_A",
          sourceFile: "example.ts",
          sourceLine: 1,
          message: "value",
          captures: [],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        })

      const inTemplate = await plan()
      await writeFile(source, `const payload = \`before\n${inTemplate.markerBlock}\nafter\`\n`)
      await expect(registry.register(inTemplate.id)).rejects.toMatchObject({ code: "MARKER_MISMATCH" })
      await expect(registry.remove(inTemplate.id)).resolves.toMatchObject({
        status: "removed",
        validationStatus: "pending",
      })
      expect(await readFile(source, "utf8")).not.toContain("DEBUG-START")
      await expect(registry.remove(inTemplate.id)).resolves.toMatchObject({ status: "removed" })

      const executable = await plan()
      const sourceAtExecutablePlan = await readFile(source, "utf8")
      await writeFile(source, `${executable.markerBlock}\n${sourceAtExecutablePlan}`)
      await expect(registry.register(executable.id)).resolves.toMatchObject({ status: "registered" })
      await writeFile(
        source,
        `${executable.markerBlock.replace("void", "void /* changed */")}\n${sourceAtExecutablePlan}`,
      )
      await expect(registry.validate([executable.id])).rejects.toMatchObject({ code: "MARKER_MISSING" })

      const replaced = await plan()
      await writeFile(outside, `${replaced.markerBlock}\n`)
      await rm(source)
      await symlink(outside, source)
      await expect(registry.register(replaced.id)).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })
    }))

  it("keeps source and manifest active when helper-import removal preflight fails", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "background.ts")
      const helper = path.join(paths.projectRoot, "debug-transport.mjs")
      const helperContent = "export function __opencodeDebugEmit() {}\n"
      await Promise.all([writeFile(source, "export const value = 1\n"), writeFile(helper, helperContent)])
      const store = new ManifestStore(paths.manifestFile)
      const manifest = createInitialManifest({
        sessionId: "session_A",
        trustedSessionHash: "a".repeat(64),
        projectRoot: paths.projectRoot,
        sessionDir: paths.sessionDir,
        now: "2026-07-13T00:00:00.000Z",
      })
      await store.create({
        ...manifest,
        runs: [
          {
            id: "run_A",
            label: "pre-fix",
            reproduction: "test",
            status: "running",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
        ownedFiles: [
          {
            path: helper,
            sha256: createHash("sha256").update(helperContent).digest("hex"),
            bytes: Buffer.byteLength(helperContent),
            kind: "transport-helper",
          },
        ],
      })
      const registry = new ProbeRegistry(store, paths.projectRoot, async () => "b".repeat(64))
      const probe = await registry.plan({
        runId: "run_A",
        hypothesisId: "hyp_A",
        sourceFile: "background.ts",
        sourceLine: 1,
        message: "background boundary",
        captures: [],
        transport: "extension-background",
        sampling: { mode: "every", n: 1 },
      })
      if (probe.helperImportBlock === undefined) throw new Error("missing helper import fixture")
      await writeFile(source, `${probe.helperImportBlock}\n${probe.markerBlock}\nexport const value = 1\n`)
      await registry.register(probe.id)
      const changed = (await readFile(source, "utf8")).replace(
        "__opencodeDebugEmit as",
        "__opencodeDebugEmit as changed_",
      )
      await writeFile(source, changed)

      await expect(registry.remove(probe.id)).rejects.toMatchObject({ code: "MARKER_MISMATCH" })
      expect(await readFile(source, "utf8")).toBe(changed)
      expect((await store.read()).probes.find((candidate) => candidate.id === probe.id)).toMatchObject({
        status: "registered",
      })
    }))

  it("binds an indented marker to its declared executable source location", () =>
    withTempProject(async ({ paths }) => {
      const source = path.join(paths.projectRoot, "indented.ts")
      const original =
        "function first(value: number) {\n    return -value\n}\nfunction run(value: number) {\n    return value\n}\n"
      await writeFile(source, original)
      const store = new ManifestStore(paths.manifestFile)
      const manifest = createInitialManifest({
        sessionId: "session_A",
        trustedSessionHash: "a".repeat(64),
        projectRoot: paths.projectRoot,
        sessionDir: paths.sessionDir,
        now: "2026-07-13T00:00:00.000Z",
      })
      await store.create({
        ...manifest,
        runs: [
          {
            id: "run_A",
            label: "pre-fix",
            reproduction: "test",
            status: "running",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
      })
      const registry = new ProbeRegistry(store, paths.projectRoot, async () => "a".repeat(64))
      const probe = await registry.plan({
        runId: "run_A",
        hypothesisId: "hyp_A",
        sourceFile: "indented.ts",
        sourceLine: 5,
        message: "value",
        captures: [{ label: "value", path: "value" }],
        transport: "process",
        sampling: { mode: "every", n: 1 },
      })

      expect(probe.markerBlock.split("\n").every((line) => line.startsWith("    "))).toBe(true)
      expect(probe.insertionAnchor).toMatchObject({
        sourceOffset: original.indexOf("    return value"),
        indentedSourceOffset: original.indexOf("return value"),
        sourceSha256: createHash("sha256").update(original).digest("hex"),
      })
      expect(probe.sourceLineText).toBe("    return value")
      expect(probe.sourceContext).toContainEqual({ line: 5, text: "    return value" })

      const longLine = `const longValue = ${JSON.stringify("x".repeat(600))}`
      const contextSource = path.join(paths.projectRoot, "context.ts")
      await writeFile(contextSource, `${longLine}\r\nconst selected = 1\r\nconst after = 2\r\n`)
      const contextProbe = await registry.plan({
        runId: "run_A",
        hypothesisId: "hyp_A",
        sourceFile: "context.ts",
        sourceLine: 2,
        message: "selected",
        captures: [],
        transport: "process",
        sampling: { mode: "every", n: 1 },
      })
      expect(contextProbe.sourceLineText).toBe("const selected = 1")
      expect(contextProbe.sourceContext).toContainEqual({ line: 3, text: "const after = 2" })
      expect(contextProbe.sourceContext[0]?.text).toHaveLength(512)
      expect(contextProbe.sourceContext[0]?.text.endsWith("…")).toBe(true)
      expect((await store.read()).probes.find((candidate) => candidate.id === contextProbe.id)).not.toHaveProperty(
        "sourceContext",
      )

      const wrongLocation = original.replace("    return -value", `${probe.markerBlock}\n    return -value`)
      await writeFile(source, wrongLocation)
      await expect(registry.register(probe.id)).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("declared source location"),
        action: expect.stringContaining("debug_probe_remove"),
        details: {
          actualSourceLine: 2,
          actualSourceColumn: 1,
          sourceMatches: true,
        },
      })

      const correctLocation = original.replace("    return value", `${probe.markerBlock}\n    return value`)
      const minimalOwnedBlock = `${probe.markerBlock.slice(4)}\n    `
      await store.modify((value) => ({
        ...value,
        probes: value.probes.map((candidate) =>
          candidate.id === probe.id
            ? {
                ...candidate,
                expectedBlock: minimalOwnedBlock,
                expectedHash: createHash("sha256").update(minimalOwnedBlock).digest("hex"),
              }
            : candidate,
        ),
      }))
      await writeFile(source, correctLocation)
      await expect(registry.register(probe.id)).resolves.toMatchObject({ status: "registered" })
      await writeFile(source, wrongLocation)
      await expect(registry.validate([probe.id])).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("declared source location"),
      })
      await writeFile(source, correctLocation)
      await expect(registry.validate([probe.id])).resolves.toBeUndefined()
      await expect(
        registry.plan({
          runId: "run_A",
          hypothesisId: "hyp_A",
          sourceFile: "indented.ts",
          sourceLine: 99,
          message: "out of range",
          captures: [],
          transport: "process",
          sampling: { mode: "every", n: 1 },
        }),
      ).rejects.toMatchObject({ code: "MARKER_MISMATCH" })
    }))

  it("binds background transports in each probed module and reserves helperSourceFile for content scripts", () =>
    withTempProject(async ({ paths }) => {
      const sourceA = `${paths.projectRoot}/source-a.ts`
      const sourceB = `${paths.projectRoot}/source-b.ts`
      const contentSource = `${paths.projectRoot}/content.ts`
      const background = `${paths.projectRoot}/background.ts`
      const helper = `${paths.projectRoot}/debug-transport.mjs`
      await Promise.all([
        writeFile(sourceA, "export const valueA = 1\n"),
        writeFile(sourceB, "export const valueB = 2\n"),
        writeFile(contentSource, "export const contentValue = 3\n"),
        writeFile(background, "export const loaded = true\n"),
        writeFile(helper, "export function __opencodeDebugEmit() {}\n"),
      ])
      const store = new ManifestStore(paths.manifestFile)
      const manifest = createInitialManifest({
        sessionId: "session_A",
        trustedSessionHash: "a".repeat(64),
        projectRoot: paths.projectRoot,
        sessionDir: paths.sessionDir,
        now: "2026-07-13T00:00:00.000Z",
      })
      await store.create({
        ...manifest,
        runs: [
          {
            id: "run_A",
            label: "pre-fix",
            reproduction: "test",
            status: "running",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
        ownedFiles: [{ path: helper, sha256: "b".repeat(64), bytes: 43, kind: "transport-helper" }],
      })
      const registry = new ProbeRegistry(store, paths.projectRoot, async () => "c".repeat(64))
      const base = {
        runId: "run_A",
        sourceLine: 1,
        captures: [] as Array<{ label: string; path: string }>,
        sampling: { mode: "every" as const, n: 1 },
      }

      await expect(
        registry.plan({
          ...base,
          hypothesisId: "hyp_wrong_source",
          sourceFile: "source-a.ts",
          helperSourceFile: "background.ts",
          message: "wrong helper module",
          transport: "extension-background",
        }),
      ).rejects.toMatchObject({
        code: "STATE_INVALID",
        action: expect.stringContaining("without helperSourceFile"),
      })

      const probeA = await registry.plan({
        ...base,
        hypothesisId: "hyp_A",
        sourceFile: "source-a.ts",
        message: "source A",
        transport: "extension-background",
      })
      const probeB = await registry.plan({
        ...base,
        hypothesisId: "hyp_B",
        sourceFile: "source-b.ts",
        message: "source B",
        transport: "extension-background",
      })
      expect(probeA.helperSourceFile).toBe(sourceA)
      expect(probeB.helperSourceFile).toBe(sourceB)
      expect(probeA.helperImportBlock).toContain('from "./debug-transport.mjs"')
      expect(probeB.helperImportBlock).toContain('from "./debug-transport.mjs"')
      expect(probeA.helperImportBlock?.endsWith("\n")).toBe(false)
      expect(probeB.helperImportBlock?.endsWith("\n")).toBe(false)
      expect(probeA.helperImportHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(probeB.helperImportHash).toMatch(/^[a-f0-9]{64}$/u)
      await writeFile(sourceA, `${probeA.helperImportBlock}\n${probeA.markerBlock}\nexport const valueA = 1\n`)
      await writeFile(sourceB, `${probeB.helperImportBlock}\n${probeB.markerBlock}\nexport const valueB = 2\n`)
      expect((await readFile(sourceA, "utf8")).split("\n").indexOf(probeA.markerStart) + 1).toBeGreaterThan(
        probeA.sourceLine,
      )
      await expect(registry.register(probeA.id)).resolves.toMatchObject({ status: "registered" })
      await expect(registry.register(probeB.id)).resolves.toMatchObject({ status: "registered" })

      await expect(
        registry.plan({
          ...base,
          hypothesisId: "hyp_content_missing",
          sourceFile: "content.ts",
          message: "content listener",
          transport: "extension-content",
        }),
      ).rejects.toMatchObject({ code: "STATE_INVALID" })
      await writeFile(`${paths.projectRoot}/legacy.cjs`, "module.exports = {}\n")
      await expect(
        registry.plan({
          ...base,
          hypothesisId: "hyp_cjs",
          sourceFile: "legacy.cjs",
          message: "legacy browser module",
          transport: "extension-background",
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_LANGUAGE" })
      const contentProbe = await registry.plan({
        ...base,
        hypothesisId: "hyp_content",
        sourceFile: "content.ts",
        helperSourceFile: "background.ts",
        message: "content listener",
        transport: "extension-content",
      })
      expect(contentProbe.helperSourceFile).toBe(background)
      expect(contentProbe.markerBlock).toContain("chrome.runtime.sendMessage")
    }))

  it("uses unique emitter aliases for multiple background probes in one module and cleans them exactly", () =>
    withTempProject(async ({ paths }) => {
      const source = `${paths.projectRoot}/shared.ts`
      const helper = `${paths.projectRoot}/debug-transport.mjs`
      const original = "export {}\n"
      await Promise.all([writeFile(source, original), writeFile(helper, "export function __opencodeDebugEmit() {}\n")])
      const store = new ManifestStore(paths.manifestFile)
      const manifest = createInitialManifest({
        sessionId: "session_A",
        trustedSessionHash: "a".repeat(64),
        projectRoot: paths.projectRoot,
        sessionDir: paths.sessionDir,
        now: "2026-07-13T00:00:00.000Z",
      })
      await store.create({
        ...manifest,
        runs: [
          {
            id: "run_A",
            label: "pre-fix",
            reproduction: "test",
            status: "running",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
        ownedFiles: [{ path: helper, sha256: "b".repeat(64), bytes: 43, kind: "transport-helper" }],
      })
      const registry = new ProbeRegistry(store, paths.projectRoot, async () => "c".repeat(64))
      const base = {
        runId: "run_A",
        sourceFile: "shared.ts",
        sourceLine: 1,
        captures: [] as Array<{ label: string; path: string }>,
        transport: "extension-background" as const,
        sampling: { mode: "every" as const, n: 1 },
      }
      const [probeA, probeB] = await Promise.all([
        registry.plan({
          ...base,
          hypothesisId: "hyp_A",
          message: "first boundary",
        }),
        registry.plan({
          ...base,
          hypothesisId: "hyp_B",
          message: "second boundary",
        }),
      ])
      const aliasA = probeA.helperImportBlock?.match(/\bas\s+([A-Za-z_$][\w$]*)/u)?.[1]
      const aliasB = probeB.helperImportBlock?.match(/\bas\s+([A-Za-z_$][\w$]*)/u)?.[1]
      expect(aliasA).toMatch(/^__opencodeDebugEmit_[a-f0-9]{12}$/u)
      expect(aliasB).toMatch(/^__opencodeDebugEmit_[a-f0-9]{12}$/u)
      expect(aliasA).not.toBe(aliasB)
      expect(probeA.markerBlock).toContain(`void ${aliasA}(`)
      expect(probeB.markerBlock).toContain(`void ${aliasB}(`)

      await writeFile(
        source,
        `${probeA.helperImportBlock}${probeA.markerBlock}${probeB.helperImportBlock}${probeB.markerBlock}${original}`,
      )
      const [registeredA, registeredB] = await Promise.all([registry.register(probeA.id), registry.register(probeB.id)])
      await expect(removeOwnedProbe(registeredA)).resolves.toMatchObject({ status: "success" })
      await expect(removeOwnedProbe(registeredB)).resolves.toMatchObject({ status: "success" })
      expect(await readFile(source, "utf8")).toBe(original)
    }))
})
