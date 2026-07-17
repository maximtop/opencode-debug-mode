import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { LIMITS } from "../../src/core/constants.js"
import { createDebugModePlugin } from "../../src/index.js"
import { pluginHarness } from "../helpers/factories.js"
import { FakeClock } from "../helpers/fake-clock.js"

describe("OpenCode plugin lifecycle", () => {
  it("leaves discovery sequencing to the prompt while keeping runtime hooks quiet", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await harness.selectAgent("debug")
    await expect(
      Promise.all(
        Array.from({ length: 12 }, (_value, index) =>
          harness.beforeTool("read", { filePath: `src/example-${index}.ts` }),
        ),
      ),
    ).resolves.toHaveLength(12)
    expect(await harness.systemContext()).toEqual([])
  })

  it("allows a last-resort blocker Question outside a prepared human checkpoint", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await harness.selectAgent("debug")
    await expect(
      harness.beforeTool("question", {
        questions: [
          {
            header: "Input needed",
            question: "The required private runtime is unavailable. Can you provide access or the captured output?",
            options: [
              { label: "Provide access", description: "Continue with the real runtime." },
              { label: "Provide output", description: "Continue from developer-captured evidence." },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({
      questions: [expect.objectContaining({ multiple: false, custom: false })],
    })
  })

  it("uses a state-read receipt barrier before instrumentation", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await harness.selectAgent("debug")
    const sourceFile = path.join(harness.projectRoot, "receipt.ts")
    await writeFile(sourceFile, "const observed = 1\nvoid observed\n")
    const initial = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    const hypotheses = [
      {
        id: "hyp_receipt",
        rank: 1,
        statement: "the runtime value is stale",
        confirmationSignals: ["the probe reports the old value"],
        eliminationSignals: ["the probe reports the new value"],
        status: "open",
        evidenceRefs: [],
      },
      {
        id: "hyp_timing",
        rank: 2,
        statement: "the runtime read happens too early",
        confirmationSignals: ["the probe runs before the update"],
        eliminationSignals: ["the probe runs after the update"],
        status: "open",
        evidenceRefs: [],
      },
    ]
    const checkpointed = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: initial.revision,
        state: {
          ...initial,
          phase: "hypotheses",
          reproduction: { method: "load the fixture", requiresUser: false, confirmed: null },
          hypotheses,
        },
      })) as string,
    )
    expect(checkpointed.ok).toBe(true)
    expect(checkpointed.data.visibilityReceiptMarkdown).toContain("## Working hypotheses")
    expect(checkpointed.data.nextAssistantAction).toContain("Before any further tool call")
    for (const discoveryTool of ["read", "glob", "grep", "list", "codesearch", "webfetch", "websearch", "lsp"]) {
      await expect(harness.beforeTool(discoveryTool, { filePath: sourceFile })).resolves.toBeDefined()
    }
    const run = JSON.parse(
      (await harness.executeTool("debug_run_start", {
        label: "pre-fix",
        reproduction: "load the fixture",
        waitingForUser: false,
      })) as string,
    )
    expect(run.ok).toBe(true)
    const prepareArgs = {
      runId: run.data.runId,
      hypothesisId: "hyp_receipt",
      sourceFile: "receipt.ts",
      sourceLine: 2,
      message: "runtime value",
      captures: [{ label: "observed", path: "observed" }],
      transport: "process",
      sampling: { mode: "every", n: 1 },
    }
    expect(JSON.parse((await harness.executeTool("debug_probe_prepare", prepareArgs)) as string)).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE", action: expect.stringContaining("phase instrumenting") },
    })
    expect(JSON.parse((await harness.executeTool("debug_state_read", {})) as string).ok).toBe(true)
    const receiptBody = String(checkpointed.data.visibilityReceiptMarkdown).split("\n").slice(1).join("\n")
    await harness.completeText(
      `I need to re-establish the hypotheses visibility receipt. Here is the exact Working hypotheses:\n${receiptBody}`,
    )
    const receiptState = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    await expect(harness.beforeTool("read", { filePath: sourceFile })).resolves.toBeDefined()
    const instrumentingCheckpoint = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: receiptState.revision,
        state: { ...receiptState, phase: "instrumenting" },
      })) as string,
    )
    expect(instrumentingCheckpoint.ok).toBe(true)
    const instrumentingState = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    await harness.beforeTool("read", { filePath: sourceFile })
    await harness.afterTool("read", {}, "session-A", "call-post-slate-read", { filePath: sourceFile })
    await harness.beforeTool("grep", { pattern: "observed", path: harness.projectRoot })
    await harness.afterTool("grep", {}, "session-A", "call-post-slate-grep", {
      pattern: "observed",
      path: harness.projectRoot,
    })
    const correctedCheckpoint = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: instrumentingState.revision,
        state: {
          ...instrumentingState,
          hypotheses: instrumentingState.hypotheses.map((hypothesis: (typeof hypotheses)[number]) =>
            hypothesis.id === "hyp_receipt"
              ? { ...hypothesis, statement: "the runtime value remains stale" }
              : hypothesis,
          ),
        },
      })) as string,
    )
    expect(correctedCheckpoint).toMatchObject({
      ok: true,
      data: {
        visibilityReceiptMarkdown: expect.stringContaining("the runtime value remains stale"),
      },
    })
    const correctedState = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    const scopeDrift = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: correctedState.revision,
        state: {
          ...correctedState,
          phase: "hypotheses",
          runtimeContext: { kind: "cli", target: "node" },
          reproduction: { method: "run a local fetch test", requiresUser: false, confirmed: null },
        },
      })) as string,
    )
    expect(scopeDrift).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_PHASE",
        retryable: true,
        message: expect.stringContaining("boundary are frozen"),
        action: expect.stringContaining("local process or test substitute cannot replace"),
        details: {
          expectedRuntimeKind: "other",
          incomingRuntimeKind: "cli",
          expectedRequiresUser: false,
          incomingRequiresUser: false,
        },
      },
    })
    expect(JSON.parse((await harness.executeTool("debug_probe_prepare", prepareArgs)) as string).ok).toBe(true)
  })

  it("uses a canonical marker edit from a nested cwd and records a prepared observational Question", async () => {
    const harness = await pluginHarness()
    const nestedDirectory = path.join(harness.projectRoot, "packages", "app")
    await mkdir(nestedDirectory, { recursive: true })
    await harness.selectAgent("debug")
    expect(
      JSON.parse(
        (await harness.executeTool("debug_session_start", { keepArtifacts: false }, "session-A", {
          directory: nestedDirectory,
          worktree: harness.projectRoot,
        })) as string,
      ).ok,
    ).toBe(true)
    const procedure = "Open Filters and run Check for updates"
    const hypotheses = [
      {
        id: "hyp_redirect",
        rank: 1,
        statement: "redirected browser fetch fails",
        confirmationSignals: ["collector reports redirect failure"],
        eliminationSignals: ["collector reports successful response"],
        status: "open",
        evidenceRefs: [],
      },
      {
        id: "hyp_timeout",
        rank: 2,
        statement: "request exceeds timeout",
        confirmationSignals: ["collector reports timeout"],
        eliminationSignals: ["collector reports timely response"],
        status: "open",
        evidenceRefs: [],
      },
    ]
    const initial = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    const initialCheckpoint = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: initial.revision,
        state: {
          ...initial,
          phase: "hypotheses",
          reproduction: { method: procedure, requiresUser: true, confirmed: null },
          hypotheses,
        },
      })) as string,
    )
    expect(initialCheckpoint.ok).toBe(true)
    expect(await harness.systemContext()).toEqual([])
    await harness.completeText(String(initialCheckpoint.data.visibilityReceiptMarkdown))
    const run = JSON.parse(
      (await harness.executeTool("debug_run_start", {
        label: "pre-fix",
        reproduction: procedure,
        waitingForUser: true,
      })) as string,
    )
    expect(run.ok).toBe(true)
    const beforeInstrumentation = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    expect(
      JSON.parse(
        (await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: beforeInstrumentation.revision,
          state: { ...beforeInstrumentation, phase: "instrumenting" },
        })) as string,
      ).ok,
    ).toBe(true)

    const sourceFile = path.join(harness.projectRoot, "runtime.mjs")
    const importLine = "import { existing } from './existing.mjs'"
    const targetLine = "        return observed"
    const original = [
      importLine,
      "",
      "export async function run() {",
      "        const observed = 1",
      "",
      targetLine,
      "}",
      "",
    ].join("\n")
    await writeFile(sourceFile, original)
    const collector = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "web",
        transportTargetPath: "debug-transport.mjs",
      })) as string,
    )
    expect(collector, JSON.stringify(collector)).toMatchObject({ ok: true })
    const prepared = JSON.parse(
      (await harness.executeTool("debug_probe_prepare", {
        runId: run.data.runId,
        hypothesisId: "hyp_redirect",
        sourceFile: "runtime.mjs",
        sourceLine: 6,
        message: "redirect observation",
        captures: [{ label: "observed", path: "observed" }],
        transport: "http-web",
        sampling: { mode: "every", n: 1 },
      })) as string,
    )
    expect(prepared.ok).toBe(true)
    expect(prepared.data).toMatchObject({
      sourceLineText: targetLine,
      sourceContext: expect.arrayContaining([{ line: 6, text: targetLine }]),
      markerEdit: {
        filePath: sourceFile,
        oldString: expect.stringContaining(targetLine),
        newString: expect.stringContaining(String(prepared.data.markerBlock)),
      },
    })
    for (const discoveryTool of ["read", "webfetch", "websearch", "lsp"]) {
      await expect(harness.beforeTool(discoveryTool, { filePath: "another-static-file.ts" })).resolves.toBeDefined()
    }

    const markerEdit = prepared.data.markerEdit as { filePath: string; oldString: string; newString: string }
    const withMarker = original.replace(markerEdit.oldString, markerEdit.newString)
    expect(withMarker).not.toBe(original)
    await harness.beforeTool("edit", markerEdit)
    await writeFile(sourceFile, withMarker)
    await harness.afterTool("edit", {}, "session-A", "call-marker", markerEdit)
    const importReplacement = `${importLine}\n${String(prepared.data.helperImportBlock)}`
    const instrumented = withMarker.replace(importLine, importReplacement)
    const importEdit = { filePath: sourceFile, oldString: importLine, newString: importReplacement }
    await harness.beforeTool("edit", importEdit)
    await writeFile(sourceFile, instrumented)
    await harness.afterTool("edit", {}, "session-A", "call-import", importEdit)
    expect(
      JSON.parse((await harness.executeTool("debug_probe_register", { probeId: prepared.data.probeId })) as string).ok,
    ).toBe(true)
    await writeFile(sourceFile, instrumented.replace("const observed = 1", "const observed = 2"))
    expect(
      JSON.parse((await harness.executeTool("debug_probe_register", { probeId: prepared.data.probeId })) as string),
    ).toMatchObject({ ok: false, error: { code: "MARKER_MISMATCH" } })
    await writeFile(sourceFile, instrumented)
    expect(
      JSON.parse((await harness.executeTool("debug_probe_register", { probeId: prepared.data.probeId })) as string).ok,
    ).toBe(true)
    const checked = JSON.parse(
      (await harness.executeTool("debug_process_capture", {
        approvalClass: "local-deterministic",
        purpose: "instrumentation-check",
        probeIds: [prepared.data.probeId],
        executable: process.execPath,
        args: ["--check", "runtime.mjs"],
        cwd: harness.projectRoot,
        env: {},
        runId: run.data.runId,
        timeoutMs: 10_000,
      })) as string,
    )
    expect(checked).toMatchObject({ ok: true, data: { validatedProbeIds: [prepared.data.probeId] } })
    expect(await harness.systemContext()).toEqual([])
    await expect(harness.beforeTool("read", { filePath: "another-static-file.ts" })).resolves.toBeDefined()

    const beforeWaiting = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    const waitingCheckpoint = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: beforeWaiting.revision,
        state: {
          ...beforeWaiting,
          phase: "waiting_for_reproduction",
          probeRefs: [
            {
              id: prepared.data.probeId,
              runId: run.data.runId,
              hypothesisId: "hyp_redirect",
              sourceFile: "runtime.mjs",
              status: "validated",
            },
          ],
        },
      })) as string,
    )
    expect(waitingCheckpoint.ok).toBe(true)
    expect(waitingCheckpoint.data.preparedQuestionArgs.questions[0].question).toContain(procedure)
    expect(await harness.systemContext()).toEqual([])
    await expect(harness.beforeTool("read", { filePath: sourceFile })).resolves.toBeDefined()

    const question = waitingCheckpoint.data.preparedQuestionArgs
    const normalized = await harness.beforeTool("question", question)
    expect(normalized).toMatchObject({
      questions: [
        {
          question: expect.stringContaining(procedure),
          custom: false,
        },
      ],
    })
    await harness.afterTool("question", { answers: [["Reproduced"]] })
    const finished = JSON.parse(
      (await harness.executeTool("debug_run_finish", {
        runId: run.data.runId,
        status: "completed",
        issueReproduced: true,
        observationSource: "human",
        observation: "The redirected custom filter remained stale.",
      })) as string,
    )
    expect(finished.ok).toBe(true)
  }, 15_000)

  it("keeps prompt-directed discovery available while instrumenting", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await harness.selectAgent("debug")
    const current = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    const hypotheses = [
      {
        id: "hyp_runtime",
        rank: 1,
        statement: "the runtime boundary returns stale data",
        confirmationSignals: ["the probe reports stale data"],
        eliminationSignals: ["the probe reports fresh data"],
        status: "open",
        evidenceRefs: [],
      },
      {
        id: "hyp_timeout",
        rank: 2,
        statement: "the runtime boundary times out",
        confirmationSignals: ["the timeout fires first"],
        eliminationSignals: ["the response completes first"],
        status: "open",
        evidenceRefs: [],
      },
    ]
    const initialCheckpoint = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: current.revision,
        state: {
          ...current,
          phase: "hypotheses",
          reproduction: { method: "run fixture", requiresUser: false, confirmed: null },
          hypotheses,
        },
      })) as string,
    )
    expect(initialCheckpoint.ok).toBe(true)
    await harness.completeText(String(initialCheckpoint.data.visibilityReceiptMarkdown))
    expect(
      JSON.parse(
        (await harness.executeTool("debug_run_start", {
          label: "pre-fix",
          reproduction: "run fixture",
          waitingForUser: false,
        })) as string,
      ).ok,
    ).toBe(true)
    const beforeInstrumentation = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    expect(
      JSON.parse(
        (await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: beforeInstrumentation.revision,
          state: { ...beforeInstrumentation, phase: "instrumenting" },
        })) as string,
      ).ok,
    ).toBe(true)

    for (let index = 0; index < 4; index += 1) {
      await expect(harness.beforeTool("read", { filePath: `src/runtime-${index}.ts` })).resolves.toBeDefined()
    }
    await expect(harness.beforeTool("read", { filePath: "src/runtime-final.ts" })).resolves.toBeDefined()
  })

  it("keeps prompt-directed discovery available after the last active probe is removed", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    await harness.selectAgent("debug")
    const sourceFile = path.join(harness.projectRoot, "runtime.ts")
    const original = "const observed = 1\nvoid observed\n"
    await writeFile(sourceFile, original)
    const current = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    const hypotheses = [
      {
        id: "hyp_runtime",
        rank: 1,
        statement: "the runtime boundary returns stale data",
        confirmationSignals: ["the probe reports stale data"],
        eliminationSignals: ["the probe reports fresh data"],
        status: "open",
        evidenceRefs: [],
      },
      {
        id: "hyp_timeout",
        rank: 2,
        statement: "the runtime boundary times out",
        confirmationSignals: ["the timeout fires first"],
        eliminationSignals: ["the response completes first"],
        status: "open",
        evidenceRefs: [],
      },
    ]
    const initialCheckpoint = JSON.parse(
      (await harness.executeTool("debug_state_checkpoint", {
        expectedRevision: current.revision,
        state: {
          ...current,
          phase: "hypotheses",
          reproduction: { method: "run fixture", requiresUser: false, confirmed: null },
          hypotheses,
        },
      })) as string,
    )
    expect(initialCheckpoint.ok).toBe(true)
    await harness.completeText(String(initialCheckpoint.data.visibilityReceiptMarkdown))
    const run = JSON.parse(
      (await harness.executeTool("debug_run_start", {
        label: "pre-fix",
        reproduction: "run fixture",
        waitingForUser: false,
      })) as string,
    )
    const beforeInstrumentation = JSON.parse((await harness.executeTool("debug_state_read", {})) as string).data.state
    expect(
      JSON.parse(
        (await harness.executeTool("debug_state_checkpoint", {
          expectedRevision: beforeInstrumentation.revision,
          state: { ...beforeInstrumentation, phase: "instrumenting" },
        })) as string,
      ).ok,
    ).toBe(true)

    for (let index = 0; index < 4; index += 1) {
      await expect(harness.beforeTool("read", { filePath: `src/first-${index}.ts` })).resolves.toBeDefined()
    }
    const prepared = JSON.parse(
      (await harness.executeTool("debug_probe_prepare", {
        runId: run.data.runId,
        hypothesisId: "hyp_runtime",
        sourceFile: "runtime.ts",
        sourceLine: 2,
        message: "runtime observation",
        captures: [{ label: "observed", path: "observed" }],
        transport: "process",
        sampling: { mode: "every", n: 1 },
      })) as string,
    )
    expect(prepared.ok).toBe(true)
    const editArgs = prepared.data.markerEdit
    const instrumented = original.replace(editArgs.oldString, editArgs.newString)
    await expect(harness.beforeTool("edit", editArgs)).resolves.toBeDefined()
    await writeFile(sourceFile, instrumented)
    await harness.afterTool("edit", {}, "session-A", "call-edit", editArgs)
    expect(
      JSON.parse((await harness.executeTool("debug_probe_register", { probeId: prepared.data.probeId })) as string).ok,
    ).toBe(true)
    expect(
      JSON.parse((await harness.executeTool("debug_probe_remove", { probeId: prepared.data.probeId })) as string).ok,
    ).toBe(true)
    await harness.afterTool("debug_probe_remove", {}, "session-A", "call-remove", { probeId: prepared.data.probeId })

    expect(await harness.systemContext()).toEqual([])
    for (let index = 0; index < 4; index += 1) {
      await expect(harness.beforeTool("read", { filePath: `src/replacement-${index}.ts` })).resolves.toBeDefined()
    }
    await expect(harness.beforeTool("read", { filePath: "src/replacement-final.ts" })).resolves.toBeDefined()
  })

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

  it("rejects extension permission requests before the instrumenting lifecycle", async () => {
    const harness = await pluginHarness(undefined, { activeSessions: ["session-A"] })
    const mismatch = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "web",
        transportTargetPath: "debug-transport.mjs",
        extensionManifestPath: "manifest.json",
      })) as string,
    )
    expect(mismatch.error.code).toBe("INVALID_PHASE")

    const outside = JSON.parse(
      (await harness.executeTool("debug_collector_start", {
        runtime: "extension-background",
        transportTargetPath: "debug-transport.mjs",
        extensionManifestPath: "../manifest.json",
      })) as string,
    )
    expect(outside.error.code).toBe("INVALID_PHASE")
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
