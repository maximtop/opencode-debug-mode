import { writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { ProbeRegistry } from "../../src/probes/registry.js"
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
      const registry = new ProbeRegistry(store, paths.projectRoot, async (id) => id === "hyp_A")
      const probe = await registry.plan({
        runId: "run_A",
        hypothesisId: "hyp_A",
        sourceFile: "example.ts",
        sourceLine: 1,
        message: "value",
        captures: [{ label: "value", path: "value.current" }],
        transport: "process",
        sampling: { mode: "every", n: 1 },
      })
      expect(probe.id).toMatch(/^probe_/)

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
      await writeFile(source, `${probe.markerBlock}\n`)
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
    }))
})
