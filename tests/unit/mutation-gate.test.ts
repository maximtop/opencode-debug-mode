import { createHash } from "node:crypto"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { enforceDebugMutationGate, recordBehavioralMutation } from "../../src/investigation/mutation-guard.js"
import { pluginHarness } from "../helpers/factories.js"
import { FakeClock } from "../helpers/fake-clock.js"
import { withTempProject } from "../helpers/temp-project.js"

function parse(value: unknown) {
  return JSON.parse(value as string) as {
    ok: boolean
    // biome-ignore lint/suspicious/noExplicitAny: lifecycle envelopes vary by tool and are asserted at each use site.
    data: Record<string, any>
    error?: { code: string; message: string }
  }
}

describe("debug mutation gate", () => {
  it("records behavioral mutation timestamps from the injected clock", async () => {
    const clock = new FakeClock("2026-07-15T10:00:00.000Z")
    let manifest = {
      fixStartedAt: undefined as string | undefined,
      lastBehavioralMutationAt: undefined as string | undefined,
      behavioralRevision: 0,
      behavioralMutations: [] as Array<Record<string, unknown>>,
    }
    const session = {
      projectRoot: "/workspace/project",
      directory: "/workspace/project/packages/app",
      investigationStore: { read: vi.fn().mockResolvedValue({ phase: "fixing" }) },
      manifestStore: {
        modify: vi.fn(async (mutate: (value: typeof manifest) => typeof manifest) => {
          manifest = mutate(structuredClone(manifest))
          return manifest
        }),
      },
    }
    const registry = { requireOwned: vi.fn().mockResolvedValue(session) }

    await recordBehavioralMutation({
      registry: registry as never,
      sessionID: "clock-session",
      tool: "edit",
      args: { filePath: "src.ts" },
      clock,
    })
    clock.advance(2_500)
    await recordBehavioralMutation({
      registry: registry as never,
      sessionID: "clock-session",
      tool: "apply_patch",
      args: { patch: "*** Update File: src.ts" },
      clock,
    })

    expect(manifest).toMatchObject({
      fixStartedAt: "2026-07-15T10:00:00.000Z",
      lastBehavioralMutationAt: "2026-07-15T10:00:02.500Z",
      behavioralRevision: 2,
      behavioralMutations: [
        { revision: 1, completedAt: "2026-07-15T10:00:00.000Z" },
        { revision: 2, completedAt: "2026-07-15T10:00:02.500Z" },
      ],
    })
  })

  it("authorizes an owned probe edit relative to a nested OpenCode directory", () =>
    withTempProject(async ({ paths }) => {
      const expectedBlock = "/* DEBUG-START fixture */\nvoid observed\n/* DEBUG-END fixture */\n"
      const directory = path.join(paths.projectRoot, "packages/app")
      const sourceFile = path.join(directory, "src.ts")
      await mkdir(directory, { recursive: true })
      await writeFile(sourceFile, "const observed = 1\n")
      const session = {
        projectRoot: paths.projectRoot,
        directory,
        investigationStore: { read: vi.fn().mockResolvedValue({ phase: "instrumenting" }) },
        manifestStore: {
          read: vi.fn().mockResolvedValue({
            probes: [{ status: "planned", sourceFile, expectedBlock }],
          }),
        },
      }

      await expect(
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "nested-session",
          tool: "edit",
          args: {
            filePath: "src.ts",
            oldString: "const observed = 1\n",
            newString: `const observed = 1\n${expectedBlock}`,
          },
        }),
      ).resolves.toBeUndefined()
    }))

  it("requires the prepared canonical marker edit and blocks wrong placement before writing", () =>
    withTempProject(async ({ paths }) => {
      const expectedBlock = "/* DEBUG-START fixture */\nvoid observed\n/* DEBUG-END fixture */"
      const sourceFile = path.join(paths.projectRoot, "src.ts")
      const sourceLine = "return observed"
      const canonicalEdit = {
        oldString: sourceLine,
        newString: `${expectedBlock}\n${sourceLine}`,
      }
      const markerEditHash = createHash("sha256")
        .update(JSON.stringify({ oldString: canonicalEdit.oldString, newString: canonicalEdit.newString }))
        .digest("hex")
      await writeFile(sourceFile, `const observed = 1\n${sourceLine}\n`)
      const session = {
        projectRoot: paths.projectRoot,
        directory: paths.projectRoot,
        investigationStore: { read: vi.fn().mockResolvedValue({ phase: "instrumenting" }) },
        manifestStore: {
          read: vi.fn().mockResolvedValue({
            probes: [{ id: "probe-canonical", status: "planned", sourceFile, expectedBlock, markerEditHash }],
          }),
        },
      }
      const enforce = (edit: { oldString: string; newString: string }) =>
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "canonical-session",
          tool: "edit",
          args: { filePath: sourceFile, ...edit },
        })

      await expect(enforce(canonicalEdit)).resolves.toBeUndefined()
      await expect(
        enforce({ oldString: sourceLine, newString: `${sourceLine}\n${expectedBlock}` }),
      ).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("does not match its prepared insertion boundary"),
        action: expect.stringMatching(/invoke the markerEdit returned by debug_probe_prepare verbatim/iu),
        details: {
          probeId: "probe-canonical",
          blockField: "markerEdit",
          canonicalEditRequired: true,
        },
      })
    }))

  it("classifies distorted planned ownership blocks without matching unrelated surrounding content", () =>
    withTempProject(async ({ paths }) => {
      const expectedBlock =
        "/* DEBUG-START opencode-debug-mode probe=probe-distorted */\nvoid observed\n/* DEBUG-END opencode-debug-mode probe=probe-distorted */"
      const helperImportBlock =
        '/* DEBUG-START opencode-debug-mode probe=probe-distorted resource=transport-import */\nimport { emit } from "./transport.mjs"\n/* DEBUG-END opencode-debug-mode probe=probe-distorted resource=transport-import */'
      const sourceFile = path.join(paths.projectRoot, "src.ts")
      const original = "const observed = 1\n"
      await writeFile(sourceFile, original)
      const session = {
        projectRoot: paths.projectRoot,
        directory: paths.projectRoot,
        investigationStore: { read: vi.fn().mockResolvedValue({ phase: "instrumenting" }) },
        manifestStore: {
          read: vi.fn().mockResolvedValue({
            probes: [
              {
                id: "probe-distorted",
                status: "planned",
                sourceFile,
                expectedBlock,
                helperSourceFile: sourceFile,
                helperImportBlock,
              },
            ],
          }),
        },
      }
      const enforce = (oldString: string, newString: string) =>
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "distorted-session",
          tool: "edit",
          args: { filePath: sourceFile, oldString, newString },
        })

      await expect(
        enforce(original, `${original}${expectedBlock.replace("void observed", "  void observed")}`),
      ).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        action: expect.stringMatching(/blocked before writing.*byte-for-byte.*never retype, reindent/iu),
        details: { probeId: "probe-distorted", blockField: "markerBlock" },
      })
      await expect(
        enforce(original, `${original}${helperImportBlock.replace('"./transport.mjs"', "'./transport.mjs'")}`),
      ).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        details: { probeId: "probe-distorted", blockField: "helperImportBlock" },
      })
      await expect(
        enforce(
          "await download();\n\n            \n            finish();",
          `await download();\n\n${expectedBlock}\n\n            finish();`,
        ),
      ).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
        message: expect.stringContaining("changed surrounding whitespace"),
        action: expect.stringMatching(/preserve oldString byte-for-byte.*inserting only the exact markerBlock/iu),
        details: {
          probeId: "probe-distorted",
          blockField: "markerBlock",
          surroundingBytesChanged: true,
        },
      })
      await expect(enforce(expectedBlock, `${expectedBlock}\nconst behavior = 2`)).rejects.toMatchObject({
        code: "INVALID_PHASE",
      })
    }))

  it("rejects owned instrumentation when the planned source was replaced by a symlink", () =>
    withTempProject(async ({ root, paths }) => {
      const sourceFile = path.join(paths.projectRoot, "source.ts")
      const outside = path.join(path.dirname(root), "outside.ts")
      const expectedBlock = "/* DEBUG-START fixture */\nvoid observed\n/* DEBUG-END fixture */"
      await Promise.all([writeFile(sourceFile, "const observed = 1\n"), writeFile(outside, "outside\n")])
      await rm(sourceFile)
      await symlink(outside, sourceFile)
      const session = {
        projectRoot: paths.projectRoot,
        directory: paths.projectRoot,
        investigationStore: { read: vi.fn().mockResolvedValue({ phase: "instrumenting" }) },
        manifestStore: {
          read: vi.fn().mockResolvedValue({
            probes: [{ status: "planned", sourceFile, expectedBlock }],
          }),
        },
      }

      await expect(
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "symlink-session",
          tool: "edit",
          args: {
            filePath: sourceFile,
            oldString: "outside\n",
            newString: `outside\n${expectedBlock}`,
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    }))

  it("authorizes exact owned instrumentation with insertion-adjacent blank lines", () =>
    withTempProject(async ({ paths }) => {
      const helperImportBlock =
        '/* DEBUG-START fixture resource=transport-import */\nimport { emit } from "./transport.mjs"\n/* DEBUG-END fixture resource=transport-import */\n'
      const sourceFile = path.join(paths.projectRoot, "src.ts")
      let manifest = {
        probes: [
          {
            id: "probe-whitespace",
            status: "planned",
            sourceFile,
            expectedBlock: "/* DEBUG-START fixture */\nvoid emit()\n/* DEBUG-END fixture */\n",
            helperSourceFile: sourceFile,
            helperImportBlock,
          },
        ],
      }
      const session = {
        projectRoot: paths.projectRoot,
        directory: paths.projectRoot,
        investigationStore: { read: vi.fn().mockResolvedValue({ phase: "instrumenting" }) },
        manifestStore: {
          read: vi.fn(async () => structuredClone(manifest)),
          modify: vi.fn(async (mutate: (value: typeof manifest) => typeof manifest) => {
            manifest = mutate(structuredClone(manifest))
            return structuredClone(manifest)
          }),
        },
      }
      const original = "import { existing } from './existing.js'"
      await writeFile(sourceFile, original)

      await expect(
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "whitespace-session",
          tool: "edit",
          args: {
            filePath: sourceFile,
            oldString: original,
            newString: `${original}\n\n${helperImportBlock}`,
          },
        }),
      ).resolves.toBeUndefined()

      await recordBehavioralMutation({
        registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
        sessionID: "whitespace-session",
        tool: "edit",
        args: {
          filePath: sourceFile,
          oldString: original,
          newString: `${original}\n\n${helperImportBlock}`,
        },
        clock: new FakeClock("2026-07-15T10:00:00.000Z"),
      })

      expect(manifest.probes[0]?.helperImportBlock).toBe(`\n\n${helperImportBlock}`)
      expect(manifest.probes[0] as Record<string, unknown>).toMatchObject({
        helperImportBlockIsExactInsertion: true,
      })

      await expect(
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "whitespace-session",
          tool: "edit",
          args: {
            filePath: sourceFile,
            oldString: original,
            newString: `${original}\nconst behavioralChange = true\n${helperImportBlock}`,
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    }))

  it("authorizes an indented owned marker when edit shares its leading indentation", () =>
    withTempProject(async ({ paths }) => {
      const sourceFile = path.join(paths.projectRoot, "src.ts")
      const expectedBlock = "        /* DEBUG-START fixture */\n        void emit()\n        /* DEBUG-END fixture */"
      const original = "        const value = await load();\n\n        if (value) {"
      const instrumented = `        const value = await load();\n\n${expectedBlock}\n\n        if (value) {`
      let manifest = {
        probes: [
          {
            id: "probe-indented",
            status: "planned",
            sourceFile,
            expectedBlock,
            expectedHash: createHash("sha256").update(expectedBlock).digest("hex"),
          },
        ],
      }
      const session = {
        projectRoot: paths.projectRoot,
        directory: paths.projectRoot,
        investigationStore: { read: vi.fn().mockResolvedValue({ phase: "instrumenting" }) },
        manifestStore: {
          read: vi.fn(async () => structuredClone(manifest)),
          modify: vi.fn(async (mutate: (value: typeof manifest) => typeof manifest) => {
            manifest = mutate(structuredClone(manifest))
            return structuredClone(manifest)
          }),
        },
      }
      await writeFile(sourceFile, original)
      const args = { filePath: sourceFile, oldString: original, newString: instrumented }

      await expect(
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "indented-session",
          tool: "edit",
          args,
        }),
      ).resolves.toBeUndefined()

      await recordBehavioralMutation({
        registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
        sessionID: "indented-session",
        tool: "edit",
        args,
        clock: new FakeClock("2026-07-15T10:00:00.000Z"),
      })

      expect(manifest.probes[0]?.expectedBlock).toBe(`${expectedBlock.slice(8)}\n\n        `)
      expect(manifest.probes[0] as Record<string, unknown>).toMatchObject({
        expectedBlockIsExactInsertion: true,
      })
      expect(instrumented.replace(manifest.probes[0]?.expectedBlock ?? "", "")).toBe(original)
    }))

  it("authorizes and records a contiguous batch of planned owned blocks in one edit", () =>
    withTempProject(async ({ paths }) => {
      const sourceFile = path.join(paths.projectRoot, "src.ts")
      const helperA =
        "/* DEBUG-START helper-a */\nimport { emit as emitA } from './transport.mjs'\n/* DEBUG-END helper-a */"
      const helperB =
        "/* DEBUG-START helper-b */\nimport { emit as emitB } from './transport.mjs'\n/* DEBUG-END helper-b */"
      let manifest = {
        probes: [
          {
            id: "probe-a",
            status: "planned",
            sourceFile,
            expectedBlock: "/* DEBUG-START probe-a */\nvoid emitA()\n/* DEBUG-END probe-a */",
            helperSourceFile: sourceFile,
            helperImportBlock: helperA,
          },
          {
            id: "probe-b",
            status: "planned",
            sourceFile,
            expectedBlock: "/* DEBUG-START probe-b */\nvoid emitB()\n/* DEBUG-END probe-b */",
            helperSourceFile: sourceFile,
            helperImportBlock: helperB,
          },
        ],
      }
      const session = {
        projectRoot: paths.projectRoot,
        directory: paths.projectRoot,
        investigationStore: { read: vi.fn().mockResolvedValue({ phase: "instrumenting" }) },
        manifestStore: {
          read: vi.fn(async () => structuredClone(manifest)),
          modify: vi.fn(async (mutate: (value: typeof manifest) => typeof manifest) => {
            manifest = mutate(structuredClone(manifest))
            return structuredClone(manifest)
          }),
        },
      }
      const original = "import { existing } from './existing.js'"
      await writeFile(sourceFile, original)
      const inserted = `\n${helperA}\n${helperB}`
      const args = {
        filePath: sourceFile,
        oldString: original,
        newString: `${original}${inserted}`,
      }

      await expect(
        enforceDebugMutationGate({
          registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
          evidenceFor: () => ({}) as never,
          sessionID: "batch-session",
          tool: "edit",
          args,
        }),
      ).resolves.toBeUndefined()
      await recordBehavioralMutation({
        registry: { requireOwned: vi.fn().mockResolvedValue(session) } as never,
        sessionID: "batch-session",
        tool: "edit",
        args,
        clock: new FakeClock("2026-07-15T10:00:00.000Z"),
      })

      expect(manifest.probes.map((probe) => probe.helperImportBlock).join("")).toBe(inserted)
      expect(manifest.probes).toEqual([
        expect.objectContaining({ helperImportHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ helperImportHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      ])
    }))

  it("blocks behavioral edits until a reproduced evidence-backed fix checkpoint", async () => {
    const harness = await pluginHarness()
    await harness.selectAgent("debug")
    await expect(harness.beforeTool("bash", { command: "printf bypass > src.ts" })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(harness.beforeTool("task", { prompt: "edit the file" })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(
      harness.beforeTool("multiedit", {
        edits: [{ filePath: "src.ts", oldString: "a", newString: "b" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    await expect(harness.beforeTool("patch", { filePath: "src.ts", patch: "a -> b" })).rejects.toMatchObject({
      code: "INVALID_PHASE",
    })
    await expect(
      harness.beforeTool("edit", {
        filePath: path.join(harness.projectRoot, "src.ts"),
        oldString: "a",
        newString: "b",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    expect(parse(await harness.executeTool("debug_session_start", { keepArtifacts: false })).ok).toBe(true)
    await expect(
      harness.beforeTool("edit", {
        filePath: path.join(harness.projectRoot, "src.ts"),
        oldString: "a",
        newString: "b",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const sourcePath = path.join(harness.projectRoot, "src.ts")
    const behaviorTestPath = path.join(harness.projectRoot, "behavior.test.mjs")
    await writeFile(sourcePath, "const observed = 1\n")
    await writeFile(
      behaviorTestPath,
      `import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
test("runtime value is corrected", async () => {
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.match(await readFile(new URL("./src.ts", import.meta.url), "utf8"), /observed = 2/u)
})
`,
    )
    const initial = parse(await harness.executeTool("debug_state_read", {})).data.state
    expect(
      parse(
        await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: initial.revision,
          state: {
            ...initial,
            problemSummary: "runtime value is wrong",
            expectedBehavior: "value is 2",
            actualBehavior: "value is 1",
            runtimeContext: { kind: "web", target: "fixture" },
            reproduction: { method: "load fixture", requiresUser: false, confirmed: null },
            successCriteria: ["value is 2"],
            phase: "hypotheses",
            hypotheses: [
              {
                id: "hyp_value",
                rank: 1,
                statement: "runtime value remains 1",
                confirmationSignals: ["probe reports 1"],
                eliminationSignals: ["probe reports another value"],
                status: "open",
                evidenceRefs: [],
              },
              {
                id: "hyp_timeout",
                rank: 2,
                statement: "the runtime capture times out",
                confirmationSignals: ["the supervised process times out"],
                eliminationSignals: ["the supervised process exits normally"],
                status: "open",
                evidenceRefs: [],
              },
            ],
            nextAction: "capture the runtime value",
          },
        }),
      ).ok,
    ).toBe(true)
    await harness.completeText(
      "## Working hypotheses\n1. hyp_value — runtime value remains 1. Confirmation: probe reports 1. Elimination: probe reports another value.\n2. hyp_timeout — the runtime capture times out. Confirmation: the supervised process times out. Elimination: the supervised process exits normally.",
    )
    const run = parse(
      await harness.executeTool("debug_run_start", {
        label: "pre-fix",
        reproduction: "load fixture",
        waitingForUser: false,
      }),
    )
    const hypothesesState = parse(await harness.executeTool("debug_state_read", {})).data.state
    expect(
      parse(
        await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: hypothesesState.revision,
          state: { ...hypothesesState, phase: "instrumenting" },
        }),
      ).ok,
    ).toBe(true)
    const collector = parse(
      await harness.executeTool("debug_collector_start", { runtime: "web", transportTargetPath: "transport.mjs" }),
    )
    expect(collector.error).toBeUndefined()
    const prepared = parse(
      await harness.executeTool("debug_probe_prepare", {
        runId: run.data.runId,
        hypothesisId: "hyp_value",
        sourceFile: "src.ts",
        sourceLine: 2,
        sourceColumn: 1,
        message: "observed value",
        captures: [{ label: "observed", path: "observed" }],
        transport: "http-web",
        sampling: { mode: "every", n: 1 },
      }),
    )
    expect(prepared.error).toBeUndefined()
    expect(prepared).toMatchObject({ ok: true })
    const original = await readFile(sourcePath, "utf8")
    const markerEdit = prepared.data.markerEdit as { filePath: string; oldString: string; newString: string }
    const withMarker = original.replace(markerEdit.oldString, markerEdit.newString)
    expect(withMarker).not.toBe(original)
    await expect(harness.beforeTool("edit", markerEdit)).resolves.toBeDefined()
    await writeFile(sourcePath, withMarker)
    await harness.afterTool("edit", {}, "session-A", "call-marker", markerEdit)
    const helperEdit = {
      filePath: sourcePath,
      oldString: withMarker,
      newString: `${prepared.data.helperImportBlock}${withMarker}`,
    }
    await expect(harness.beforeTool("edit", helperEdit)).resolves.toBeDefined()
    const instrumented = helperEdit.newString
    await writeFile(sourcePath, instrumented)
    await harness.afterTool("edit", {}, "session-A", "call-helper", helperEdit)
    expect(parse(await harness.executeTool("debug_probe_register", { probeId: prepared.data.probeId })).ok).toBe(true)
    const instrumentationCheck = parse(
      await harness.executeTool("debug_process_capture", {
        approvalClass: "local-deterministic",
        purpose: "instrumentation-check",
        probeIds: [prepared.data.probeId],
        executable: process.execPath,
        args: ["--check", sourcePath],
        cwd: harness.projectRoot,
        env: {},
        runId: run.data.runId,
        timeoutMs: 5_000,
      }),
    )
    expect(instrumentationCheck.error).toBeUndefined()
    expect(instrumentationCheck).toMatchObject({ ok: true })
    const helper = await readFile(path.join(harness.projectRoot, collector.data.helperPath), "utf8")
    const authorizationLiteral = /const authorization = ("[^"]+")/u.exec(helper)?.[1]
    expect(authorizationLiteral).toBeDefined()
    const host = collector.data.host === "::1" ? "[::1]" : collector.data.host
    const processCount = parse(await harness.executeTool("debug_session_status", {})).data.processCount
    const reproductionPromise = harness.executeTool("debug_process_capture", {
      approvalClass: "local-deterministic",
      purpose: "reproduction",
      outcomePredicate: { kind: "exit-code", operator: "not-equals", value: 0 },
      probeIds: [prepared.data.probeId],
      executable: process.execPath,
      args: ["--test", behaviorTestPath],
      cwd: harness.projectRoot,
      env: {},
      runId: run.data.runId,
      timeoutMs: 5_000,
    })
    let captureStarted = false
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const currentProcessCount = parse(await harness.executeTool("debug_session_status", {})).data.processCount
      if (currentProcessCount > processCount) {
        captureStarted = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(captureStarted).toBe(true)
    const response = await fetch(`http://${host}:${collector.data.port}/v1/events`, {
      method: "POST",
      headers: {
        Authorization: JSON.parse(authorizationLiteral as string),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        events: [
          {
            schemaVersion: 1,
            sessionId: parse(await harness.executeTool("debug_session_status", {})).data.sessionId,
            runId: run.data.runId,
            runLabel: "pre-fix",
            hypothesisId: "hyp_value",
            probeId: prepared.data.probeId,
            timestamp: new Date().toISOString(),
            message: "observed value",
            source: { file: "src.ts", line: 2 },
            data: { observed: 1 },
          },
        ],
      }),
    })
    expect(response.status).toBe(202)
    const reproduction = parse(await reproductionPromise)
    expect(reproduction.ok).toBe(true)
    expect(reproduction.data.issueReproduced).toBe(true)
    let evidence = parse(await harness.executeTool("debug_evidence_read", { runId: run.data.runId, limit: 20 }))
    for (let attempt = 0; evidence.data.events.length === 0 && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      evidence = parse(await harness.executeTool("debug_evidence_read", { runId: run.data.runId, limit: 20 }))
    }
    const deciding = evidence.data.events.find((event: { hypothesisId: string }) => event.hypothesisId === "hyp_value")
    expect(deciding).toBeDefined()
    expect(
      parse(
        await harness.executeTool("debug_run_finish", {
          runId: run.data.runId,
          status: "completed",
          issueReproduced: false,
          observationSource: "deterministic",
          observation: "A caller-authored outcome that contradicts the failing test",
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } })
    const finishedPreFix = parse(
      await harness.executeTool("debug_run_finish", {
        runId: run.data.runId,
        status: "completed",
        issueReproduced: true,
        observationSource: "deterministic",
        observation: "The runtime value remained incorrect",
      }),
    )
    expect(finishedPreFix.ok).toBe(true)
    const analyzed = parse(await harness.executeTool("debug_state_read", {})).data.state
    await harness.completeText(
      `## Evidence decision\nhyp_value confirmed by ${deciding.eventId}.\nhyp_timeout eliminated by ${deciding.eventId}.`,
    )
    const fakeEvidence = parse(
      await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: analyzed.revision,
        state: {
          ...analyzed,
          reproduction: { ...analyzed.reproduction, confirmed: true },
          phase: "fixing",
          hypotheses: analyzed.hypotheses.map((hypothesis: { id: string }) =>
            hypothesis.id === "hyp_value"
              ? { ...hypothesis, status: "confirmed", evidenceRefs: ["event_fake"] }
              : { ...hypothesis, status: "eliminated" },
          ),
          singleCauseEvidenceRef: "event_fake",
          decidingEvidenceIds: ["event_fake"],
          decisions: [
            {
              id: "decision_fake",
              summary: "Unproven change",
              evidenceRefs: ["event_fake"],
              decidedAt: new Date().toISOString(),
            },
          ],
          fixedFiles: ["src.ts"],
        },
      }),
    )
    expect(fakeEvidence).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } })
    const observationOnly = parse(
      await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: analyzed.revision,
        state: {
          ...analyzed,
          reproduction: { ...analyzed.reproduction, confirmed: true },
          phase: "fixing",
          hypotheses: analyzed.hypotheses.map((hypothesis: { id: string }) =>
            hypothesis.id === "hyp_value"
              ? {
                  ...hypothesis,
                  status: "confirmed",
                  evidenceRefs: [finishedPreFix.data.observationEvidenceId],
                }
              : { ...hypothesis, status: "eliminated" },
          ),
          decidingEvidenceIds: [finishedPreFix.data.observationEvidenceId],
          decisions: [
            {
              id: "decision_observation",
              summary: "Trust the caller-authored summary",
              evidenceRefs: [finishedPreFix.data.observationEvidenceId],
              decidedAt: new Date().toISOString(),
            },
          ],
          fixedFiles: ["src.ts"],
        },
      }),
    )
    expect(observationOnly).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } })
    const missingAlternatives = parse(
      await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: analyzed.revision,
        state: {
          ...analyzed,
          reproduction: { ...analyzed.reproduction, confirmed: true },
          phase: "fixing",
          hypotheses: [
            {
              ...analyzed.hypotheses[0],
              status: "confirmed",
              evidenceRefs: [deciding.eventId],
            },
          ],
          decidingEvidenceIds: [deciding.eventId],
          decisions: [
            {
              id: "decision_single",
              summary: "One unexplored explanation",
              evidenceRefs: [deciding.eventId],
              decidedAt: new Date().toISOString(),
            },
          ],
          fixedFiles: ["src.ts"],
        },
      }),
    )
    expect(missingAlternatives).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } })
    const authorized = parse(
      await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: analyzed.revision,
        state: {
          ...analyzed,
          reproduction: { ...analyzed.reproduction, confirmed: true },
          phase: "fixing",
          hypotheses: analyzed.hypotheses.map((hypothesis: { id: string }) =>
            hypothesis.id === "hyp_value"
              ? { ...hypothesis, status: "confirmed", evidenceRefs: [deciding.eventId] }
              : { ...hypothesis, status: "eliminated", evidenceRefs: [deciding.eventId] },
          ),
          singleCauseEvidenceRef: null,
          decidingEvidenceIds: [deciding.eventId],
          decisions: [
            {
              id: "decision_value",
              summary: "Correct the runtime value",
              evidenceRefs: [deciding.eventId],
              decidedAt: new Date().toISOString(),
            },
          ],
          fixedFiles: ["src.ts"],
          nextAction: "apply the scoped fix",
        },
      }),
    )
    expect(authorized.ok).toBe(true)
    expect(
      parse(
        await harness.executeTool("debug_run_start", {
          label: "post-fix",
          reproduction: "load fixture",
          waitingForUser: false,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } })
    expect(
      parse(
        await harness.executeTool("debug_cleanup", {
          reason: "completed",
          finalReport: {
            outcome: "completed",
            rootCause: "runtime value remained 1",
            decidingEvidence: [deciding.eventId],
            hypotheses: [{ id: "hyp_value", status: "confirmed", statement: "runtime value remains 1" }],
            fix: "change the value",
            changedFiles: ["src.ts"],
            verification: ["not run"],
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } })
    await expect(
      harness.beforeTool("edit", {
        filePath: sourcePath,
        oldString: "const observed = 1",
        newString: "const observed = 2",
      }),
    ).resolves.toBeDefined()
    await writeFile(
      sourcePath,
      (await readFile(sourcePath, "utf8")).replace("const observed = 1", "const observed = 2"),
    )
    await harness.afterTool("edit", {}, "session-A", "call-fixture", { filePath: sourcePath })
    await expect(
      harness.beforeTool("edit", {
        filePath: path.join(harness.projectRoot, "outside.ts"),
        oldString: "1",
        newString: "2",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const fixing = parse(await harness.executeTool("debug_state_read", {})).data.state
    expect(
      parse(
        await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: fixing.revision,
          state: { ...fixing, phase: "verifying", nextAction: "same-path verification" },
        }),
      ).ok,
    ).toBe(true)
    const postFix = parse(
      await harness.executeTool("debug_run_start", {
        label: "post-fix",
        reproduction: "load fixture",
        waitingForUser: false,
      }),
    )
    expect(
      parse(
        await harness.executeTool("debug_process_capture", {
          approvalClass: "local-deterministic",
          purpose: "verification",
          outcomePredicate: { kind: "exit-code", operator: "equals", value: 0 },
          probeIds: [],
          executable: process.execPath,
          args: ["--test", behaviorTestPath],
          cwd: harness.projectRoot,
          env: {},
          runId: postFix.data.runId,
          timeoutMs: 5_000,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } })
    const verificationCapture = parse(
      await harness.executeTool("debug_process_capture", {
        approvalClass: "local-deterministic",
        purpose: "verification",
        outcomePredicate: { kind: "exit-code", operator: "not-equals", value: 0 },
        probeIds: [],
        executable: process.execPath,
        args: ["--test", behaviorTestPath],
        cwd: harness.projectRoot,
        env: {},
        runId: postFix.data.runId,
        timeoutMs: 5_000,
      }),
    )
    expect(verificationCapture.ok).toBe(true)
    expect(verificationCapture.data.issueReproduced).toBe(false)
    expect(
      parse(
        await harness.executeTool("debug_run_finish", {
          runId: postFix.data.runId,
          status: "completed",
          issueReproduced: false,
          observationSource: "deterministic",
          observation: "Automated verification passed",
        }),
      ).ok,
    ).toBe(true)
    const completed = parse(
      await harness.executeTool("debug_cleanup", {
        reason: "completed",
        finalReport: {
          outcome: "completed",
          rootCause: "runtime value remains 1",
          decidingEvidence: [deciding.eventId],
          hypotheses: [
            { id: "hyp_value", status: "confirmed", statement: "runtime value remains 1" },
            { id: "hyp_timeout", status: "eliminated", statement: "the runtime capture times out" },
          ],
          fix: "Correct the runtime value",
          changedFiles: ["src.ts"],
          verification: [`same-path verification ${verificationCapture.data.resultEvidenceId}`],
        },
      }),
    )
    expect(completed).toMatchObject({ ok: true })
    expect(await readFile(sourcePath, "utf8")).toBe("const observed = 2\n")
    await expect(readFile(path.join(harness.projectRoot, "transport.mjs"))).rejects.toMatchObject({ code: "ENOENT" })
  }, 15_000)
})
