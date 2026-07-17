import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, onTestFinished } from "vitest"
import {
  type BehavioralSnapshot,
  captureRepository,
  collectSensitiveValues,
  createIsolatedEnvironment,
  createSelectedProviderAuth,
  createSelectedProviderConfig,
  evaluateBehavioralAcceptance,
  type InstrumentationFileSnapshot,
  type OrderedTool,
  parseBaseConfig,
  parseHarnessOptions,
  REQUIRED_DEBUG_TOOLS,
  redactText,
  sanitizeForReport,
  sanitizeToolOutput,
  validateExactInstrumentationChanges,
  validateSemanticProbeBoundaries,
  withAbortControllerDeadline,
} from "../../scripts/opencode-behavioral-acceptance.js"

const executeFile = promisify(execFile)

const repositoryRoot = "/tmp/opencode-debug-acceptance/repo"
const promptSha256 = "a".repeat(64)
const helperImportBlock = 'import { __opencodeDebugEmit } from "../debug-transport.mjs"\n'
const originalProcedureSteps =
  "create a GitHub filter repository, subscribe to its raw filter URL, rename the repository, change the filter content, open Filters, and run Check for updates"
const preparedProcedure = `Run pnpm dev chrome-mv3, reload the unpacked extension from build/dev/chrome-mv3, ${originalProcedureSteps}`

function insertBeforeSourceLine(source: string, sourceLine: number, insertion: string): string {
  let offset = 0
  for (let line = 1; line < sourceLine; line += 1) {
    const ending = /\r\n|\r|\n/u.exec(source.slice(offset))
    if (ending === null) throw new Error("source line is outside the fixture")
    offset += ending.index + ending[0].length
  }
  return source.slice(0, offset) + insertion + source.slice(offset)
}

function success(data: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, data, warnings: [] })
}

function tool(index: number, name: string, input: Record<string, unknown> = {}, output?: string): OrderedTool {
  return {
    index,
    messageIndex: index,
    partIndex: 0,
    name,
    status: name === "question" ? "running" : "completed",
    input,
    ...(output === undefined ? {} : { output }),
  }
}

function hypotheses(): Record<string, unknown>[] {
  return [
    {
      id: "hyp_redirect",
      rank: 1,
      statement: "Redirect response is mishandled",
      confirmationSignals: ["Redirected response fails"],
      eliminationSignals: ["Redirected response succeeds"],
      status: "open",
      evidenceRefs: [],
    },
    {
      id: "hyp_timeout",
      rank: 2,
      statement: "Download times out",
      confirmationSignals: ["Timeout fires first"],
      eliminationSignals: ["Response completes before timeout"],
      status: "open",
      evidenceRefs: [],
    },
  ]
}

function checkpointState(phase: "hypotheses" | "waiting_for_reproduction"): Record<string, unknown> {
  return {
    phase,
    hypotheses: hypotheses(),
    runs:
      phase === "waiting_for_reproduction"
        ? [{ id: "run_1", label: "pre-fix", status: "waiting", evidenceRefs: [] }]
        : [],
    probeRefs:
      phase === "waiting_for_reproduction"
        ? [
            {
              id: "probe_before",
              runId: "run_1",
              hypothesisId: "hyp_timeout",
              sourceFile: "Extension/src/background/api/filters/custom.ts",
              status: "validated",
            },
            {
              id: "probe_1",
              runId: "run_1",
              hypothesisId: "hyp_redirect",
              sourceFile: "Extension/src/background/api/filters/custom.ts",
              status: "validated",
            },
          ]
        : [],
  }
}

function passingSnapshot(): BehavioralSnapshot {
  const questions = [
    {
      header: "Reproduction",
      question: `${preparedProcedure}. What happened after following these reproduction steps?`,
      multiple: false,
      custom: false,
      options: [
        { label: "Reproduced", description: "The filter stayed stale." },
        { label: "Did not reproduce", description: "The filter updated." },
        { label: "Could not complete", description: "The browser steps could not be completed." },
      ],
    },
  ]
  const question = { id: "question_1", sessionID: "session_1", questions }
  const orderedTools = [
    tool(
      0,
      "debug_session_start",
      { keepArtifacts: false },
      success({ plugin: { packageVersion: "0.1.3", promptSha256 } }),
    ),
    tool(
      1,
      "debug_state_checkpoint",
      { expectedRevision: 0, state: checkpointState("hypotheses") },
      success({ revision: 1, bytes: 1_024 }),
    ),
    tool(
      2,
      "debug_run_start",
      { label: "pre-fix", reproduction: preparedProcedure, waitingForUser: true },
      success({ runId: "run_1", label: "pre-fix", status: "running" }),
    ),
    tool(
      3,
      "debug_collector_start",
      { runtime: "extension-background", transportTargetPath: "debug-transport.mjs" },
      success({
        collectorId: "collector_1",
        status: "ready",
        host: "127.0.0.1",
        port: 41_000,
        helperImport: 'import { __opencodeDebugEmit } from "./debug-transport.mjs"',
        helperPath: "./debug-transport.mjs",
      }),
    ),
    tool(
      4,
      "debug_probe_prepare",
      {
        runId: "run_1",
        hypothesisId: "hyp_timeout",
        sourceFile: "Extension/src/background/api/filters/custom.ts",
        sourceLine: 719,
        captures: [],
        transport: "extension-background",
        sampling: { mode: "every", n: 1 },
      },
      success({
        probeId: "probe_before",
        markerBlock: "/* owned before */",
        helperImportBlock,
        source: "Extension/src/background/api/filters/custom.ts",
        line: 719,
        sourceLineText:
          "        const downloadResult = await CustomFilterLoader.downloadRulesWithTimeout(url, rawFilter, force);",
      }),
    ),
    tool(5, "edit", { filePath: "Extension/src/background/api/filters/custom.ts" }),
    tool(
      6,
      "debug_probe_register",
      { probeId: "probe_before" },
      success({ probeId: "probe_before", status: "registered", validationStatus: "pending" }),
    ),
    tool(
      7,
      "debug_probe_prepare",
      {
        runId: "run_1",
        hypothesisId: "hyp_redirect",
        sourceFile: "Extension/src/background/api/filters/custom.ts",
        sourceLine: 721,
        captures: [{ label: "filter_count", path: "downloadResult.filter.length" }],
        transport: "extension-background",
        sampling: { mode: "every", n: 1 },
      },
      success({
        probeId: "probe_1",
        markerBlock: "/* owned after */",
        helperImportBlock,
        source: "Extension/src/background/api/filters/custom.ts",
        line: 721,
        sourceLineText: "        const parsed = FilterParser.parseFilterDataFromHeader(",
      }),
    ),
    tool(8, "edit", { filePath: "Extension/src/background/api/filters/custom.ts" }),
    tool(
      9,
      "debug_probe_register",
      { probeId: "probe_1" },
      success({ probeId: "probe_1", status: "registered", validationStatus: "pending" }),
    ),
    tool(
      10,
      "debug_process_capture",
      { purpose: "instrumentation-check", runId: "run_1", probeIds: ["probe_before", "probe_1"] },
      success({ processId: "process_1", runId: "run_1", status: "exited", exitCode: 0 }),
    ),
    tool(
      11,
      "debug_state_checkpoint",
      { expectedRevision: 1, state: checkpointState("waiting_for_reproduction") },
      success({ revision: 2, bytes: 2_048 }),
    ),
    tool(12, "question", { questions }),
  ]

  return {
    fingerprint: {
      profileId: "ag-55256",
      model: "tokenguard/deepseek-v4-flash",
      variant: "high",
      sourceRevision: "3db0d614806984803cc4d5976fd64d78917999f2",
      opencodeVersion: "1.18.3",
      expectedVersion: "1.18.3",
      packageVersion: "0.1.3",
      pluginUrl: "file:///repo/dist/index.js",
      distSha256: "b".repeat(64),
      promptSha256,
      resolvedPluginUrls: ["file:///repo/dist/index.js"],
      resolvedAgentPromptSha256: promptSha256,
      resolvedAgentPermission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ],
      registeredTools: [...REQUIRED_DEBUG_TOOLS],
      debugSessionStart: { packageVersion: "0.1.3", promptSha256 },
    },
    stopReason: "question",
    question,
    pendingQuestions: [question],
    openCodeSessionStatus: { type: "idle" },
    orderedTools,
    transcript: [
      {
        messageIndex: 1,
        role: "assistant",
        text: [
          "Working hypotheses\n1. Redirect response is mishandled\n   - Confirm: redirected response fails\n2. Download times out\n   - Confirm: timeout fires first",
        ],
        tools: [{ name: "debug_state_checkpoint", status: "completed" }],
      },
    ],
    sessionDiff: [],
    repository: {
      root: repositoryRoot,
      status: " M src/custom-filter.ts\n",
      patch: "diff --git a/src/custom-filter.ts b/src/custom-filter.ts\n+/* owned instrumentation */\n",
      changedFiles: ["src/custom-filter.ts"],
      untrackedFiles: [],
      exactInstrumentation: { passed: true, errors: [] },
      semanticProbeBoundaries: { passed: true, errors: [] },
    },
    plugin: {
      found: true,
      sessionDirectory: "/tmp/opencode-debug-acceptance/session-1",
      manifest: {
        waitingForReproduction: true,
        visibleHypothesesAt: "2026-07-15T12:00:00.000Z",
        collector: { id: "collector_1", status: "ready" },
        runs: [
          {
            id: "run_1",
            label: "pre-fix",
            status: "waiting",
            reproduction: preparedProcedure,
          },
        ],
        humanCheckpoints: [{ requestId: "call_1", runId: "run_1", purpose: "reproduction", status: "asked" }],
        probes: [
          {
            id: "probe_before",
            runId: "run_1",
            hypothesisId: "hyp_timeout",
            sourceFile: `${repositoryRoot}/Extension/src/background/api/filters/custom.ts`,
            sourceLine: 719,
            message: "download attempt reached",
            captures: [],
            sampling: { mode: "every", n: 1 },
            transport: "extension-background",
            helperSourceFile: `${repositoryRoot}/Extension/src/background/api/filters/custom.ts`,
            helperImportBlock,
            helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
            status: "validated",
            validationStatus: "validated",
          },
          {
            id: "probe_1",
            runId: "run_1",
            hypothesisId: "hyp_redirect",
            sourceFile: `${repositoryRoot}/Extension/src/background/api/filters/custom.ts`,
            sourceLine: 721,
            message: "download returned",
            captures: [{ label: "filter_count", path: "downloadResult.filter.length" }],
            sampling: { mode: "every", n: 1 },
            transport: "extension-background",
            helperSourceFile: `${repositoryRoot}/Extension/src/background/api/filters/custom.ts`,
            helperImportBlock,
            helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
            status: "validated",
            validationStatus: "validated",
          },
        ],
        ownedFiles: [],
        permissionChanges: [],
      },
      state: {
        phase: "waiting_for_reproduction",
        hypotheses: hypotheses(),
        runs: [{ id: "run_1", label: "pre-fix", status: "waiting", evidenceRefs: [] }],
        probeRefs: [
          {
            id: "probe_before",
            runId: "run_1",
            hypothesisId: "hyp_timeout",
            sourceFile: "Extension/src/background/api/filters/custom.ts",
            status: "validated",
          },
          {
            id: "probe_1",
            runId: "run_1",
            hypothesisId: "hyp_redirect",
            sourceFile: "Extension/src/background/api/filters/custom.ts",
            status: "validated",
          },
        ],
        instrumentedFiles: ["src/custom-filter.ts"],
        fixedFiles: [],
      },
      evidence: [],
    },
    postCleanup: {
      remainingPluginSessionDirectories: [],
      repository: { root: repositoryRoot, status: "", patch: "", changedFiles: [], untrackedFiles: [] },
    },
  }
}

describe("real OpenCode behavioral acceptance policy", () => {
  it("accepts a correlated pre-fix human checkpoint and successful deletion cleanup", () => {
    const result = evaluateBehavioralAcceptance(passingSnapshot())

    expect(result.passed).toBe(true)
    expect(result.checks.every((check) => check.passed)).toBe(true)
  })

  it.each([
    ["build command", `Reload the unpacked extension from build/dev/chrome-mv3, ${originalProcedureSteps}`],
    ["reload step", `Run pnpm dev chrome-mv3, use build/dev/chrome-mv3, ${originalProcedureSteps}`],
    ["artifact path", `Run pnpm dev chrome-mv3, reload the unpacked extension, ${originalProcedureSteps}`],
  ])("rejects an MV3 reproduction without its %s", (_missing, procedure) => {
    const snapshot = passingSnapshot()
    const run = snapshot.plugin.manifest?.runs
    if (!Array.isArray(run) || typeof run[0] !== "object" || run[0] === null) throw new Error("missing run")
    ;(run[0] as Record<string, unknown>).reproduction = procedure
    const question = snapshot.question?.questions
    if (!Array.isArray(question) || typeof question[0] !== "object" || question[0] === null) {
      throw new Error("missing question")
    }
    ;(question[0] as Record<string, unknown>).question = `${procedure}. What happened?`

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "self-contained-mv3-reproduction")?.passed).toBe(false)
  })

  it("rejects an MV3 reproduction that drops the original AG-55256 steps", () => {
    const snapshot = passingSnapshot()
    const procedure =
      "Run pnpm dev chrome-mv3, reload the unpacked extension from build/dev/chrome-mv3, then update the redirected custom filter"
    const runs = snapshot.plugin.manifest?.runs
    if (!Array.isArray(runs) || typeof runs[0] !== "object" || runs[0] === null) throw new Error("missing run")
    ;(runs[0] as Record<string, unknown>).reproduction = procedure
    const questions = snapshot.question?.questions
    if (!Array.isArray(questions) || typeof questions[0] !== "object" || questions[0] === null) {
      throw new Error("missing question")
    }
    ;(questions[0] as Record<string, unknown>).question = `${procedure}. What happened?`

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "self-contained-mv3-reproduction")?.passed).toBe(false)
  })

  it("rejects an MV3 reproduction that performs the original steps before build and reload", () => {
    const snapshot = passingSnapshot()
    const procedure = `${originalProcedureSteps}; then run pnpm dev chrome-mv3 and reload the unpacked extension from build/dev/chrome-mv3`
    const runs = snapshot.plugin.manifest?.runs
    if (!Array.isArray(runs) || typeof runs[0] !== "object" || runs[0] === null) throw new Error("missing run")
    ;(runs[0] as Record<string, unknown>).reproduction = procedure
    const questions = snapshot.question?.questions
    if (!Array.isArray(questions) || typeof questions[0] !== "object" || questions[0] === null) {
      throw new Error("missing question")
    }
    ;(questions[0] as Record<string, unknown>).question = `${procedure}. What happened?`

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "self-contained-mv3-reproduction")?.passed).toBe(false)
  })

  it("evaluates the terminal running Question after an earlier rejected attempt", () => {
    const snapshot = passingSnapshot()
    const terminalQuestion = snapshot.orderedTools.at(-1)
    if (terminalQuestion === undefined) throw new Error("missing terminal question fixture")
    if (
      typeof terminalQuestion.input !== "object" ||
      terminalQuestion.input === null ||
      Array.isArray(terminalQuestion.input)
    ) {
      throw new Error("missing terminal question input fixture")
    }
    terminalQuestion.index = 10
    const rejectedQuestion = tool(9, "question", structuredClone(terminalQuestion.input) as Record<string, unknown>)
    rejectedQuestion.status = "error"
    snapshot.orderedTools.splice(snapshot.orderedTools.length - 1, 0, rejectedQuestion)

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reproduction-question")?.passed).toBe(true)
    expect(result.checks.find((check) => check.id === "no-silent-finalization")?.passed).toBe(true)
    expect(result.passed).toBe(true)
  })

  it("rejects a product edit before the debug session starts", () => {
    const snapshot = passingSnapshot()
    const edit = snapshot.orderedTools.splice(5, 1)[0]
    if (edit === undefined) throw new Error("missing edit fixture")
    snapshot.orderedTools.unshift(edit)

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "session-start-before-mutation")?.passed).toBe(false)
  })

  it("rejects a stale literal hypothesis after later discovery proves the actual constant", () => {
    const snapshot = passingSnapshot()
    for (const checkpoint of snapshot.orderedTools.filter((item) => item.name === "debug_state_checkpoint")) {
      const input = checkpoint.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
      const timeout = input.state?.hypotheses?.find((hypothesis) => hypothesis.id === "hyp_timeout")
      if (timeout !== undefined) {
        timeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 10s, so the download times out"
      }
    }
    const persisted = snapshot.plugin.state?.hypotheses as Array<Record<string, unknown>>
    const timeout = persisted.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (timeout === undefined) throw new Error("missing timeout hypothesis fixture")
    timeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 10s, so the download times out"
    snapshot.orderedTools.splice(
      3,
      0,
      tool(
        99,
        "read",
        { filePath: "Extension/src/background/api/filters/custom/loader.ts" },
        "Extension/src/background/api/filters/custom/loader.ts\nconst DOWNLOAD_LIMIT_MS = 3 * 1000;",
      ),
    )

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reconciled-hypothesis-facts")?.passed).toBe(false)
  })

  it("accepts a corrected hypothesis checkpoint shown after reading the actual constant", () => {
    const snapshot = passingSnapshot()
    const initialCheckpoint = snapshot.orderedTools.find((item) => item.name === "debug_state_checkpoint")
    const initialInput = initialCheckpoint?.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
    const initialTimeout = initialInput.state?.hypotheses?.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (initialTimeout === undefined) throw new Error("missing initial timeout hypothesis")
    initialTimeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 10s, so the download times out"

    const correctedHypotheses = hypotheses()
    const correctedTimeout = correctedHypotheses.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (correctedTimeout === undefined) throw new Error("missing corrected timeout hypothesis")
    correctedTimeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 3 seconds, so slow redirects may time out"
    const correctedReceipt = [
      "## Working hypotheses",
      "1. hyp_redirect — Redirect response is mishandled",
      "   - Confirmation signals: Redirected response fails",
      "   - Elimination signals: Redirected response succeeds",
      "2. hyp_timeout — CustomFilterLoader.DOWNLOAD_LIMIT_MS is 3 seconds, so slow redirects may time out",
      "   - Confirmation signals: Timeout fires first",
      "   - Elimination signals: Response completes before timeout",
    ].join("\n")
    const read = tool(
      0,
      "read",
      { filePath: "Extension/src/background/api/filters/custom/loader.ts" },
      "Extension/src/background/api/filters/custom/loader.ts\nconst DOWNLOAD_LIMIT_MS = 3 * 1000;",
    )
    const corrected = tool(
      0,
      "debug_state_checkpoint",
      { expectedRevision: 1, state: { ...checkpointState("hypotheses"), hypotheses: correctedHypotheses } },
      success({ revision: 2, bytes: 1_024, visibilityReceiptMarkdown: correctedReceipt }),
    )
    snapshot.orderedTools.splice(3, 0, read, corrected)
    for (const [index, item] of snapshot.orderedTools.entries()) {
      item.index = index
      item.messageIndex = index * 2
    }
    corrected.messageIndex = 8
    snapshot.transcript.push({
      messageIndex: 9,
      role: "assistant",
      text: [correctedReceipt],
      tools: [{ name: "debug_state_read", status: "completed" }],
    })

    const waitingCheckpoint = snapshot.orderedTools.filter((item) => item.name === "debug_state_checkpoint").at(-1)
    const waitingInput = waitingCheckpoint?.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
    if (waitingInput.state === undefined) throw new Error("missing waiting checkpoint")
    waitingInput.state.hypotheses = structuredClone(correctedHypotheses)
    if (snapshot.plugin.state === undefined) throw new Error("missing persisted state")
    snapshot.plugin.state.hypotheses = structuredClone(correctedHypotheses)

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reconciled-hypothesis-facts")?.passed).toBe(true)
  })

  it("rejects silently correcting persisted hypotheses without a fresh visible checkpoint", () => {
    const snapshot = passingSnapshot()
    const initialCheckpoint = snapshot.orderedTools.find((item) => item.name === "debug_state_checkpoint")
    const initialInput = initialCheckpoint?.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
    const initialTimeout = initialInput.state?.hypotheses?.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (initialTimeout === undefined) throw new Error("missing initial timeout hypothesis")
    initialTimeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 10s, so the download times out"
    snapshot.orderedTools.splice(
      3,
      0,
      tool(
        99,
        "read",
        { filePath: "Extension/src/background/api/filters/custom/loader.ts" },
        "Extension/src/background/api/filters/custom/loader.ts\nconst DOWNLOAD_LIMIT_MS = 3 * 1000;",
      ),
    )
    const correctedHypotheses = hypotheses()
    const correctedTimeout = correctedHypotheses.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (correctedTimeout === undefined) throw new Error("missing corrected timeout hypothesis")
    correctedTimeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 3 seconds, so slow redirects may time out"
    const waitingCheckpoint = snapshot.orderedTools.filter((item) => item.name === "debug_state_checkpoint").at(-1)
    const waitingInput = waitingCheckpoint?.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
    if (waitingInput.state === undefined || snapshot.plugin.state === undefined)
      throw new Error("missing state fixture")
    waitingInput.state.hypotheses = structuredClone(correctedHypotheses)
    snapshot.plugin.state.hypotheses = structuredClone(correctedHypotheses)

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reconciled-hypothesis-facts")?.passed).toBe(false)
  })

  it("does not treat a state-tool echo as reading the download limit from source", () => {
    const snapshot = passingSnapshot()
    for (const checkpoint of snapshot.orderedTools.filter((item) => item.name === "debug_state_checkpoint")) {
      const input = checkpoint.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
      const timeout = input.state?.hypotheses?.find((hypothesis) => hypothesis.id === "hyp_timeout")
      if (timeout !== undefined) {
        timeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS = 3 * 1000 may time out"
      }
      checkpoint.output = success({
        revision: 2,
        visibilityReceiptMarkdown: "CustomFilterLoader.DOWNLOAD_LIMIT_MS = 3 * 1000 may time out",
      })
    }
    const persisted = snapshot.plugin.state?.hypotheses as Array<Record<string, unknown>>
    const timeout = persisted.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (timeout === undefined) throw new Error("missing timeout hypothesis fixture")
    timeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS = 3 * 1000 may time out"

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reconciled-hypothesis-facts")?.passed).toBe(false)
  })

  it("does not confuse the outer 10-second timeout with the loader's 3-second timeout", () => {
    const snapshot = passingSnapshot()
    const statement =
      "CustomFilterApi has an outer 10-second limit, while CustomFilterLoader.DOWNLOAD_LIMIT_MS is 3 seconds"
    for (const checkpoint of snapshot.orderedTools.filter((item) => item.name === "debug_state_checkpoint")) {
      const input = checkpoint.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
      const timeout = input.state?.hypotheses?.find((hypothesis) => hypothesis.id === "hyp_timeout")
      if (timeout !== undefined) timeout.statement = statement
    }
    const persisted = snapshot.plugin.state?.hypotheses as Array<Record<string, unknown>>
    const timeout = persisted.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (timeout === undefined) throw new Error("missing timeout hypothesis fixture")
    timeout.statement = statement
    snapshot.orderedTools.splice(
      1,
      0,
      tool(
        99,
        "read",
        { filePath: "Extension/src/background/api/filters/custom/loader.ts" },
        "Extension/src/background/api/filters/custom/loader.ts\nconst DOWNLOAD_LIMIT_MS = 3 * 1000;",
      ),
    )

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reconciled-hypothesis-facts")?.passed).toBe(true)
  })

  it("does not accept a 3-second constant read only from an unrelated test fixture", () => {
    const snapshot = passingSnapshot()
    for (const checkpoint of snapshot.orderedTools.filter((item) => item.name === "debug_state_checkpoint")) {
      const input = checkpoint.input as { state?: { hypotheses?: Array<Record<string, unknown>> } }
      const timeout = input.state?.hypotheses?.find((hypothesis) => hypothesis.id === "hyp_timeout")
      if (timeout !== undefined) timeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 3 seconds"
    }
    const persisted = snapshot.plugin.state?.hypotheses as Array<Record<string, unknown>>
    const timeout = persisted.find((hypothesis) => hypothesis.id === "hyp_timeout")
    if (timeout === undefined) throw new Error("missing timeout hypothesis fixture")
    timeout.statement = "CustomFilterLoader.DOWNLOAD_LIMIT_MS is 3 seconds"
    snapshot.orderedTools.splice(
      1,
      0,
      tool(
        99,
        "read",
        { filePath: "tests/custom-loader.test.ts" },
        "tests/custom-loader.test.ts\nconst DOWNLOAD_LIMIT_MS = 3 * 1000;",
      ),
    )

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reconciled-hypothesis-facts")?.passed).toBe(false)
  })

  it("rejects a resolved debug agent that can invoke bash", () => {
    const snapshot = passingSnapshot()
    snapshot.fingerprint.resolvedAgentPermission?.push({ permission: "bash", pattern: "*", action: "allow" })

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "resolved-debug-agent-permission")?.passed).toBe(false)
  })

  it("rejects tool names whose result envelope reports failure", () => {
    const snapshot = passingSnapshot()
    const run = snapshot.orderedTools.find((item) => item.name === "debug_run_start")
    if (run === undefined) throw new Error("missing run fixture")
    run.output = JSON.stringify({ ok: false, error: { code: "INVALID_TRANSITION" } })

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "prepared-pre-fix-runtime-run")?.passed).toBe(false)
  })

  it("rejects probes that only observe downstream paths after a may-fail await", () => {
    const snapshot = passingSnapshot()
    const upstream = snapshot.orderedTools.find(
      (item) =>
        item.name === "debug_probe_prepare" && (item.input as Record<string, unknown>).hypothesisId === "hyp_timeout",
    )
    if (upstream?.output === undefined) throw new Error("missing upstream preparation")
    const envelope = JSON.parse(upstream.output) as { data: Record<string, unknown> }
    envelope.data.sourceLineText = "        const parsed = FilterParser.parseFilterDataFromHeader("
    upstream.output = JSON.stringify(envelope)

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "diagnostic-before-after-pair")?.passed).toBe(false)
  })

  it("does not treat an await string literal as a may-fail operation", () => {
    const snapshot = passingSnapshot()
    const upstream = snapshot.orderedTools.find(
      (item) =>
        item.name === "debug_probe_prepare" && (item.input as Record<string, unknown>).hypothesisId === "hyp_timeout",
    )
    if (upstream?.output === undefined) throw new Error("missing upstream preparation")
    const envelope = JSON.parse(upstream.output) as { data: Record<string, unknown> }
    envelope.data.sourceLineText = '        const label = "await"'
    upstream.output = JSON.stringify(envelope)

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "diagnostic-before-after-pair")?.passed).toBe(false)
  })

  it("rejects reordered lifecycle tools", () => {
    const snapshot = passingSnapshot()
    const registerIndex = snapshot.orderedTools.findIndex(
      (item) =>
        item.name === "debug_probe_register" && (item.input as Record<string, unknown>).probeId === "probe_before",
    )
    const register = snapshot.orderedTools.splice(registerIndex, 1)[0]
    if (register === undefined) throw new Error("missing register fixture")
    const captureIndex = snapshot.orderedTools.findIndex((item) => item.name === "debug_process_capture")
    snapshot.orderedTools.splice(captureIndex + 1, 0, register)

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "prepared-pre-fix-runtime-run")?.passed).toBe(false)
  })

  it("rejects mismatched run and probe linkage", () => {
    const snapshot = passingSnapshot()
    const probe = snapshot.plugin.state?.probeRefs
    if (!Array.isArray(probe) || typeof probe[0] !== "object" || probe[0] === null) throw new Error("missing probe")
    ;(probe[0] as Record<string, unknown>).runId = "run_other"

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "prepared-pre-fix-runtime-run")?.passed).toBe(false)
  })

  it("rejects a final hypothesis slate whose checkpointed signals changed", () => {
    const snapshot = passingSnapshot()
    const finalHypotheses = snapshot.plugin.state?.hypotheses
    if (!Array.isArray(finalHypotheses) || typeof finalHypotheses[0] !== "object" || finalHypotheses[0] === null) {
      throw new Error("missing final hypothesis fixture")
    }
    ;(finalHypotheses[0] as Record<string, unknown>).confirmationSignals = ["A different signal"]

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "checkpointed-hypotheses")?.passed).toBe(false)
  })

  it("accepts a valid pre-mutation hypothesis slate checkpointed during intake", () => {
    const snapshot = passingSnapshot()
    const checkpoint = snapshot.orderedTools.find((item) => item.name === "debug_state_checkpoint")
    if (checkpoint === undefined) throw new Error("missing hypothesis checkpoint fixture")
    if (typeof checkpoint.input !== "object" || checkpoint.input === null) {
      throw new Error("missing checkpoint input fixture")
    }
    const state = (checkpoint.input as Record<string, unknown>).state
    if (typeof state !== "object" || state === null) throw new Error("missing checkpoint state fixture")
    ;(state as Record<string, unknown>).phase = "intake"

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "checkpointed-hypotheses")?.passed).toBe(true)
    expect(result.checks.find((check) => check.id === "visible-hypothesis-slate")?.passed).toBe(true)
    expect(result.passed).toBe(true)
  })

  it("keeps immutable early lifecycle receipts after successful cleanup removes plugin state", () => {
    const snapshot = passingSnapshot()
    snapshot.stopReason = "idle"
    snapshot.plugin = { found: false, evidence: [] }

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "checkpointed-hypotheses")).toMatchObject({
      passed: true,
      detail: "checkpoint=1, hypotheses=2",
    })
    expect(result.checks.find((check) => check.id === "visible-hypothesis-slate")?.passed).toBe(true)
    expect(result.passed).toBe(false)
  })

  it("does not use a missing persisted slate when the plugin snapshot still exists", () => {
    const snapshot = passingSnapshot()
    if (snapshot.plugin.manifest === undefined) throw new Error("missing manifest fixture")
    delete snapshot.plugin.state

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "checkpointed-hypotheses")?.passed).toBe(false)
  })

  it("accepts a batch only when every prepared run probe is registered, captured, and validated", () => {
    const snapshot = passingSnapshot()
    snapshot.orderedTools.splice(
      5,
      0,
      tool(
        41,
        "debug_probe_prepare",
        {
          runId: "run_1",
          hypothesisId: "hyp_timeout",
          sourceFile: "src/timeout.ts",
          sourceLine: 1,
        },
        success({ probeId: "probe_2", markerBlock: "/* owned 2 */", helperImportBlock }),
      ),
    )
    snapshot.orderedTools.splice(
      8,
      0,
      tool(
        42,
        "debug_probe_register",
        { probeId: "probe_2" },
        success({ probeId: "probe_2", status: "registered", validationStatus: "pending" }),
      ),
    )
    const capture = snapshot.orderedTools.find((item) => item.name === "debug_process_capture")
    if (capture === undefined || typeof capture.input !== "object" || capture.input === null) {
      throw new Error("missing capture fixture")
    }
    ;(capture.input as Record<string, unknown>).probeIds = ["probe_before", "probe_1", "probe_2"]
    const manifestProbes = snapshot.plugin.manifest?.probes
    const stateProbes = snapshot.plugin.state?.probeRefs
    if (!Array.isArray(manifestProbes) || !Array.isArray(stateProbes)) throw new Error("missing probe fixtures")
    manifestProbes.push({
      id: "probe_2",
      runId: "run_1",
      hypothesisId: "hyp_timeout",
      sourceFile: `${repositoryRoot}/src/timeout.ts`,
      transport: "extension-background",
      helperSourceFile: `${repositoryRoot}/src/timeout.ts`,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
      status: "validated",
      validationStatus: "validated",
    })
    stateProbes.push({
      id: "probe_2",
      runId: "run_1",
      hypothesisId: "hyp_timeout",
      sourceFile: "src/timeout.ts",
      status: "validated",
    })

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "prepared-pre-fix-runtime-run")?.passed).toBe(true)
    expect(result.passed).toBe(true)
  })

  it("accepts a replacement after a failed instrumentation check removes the previous probe", () => {
    const snapshot = passingSnapshot()
    snapshot.orderedTools.splice(
      4,
      0,
      tool(
        40,
        "debug_probe_prepare",
        {
          runId: "run_1",
          hypothesisId: "hyp_timeout",
          sourceFile: "src/timeout.ts",
          sourceLine: 1,
        },
        success({ probeId: "probe_removed", markerBlock: "/* removed owned */", helperImportBlock }),
      ),
      tool(41, "edit", { filePath: "src/timeout.ts" }),
      tool(
        42,
        "debug_probe_register",
        { probeId: "probe_removed" },
        success({ probeId: "probe_removed", status: "registered", validationStatus: "pending" }),
      ),
      tool(
        43,
        "debug_process_capture",
        { purpose: "instrumentation-check", runId: "run_1", probeIds: ["probe_removed"] },
        success({ processId: "process_failed", runId: "run_1", status: "exited", exitCode: 1 }),
      ),
      tool(
        44,
        "debug_probe_remove",
        { probeId: "probe_removed" },
        success({ probeId: "probe_removed", status: "removed", validationStatus: "failed" }),
      ),
    )
    const manifestProbes = snapshot.plugin.manifest?.probes
    if (!Array.isArray(manifestProbes)) throw new Error("missing manifest probe fixtures")
    manifestProbes.unshift({
      id: "probe_removed",
      runId: "run_1",
      hypothesisId: "hyp_timeout",
      sourceFile: `${repositoryRoot}/src/timeout.ts`,
      transport: "extension-background",
      helperSourceFile: `${repositoryRoot}/src/timeout.ts`,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
      status: "removed",
      validationStatus: "failed",
    })

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "prepared-pre-fix-runtime-run")?.passed).toBe(true)
    expect(result.passed).toBe(true)
  })

  it("does not count a non-zero instrumentation check toward active probe completeness", () => {
    const snapshot = passingSnapshot()
    const capture = snapshot.orderedTools.find((item) => item.name === "debug_process_capture")
    if (capture === undefined) throw new Error("missing capture fixture")
    capture.output = success({ processId: "process_failed", runId: "run_1", status: "exited", exitCode: 1 })

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "prepared-pre-fix-runtime-run")?.passed).toBe(false)
  })

  it("rejects a prepared run probe abandoned in pending state", () => {
    const snapshot = passingSnapshot()
    snapshot.orderedTools.splice(
      5,
      0,
      tool(
        41,
        "debug_probe_prepare",
        {
          runId: "run_1",
          hypothesisId: "hyp_timeout",
          sourceFile: "src/timeout.ts",
          sourceLine: 1,
        },
        success({ probeId: "probe_pending", markerBlock: "/* owned pending */", helperImportBlock }),
      ),
    )
    const manifestProbes = snapshot.plugin.manifest?.probes
    const stateProbes = snapshot.plugin.state?.probeRefs
    if (!Array.isArray(manifestProbes) || !Array.isArray(stateProbes)) throw new Error("missing probe fixtures")
    manifestProbes.push({
      id: "probe_pending",
      runId: "run_1",
      hypothesisId: "hyp_timeout",
      sourceFile: `${repositoryRoot}/src/timeout.ts`,
      transport: "extension-background",
      helperSourceFile: `${repositoryRoot}/src/timeout.ts`,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
      status: "planned",
      validationStatus: "pending",
    })
    stateProbes.push({
      id: "probe_pending",
      runId: "run_1",
      hypothesisId: "hyp_timeout",
      sourceFile: "src/timeout.ts",
      status: "planned",
    })

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "prepared-pre-fix-runtime-run")?.passed).toBe(false)
  })

  it.each([
    ["one", "Working hypotheses\n1. Redirect handling"],
    ["five", "Working hypotheses\n1. Redirect handling\n2. Timeout\n3. Cache\n4. Error swallowing\n5. URL persistence"],
  ])("rejects a visible %s-hypothesis slate", (_label, text) => {
    const snapshot = passingSnapshot()
    const entry = snapshot.transcript[0]
    if (entry === undefined) throw new Error("missing transcript fixture")
    entry.text = [text]

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "visible-hypothesis-slate")?.passed).toBe(false)
  })

  it("accepts a Markdown table hypothesis slate before instrumentation", () => {
    const snapshot = passingSnapshot()
    const entry = snapshot.transcript[0]
    if (entry === undefined) throw new Error("missing transcript fixture")
    entry.text = [
      [
        "**Working hypotheses** (provisional slate):",
        "| # | ID | Rank | Hypothesis | Confirmation signal | Elimination signal |",
        "| --- | --- | ---: | --- | --- | --- |",
        "| 1 | hyp_redirect | 1 | Redirect response is mishandled | Redirected response fails | Redirected response succeeds |",
        "| 2 | hyp_timeout | 2 | Download times out | Timeout fires first | Response completes before timeout |",
      ].join("\n"),
    ]

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "visible-hypothesis-slate")?.passed).toBe(true)
    expect(result.passed).toBe(true)
  })

  it("rejects a table-shaped slate without a Markdown header separator", () => {
    const snapshot = passingSnapshot()
    const entry = snapshot.transcript[0]
    if (entry === undefined) throw new Error("missing transcript fixture")
    entry.text = [
      "Working hypotheses\n| Rank | ID | Hypothesis |\n| 1 | hyp_redirect | Redirect handling |\n| 2 | hyp_timeout | Timeout |",
    ]

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "visible-hypothesis-slate")?.passed).toBe(false)
  })

  it.each([
    [
      "a second question",
      (questions: Record<string, unknown>[]) =>
        questions.push({ header: "Extra", question: "Choose a fix", options: [] }),
    ],
    [
      "a fourth option",
      (questions: Record<string, unknown>[]) => {
        const options = questions[0]?.options
        if (Array.isArray(options)) options.push({ label: "Try a fix", description: "Proceed." })
      },
    ],
    [
      "custom free-form input",
      (questions: Record<string, unknown>[]) => {
        const first = questions[0]
        if (first !== undefined) first.custom = true
      },
    ],
    [
      "multiple answers",
      (questions: Record<string, unknown>[]) => {
        const first = questions[0]
        if (first !== undefined) first.multiple = true
      },
    ],
  ])("rejects a reproduction Question with %s", (_label, mutate) => {
    const snapshot = passingSnapshot()
    const question = snapshot.question
    if (question === undefined || !Array.isArray(question.questions)) throw new Error("missing question fixture")
    mutate(question.questions as Record<string, unknown>[])

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reproduction-question")?.passed).toBe(false)
  })

  it("matches OpenCode defaults when the model omits optional Question flags", () => {
    const snapshot = passingSnapshot()
    const question = snapshot.question
    if (question === undefined || !Array.isArray(question.questions)) throw new Error("missing question fixture")
    delete (question.questions[0] as Record<string, unknown> | undefined)?.custom
    delete (question.questions[0] as Record<string, unknown> | undefined)?.multiple
    const questionTool = snapshot.orderedTools.find((entry) => entry.name === "question")
    if (questionTool !== undefined) questionTool.input = structuredClone(questionTool.input)
    const toolQuestion = (questionTool?.input as Record<string, unknown> | undefined)?.questions
    if (Array.isArray(toolQuestion)) {
      delete (toolQuestion[0] as Record<string, unknown> | undefined)?.custom
      delete (toolQuestion[0] as Record<string, unknown> | undefined)?.multiple
    }

    expect(evaluateBehavioralAcceptance(snapshot).passed).toBe(true)
  })

  it("matches a semantically complete model Question when OpenCode omits custom", () => {
    const snapshot = passingSnapshot()
    const question = snapshot.question
    if (question === undefined || !Array.isArray(question.questions)) throw new Error("missing question fixture")
    const pendingItem = question.questions[0] as Record<string, unknown> | undefined
    if (pendingItem === undefined) throw new Error("missing question item")
    pendingItem.question = `${preparedProcedure}. What happened?`
    delete pendingItem.custom

    const questionTool = snapshot.orderedTools.find((entry) => entry.name === "question")
    if (questionTool === undefined) throw new Error("missing question tool fixture")
    const modelQuestions = structuredClone(question.questions) as Record<string, unknown>[]
    questionTool.input = { questions: modelQuestions }

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reproduction-question")?.passed).toBe(true)
    expect(result.checks.find((check) => check.id === "durable-waiting-state")?.passed).toBe(true)
    expect(result.passed).toBe(true)
  })

  it("accepts the expanded five-step Question produced in run19", () => {
    const snapshot = passingSnapshot()
    const procedure =
      "Run pnpm dev chrome-mv3, reload the unpacked extension from build/dev/chrome-mv3, then: 1) Create a GitHub filter repository. 2) Subscribe to its raw filter URL in the MV3 extension. 3) Rename the repository. 4) Change the filter content. 5) Open Filters and run Check for updates. The old raw URL now redirects; the custom filter stays stale."
    const prompt =
      "Please reproduce AG-55256: run pnpm dev chrome-mv3, reload the unpacked extension from build/dev/chrome-mv3, create a GitHub filter repository, subscribe to its raw filter URL, rename the repository so the old raw URL redirects, change the filter content, then open Filters and run Check for updates. Did the custom filter remain stale?"
    const manifestRun = (snapshot.plugin.manifest?.runs as Array<Record<string, unknown>> | undefined)?.find(
      (run) => run.id === "run_1",
    )
    if (manifestRun === undefined) throw new Error("missing manifest run fixture")
    manifestRun.reproduction = procedure
    const runTool = snapshot.orderedTools.find((entry) => entry.name === "debug_run_start")
    if (runTool === undefined || typeof runTool.input !== "object" || runTool.input === null) {
      throw new Error("missing run tool fixture")
    }
    ;(runTool.input as Record<string, unknown>).reproduction = procedure
    const question = snapshot.question
    if (question === undefined || !Array.isArray(question.questions)) throw new Error("missing question fixture")
    const originalItem = question.questions[0] as Record<string, unknown> | undefined
    if (originalItem === undefined) throw new Error("missing question item")
    const options = structuredClone(originalItem.options)
    question.questions = [
      {
        question: prompt,
        header: originalItem.header,
        options,
        multiple: false,
      },
    ]
    const questionTool = snapshot.orderedTools.find((entry) => entry.name === "question")
    if (questionTool === undefined) throw new Error("missing question tool fixture")
    questionTool.input = {
      questions: [
        {
          header: originalItem.header,
          multiple: false,
          options: structuredClone(options),
          question: prompt,
        },
      ],
    }

    expect(evaluateBehavioralAcceptance(snapshot).passed).toBe(true)
  })

  it("rejects a keyword-rich Question that omits the prepared rename action", () => {
    const snapshot = passingSnapshot()
    const procedure =
      "Create a GitHub filter repository, subscribe to its raw filter URL in the MV3 extension, rename the repository, change the filter content, then open Filters and run Check for updates. The old raw URL redirects and the custom filter stays stale."
    const prompt =
      "Create a GitHub filter repository, subscribe to its raw filter URL in the MV3 extension, change the filter content, then open Filters and run Check for updates. The old raw URL redirects and the custom filter stays stale."
    const manifestRun = (snapshot.plugin.manifest?.runs as Array<Record<string, unknown>> | undefined)?.find(
      (run) => run.id === "run_1",
    )
    if (manifestRun === undefined) throw new Error("missing manifest run fixture")
    manifestRun.reproduction = procedure
    const question = snapshot.question
    if (question === undefined || !Array.isArray(question.questions)) throw new Error("missing question fixture")
    const item = question.questions[0] as Record<string, unknown> | undefined
    if (item === undefined) throw new Error("missing question item")
    item.question = prompt
    const questionTool = snapshot.orderedTools.find((entry) => entry.name === "question")
    if (questionTool === undefined) throw new Error("missing question tool fixture")
    questionTool.input = { questions: structuredClone(question.questions) }

    expect(
      evaluateBehavioralAcceptance(snapshot).checks.find((check) => check.id === "reproduction-question")?.passed,
    ).toBe(false)
  })

  it("rejects a speculative fix-choice question", () => {
    const snapshot = passingSnapshot()
    const question = snapshot.question
    if (question === undefined) throw new Error("missing question fixture")
    question.questions = [
      {
        header: "Fix direction",
        question: "Choose a fix",
        options: [
          { label: "Hypothesis A", description: "Choose redirect handling." },
          { label: "Hypothesis B", description: "Choose a timeout change." },
        ],
      },
    ]

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reproduction-question")?.passed).toBe(false)
  })

  it("rejects a disguised root-cause question even with the exact outcome options", () => {
    const snapshot = passingSnapshot()
    const question = snapshot.question
    if (question === undefined || !Array.isArray(question.questions)) throw new Error("missing question fixture")
    const item = question.questions[0] as Record<string, unknown> | undefined
    if (item === undefined) throw new Error("missing question item")
    item.question = "Update the redirected custom filter. Which root cause should we fix?"
    const questionTool = snapshot.orderedTools.find((entry) => entry.name === "question")
    const toolQuestions = (questionTool?.input as Record<string, unknown> | undefined)?.questions
    if (Array.isArray(toolQuestions) && typeof toolQuestions[0] === "object" && toolQuestions[0] !== null) {
      ;(toolQuestions[0] as Record<string, unknown>).question = item.question
    }

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reproduction-question")?.passed).toBe(false)
  })

  it("rejects a Question that does not cover the prepared reproduction procedure", () => {
    const snapshot = passingSnapshot()
    const question = snapshot.question
    if (question === undefined || !Array.isArray(question.questions)) throw new Error("missing question fixture")
    const item = question.questions[0] as Record<string, unknown> | undefined
    if (item === undefined) throw new Error("missing question item")
    item.question = "What happened after the prepared steps?"
    const questionTool = snapshot.orderedTools.find((entry) => entry.name === "question")
    const toolQuestions = (questionTool?.input as Record<string, unknown> | undefined)?.questions
    if (Array.isArray(toolQuestions) && typeof toolQuestions[0] === "object" && toolQuestions[0] !== null) {
      ;(toolQuestions[0] as Record<string, unknown>).question = item.question
    }

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "reproduction-question")?.passed).toBe(false)
  })

  it("rejects a pre-question diff that failed exact ownership validation", () => {
    const snapshot = passingSnapshot()
    snapshot.repository.exactInstrumentation = { passed: false, errors: ["behavior edit remained"] }

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(result.checks.find((check) => check.id === "only-owned-instrumentation-diff")?.passed).toBe(false)
  })

  it("rejects a validated probe whose independent semantic-boundary audit failed", () => {
    const snapshot = passingSnapshot()
    const source = [
      "async function update(url: string) {",
      "  const downloadData = await FiltersDownloader.downloadWithRaw(",
      "    url,",
      "    { validateChecksum: true },",
      "  )",
      "}",
    ].join("\n")
    const manifest = snapshot.plugin.manifest
    if (manifest === undefined) throw new Error("missing manifest fixture")
    const probe = (manifest.probes as Array<Record<string, unknown>> | undefined)?.[0]
    if (probe === undefined) throw new Error("missing manifest probe fixture")
    const markerBlock = "/* DEBUG-START run13 */\nvoid emitRun13()\n/* DEBUG-END run13 */\n"
    probe.sourceLine = 5
    probe.captures = [{ label: "filterLength", path: "downloadData.filter.length" }]
    probe.expectedBlock = markerBlock
    snapshot.repository.semanticProbeBoundaries = validateSemanticProbeBoundaries({
      projectRoot: repositoryRoot,
      files: new Map([
        [
          "src/custom-filter.ts",
          { baseline: Buffer.from(source), current: Buffer.from(insertBeforeSourceLine(source, 5, markerBlock)) },
        ],
      ]),
      manifest,
    })

    const result = evaluateBehavioralAcceptance(snapshot)

    expect(probe).toMatchObject({ status: "validated", validationStatus: "validated" })
    expect(snapshot.orderedTools.find((entry) => entry.name === "debug_process_capture")?.output).toContain(
      '"exitCode":0',
    )
    expect(result.checks.find((check) => check.id === "semantically-safe-probe-boundaries")?.passed).toBe(false)
    expect(result.passed).toBe(false)
  })
})

describe("semantic probe boundaries", () => {
  const filename = "src/custom-filter.ts"
  const markerBlock = "/* DEBUG-START semantic */\nvoid emitSemanticProbe()\n/* DEBUG-END semantic */\n"

  function validate(source: string, sourceLine: number, captures: string[] = []) {
    return validateSemanticProbeBoundaries({
      projectRoot: repositoryRoot,
      files: new Map([
        [
          filename,
          {
            baseline: Buffer.from(source),
            current: Buffer.from(insertBeforeSourceLine(source, sourceLine, markerBlock)),
          },
        ],
      ]),
      manifest: {
        probes: [
          {
            id: "probe_semantic",
            sourceFile: `${repositoryRoot}/${filename}`,
            sourceLine,
            expectedBlock: markerBlock,
            captures: captures.map((capturePath) => ({ label: capturePath, path: capturePath })),
            status: "validated",
            validationStatus: "validated",
          },
        ],
      },
    })
  }

  it("accepts a normal statement boundary after captured values initialize", () => {
    const result = validate(
      [
        "async function update(url: string) {",
        "  const downloadData = await download(url)",
        "  delete pending[url]",
        "}",
      ].join("\n"),
      3,
      ["downloadData.filter.length", "url"],
    )

    expect(result).toEqual({ passed: true, errors: [] })
  })

  it("rejects the run13 probe inserted as a third multiline call argument", () => {
    const result = validate(
      [
        "async function update(url: string) {",
        "  const downloadData = await FiltersDownloader.downloadWithRaw(",
        "    url,",
        "    { validateChecksum: true },",
        "  )",
        "  delete pending[url]",
        "}",
      ].join("\n"),
      5,
      ["url", "downloadData.filter.length", "downloadData.rawFilter.length", "downloadData.headers"],
    )

    expect(result.passed).toBe(false)
    expect(result.errors.join(" ")).toContain("not an executable statement boundary")
  })

  it("rejects insertion before an unbraced control-flow body", () => {
    const result = validate(
      ["function update(ready: boolean) {", "  if (ready)", "    performUpdate()", "}"].join("\n"),
      3,
    )

    expect(result.passed).toBe(false)
    expect(result.errors.join(" ")).toContain("not an executable statement boundary")
  })

  it("rejects capturing a variable before the selected declaration initializes it", () => {
    const result = validate(
      ["async function update(url: string) {", "  const downloadData = await download(url)", "}"].join("\n"),
      2,
      ["downloadData.filter.length"],
    )

    expect(result.passed).toBe(false)
    expect(result.errors.join(" ")).toContain("captures downloadData before")
  })

  it("accepts a statement inside a callback block nested in a multiline call", () => {
    const result = validate(["items.map(", "  (item) => {", "    consume(item)", "  },", ")"].join("\n"), 3, ["item"])

    expect(result).toEqual({ passed: true, errors: [] })
  })

  it("accepts insertion immediately before a callback block closes", () => {
    const result = validate(["items.map((item) => {", "  consume(item)", "})"].join("\n"), 3, ["item"])

    expect(result).toEqual({ passed: true, errors: [] })
  })

  it("maps multiple owned blocks to HEAD without trusting shifted manifest line numbers", () => {
    const source = ["function update(input: number) {", "  const first = input + 1", "  consume(first)", "}"].join("\n")
    const firstBlock = "/* DEBUG-START first */\nvoid emitFirst()\n/* DEBUG-END first */\n"
    const secondBlock = "/* DEBUG-START second */\nvoid emitSecond()\n/* DEBUG-END second */\n"
    const current = insertBeforeSourceLine(insertBeforeSourceLine(source, 3, secondBlock), 2, firstBlock)
    const result = validateSemanticProbeBoundaries({
      projectRoot: repositoryRoot,
      files: new Map([[filename, { baseline: Buffer.from(source), current: Buffer.from(current) }]]),
      manifest: {
        probes: [
          {
            id: "probe_first",
            sourceFile: `${repositoryRoot}/${filename}`,
            sourceLine: 2,
            captures: [{ label: "input", path: "input" }],
            expectedBlock: firstBlock,
            status: "validated",
          },
          {
            id: "probe_second",
            sourceFile: `${repositoryRoot}/${filename}`,
            sourceLine: 9,
            captures: [{ label: "first", path: "first" }],
            expectedBlock: secondBlock,
            status: "validated",
          },
        ],
      },
    })

    expect(result).toEqual({ passed: true, errors: [] })
  })
})

describe("exact instrumentation ownership", () => {
  const filename = "src/custom-filter.ts"
  const markerStart = "/* DEBUG-START opencode-debug-mode session=s run=r hypothesis=h probe=p */"
  const markerEnd = "/* DEBUG-END opencode-debug-mode session=s run=r hypothesis=h probe=p */"
  const expectedBlock = `${markerStart}\nconsole.debug("probe")\n${markerEnd}\n`
  const baseline = Buffer.from("export const value = 1\n")
  const probe = {
    id: "probe_1",
    sourceFile: `${repositoryRoot}/${filename}`,
    sourceLine: 1,
    captures: [],
    validationStatus: "validated",
    markerStart,
    markerEnd,
    expectedBlock,
    expectedHash: createHash("sha256").update(expectedBlock).digest("hex"),
  }

  function files(current: Buffer, original: Buffer | null = baseline): Map<string, InstrumentationFileSnapshot> {
    return new Map([[filename, { baseline: original, current }]])
  }

  it("accepts only the exact declared marker block", () => {
    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(Buffer.concat([baseline, Buffer.from(expectedBlock)])),
      manifest: { probes: [probe], ownedFiles: [], permissionChanges: [] },
    })

    expect(result).toEqual({ passed: true, errors: [] })
  })

  it.skipIf(process.platform === "win32")(
    "canonicalizes a symlinked repository alias before validating absolute ownership paths",
    async () => {
      const container = await mkdtemp(path.join(tmpdir(), "opencode-acceptance-repository-alias-"))
      onTestFinished(() => rm(container, { recursive: true, force: true }))
      const repository = path.join(container, "repository")
      const repositoryAlias = path.join(container, "repository-alias")
      const sourceDirectory = path.join(repository, "src")
      const sourceFile = path.join(sourceDirectory, "custom-filter.ts")
      await mkdir(sourceDirectory, { recursive: true })
      await writeFile(sourceFile, baseline)
      await executeFile("git", ["init", "--quiet"], { cwd: repository })
      await executeFile("git", ["add", filename], { cwd: repository })
      await executeFile(
        "git",
        [
          "-c",
          "user.name=Acceptance Test",
          "-c",
          "user.email=acceptance@example.test",
          "commit",
          "--quiet",
          "-m",
          "baseline",
        ],
        { cwd: repository },
      )
      await writeFile(sourceFile, Buffer.concat([baseline, Buffer.from(expectedBlock)]))
      await symlink(repository, repositoryAlias, "dir")
      const canonicalRepository = await realpath(repository)

      const capture = await captureRepository(repositoryAlias, process.env, {
        probes: [{ ...probe, sourceFile: path.join(canonicalRepository, filename) }],
        ownedFiles: [],
        permissionChanges: [],
      })

      expect(capture.root).toBe(canonicalRepository)
      expect(capture.exactInstrumentation).toEqual({ passed: true, errors: [] })
      expect(capture.semanticProbeBoundaries).toEqual({ passed: true, errors: [] })
    },
  )

  it("accepts an adjacent separator only when it is part of the declared owned block", () => {
    const ownedBlock = `\n${expectedBlock}\n`
    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(Buffer.concat([baseline, Buffer.from(ownedBlock)])),
      manifest: {
        probes: [
          {
            ...probe,
            expectedBlock: ownedBlock,
            expectedHash: createHash("sha256").update(ownedBlock).digest("hex"),
          },
        ],
        ownedFiles: [],
        permissionChanges: [],
      },
    })

    expect(result).toEqual({ passed: true, errors: [] })
  })

  it("discovers indented helper markers while retaining exact block and hash checks", () => {
    const helperMarkerStart =
      "  /* DEBUG-START opencode-debug-mode session=s run=r hypothesis=h probe=p resource=transport-import */"
    const helperMarkerEnd =
      "  /* DEBUG-END opencode-debug-mode session=s run=r hypothesis=h probe=p resource=transport-import */"
    const indentedHelperBlock = `${helperMarkerStart}\n  import { emit } from "./transport.mjs"\n${helperMarkerEnd}\n`
    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(Buffer.concat([baseline, Buffer.from(expectedBlock), Buffer.from(indentedHelperBlock)])),
      manifest: {
        probes: [
          {
            ...probe,
            helperSourceFile: `${repositoryRoot}/${filename}`,
            helperImportBlock: indentedHelperBlock,
            helperImportHash: createHash("sha256").update(indentedHelperBlock).digest("hex"),
          },
        ],
        ownedFiles: [],
        permissionChanges: [],
      },
    })

    expect(result).toEqual({ passed: true, errors: [] })
  })

  it("accepts a replacement probe in the same file after the previous probe and helper import were removed", () => {
    const removedMarkerStart = markerStart.replace("probe=p", "probe=removed")
    const removedMarkerEnd = markerEnd.replace("probe=p", "probe=removed")
    const removedBlock = `${removedMarkerStart}\nconsole.debug("removed")\n${removedMarkerEnd}\n`
    const removedHelperStart = removedMarkerStart.replace(" */", " resource=transport-import */")
    const removedHelperEnd = removedMarkerEnd.replace(" */", " resource=transport-import */")
    const removedHelperBlock = `${removedHelperStart}\nimport { emit } from "./old-transport.mjs"\n${removedHelperEnd}\n`
    const replacementMarkerStart = markerStart.replace("probe=p", "probe=replacement")
    const replacementMarkerEnd = markerEnd.replace("probe=p", "probe=replacement")
    const replacementBlock = `${replacementMarkerStart}\nconsole.debug("replacement")\n${replacementMarkerEnd}\n`
    const replacementHelperStart = replacementMarkerStart.replace(" */", " resource=transport-import */")
    const replacementHelperEnd = replacementMarkerEnd.replace(" */", " resource=transport-import */")
    const replacementHelperBlock = `${replacementHelperStart}\nimport { emit } from "./new-transport.mjs"\n${replacementHelperEnd}\n`
    const removedProbe = {
      ...probe,
      id: "probe_removed",
      status: "removed",
      validationStatus: "failed",
      markerStart: removedMarkerStart,
      markerEnd: removedMarkerEnd,
      expectedBlock: removedBlock,
      expectedHash: createHash("sha256").update(removedBlock).digest("hex"),
      helperSourceFile: `${repositoryRoot}/${filename}`,
      helperImportBlock: removedHelperBlock,
      helperImportHash: createHash("sha256").update(removedHelperBlock).digest("hex"),
    }
    const replacementProbe = {
      ...probe,
      id: "probe_replacement",
      markerStart: replacementMarkerStart,
      markerEnd: replacementMarkerEnd,
      expectedBlock: replacementBlock,
      expectedHash: createHash("sha256").update(replacementBlock).digest("hex"),
      helperSourceFile: `${repositoryRoot}/${filename}`,
      helperImportBlock: replacementHelperBlock,
      helperImportHash: createHash("sha256").update(replacementHelperBlock).digest("hex"),
    }
    const current = Buffer.concat([baseline, Buffer.from(replacementBlock), Buffer.from(replacementHelperBlock)])

    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(current),
      manifest: { probes: [removedProbe, replacementProbe], ownedFiles: [], permissionChanges: [] },
    })

    expect(result).toEqual({ passed: true, errors: [] })
  })

  it("rejects remnants of a removed probe and helper import beside its replacement", () => {
    const removedMarkerStart = markerStart.replace("probe=p", "probe=removed")
    const removedMarkerEnd = markerEnd.replace("probe=p", "probe=removed")
    const removedBlock = `${removedMarkerStart}\nconsole.debug("removed")\n${removedMarkerEnd}\n`
    const removedHelperStart = removedMarkerStart.replace(" */", " resource=transport-import */")
    const removedHelperEnd = removedMarkerEnd.replace(" */", " resource=transport-import */")
    const removedHelperBlock = `${removedHelperStart}\nimport { emit } from "./old-transport.mjs"\n${removedHelperEnd}\n`
    const removedProbe = {
      ...probe,
      status: "removed",
      markerStart: removedMarkerStart,
      markerEnd: removedMarkerEnd,
      expectedBlock: removedBlock,
      expectedHash: createHash("sha256").update(removedBlock).digest("hex"),
      helperSourceFile: `${repositoryRoot}/${filename}`,
      helperImportBlock: removedHelperBlock,
      helperImportHash: createHash("sha256").update(removedHelperBlock).digest("hex"),
    }
    const current = Buffer.concat([
      baseline,
      Buffer.from(expectedBlock),
      Buffer.from(removedBlock),
      Buffer.from(removedHelperBlock),
    ])

    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(current),
      manifest: { probes: [removedProbe, probe], ownedFiles: [], permissionChanges: [] },
    })

    expect(result.passed).toBe(false)
    expect(result.errors).toContain(`removed probe ownership remained in the source: ${filename}`)
    expect(result.errors).toContain(`removed helper import ownership remained in the source: ${filename}`)
  })

  it("rejects marker-stripped emitter and helper import remnants from a removed probe", () => {
    const removedMarkerStart = markerStart.replace("probe=p", "probe=removed")
    const removedMarkerEnd = markerEnd.replace("probe=p", "probe=removed")
    const removedEmitter = "__opencodeDebugEmit_deadbeefcafe"
    const removedBlock =
      `${removedMarkerStart}\n` + `void ${removedEmitter}({ probeId: "probe_removed" })\n` + `${removedMarkerEnd}\n`
    const removedHelperStart = removedMarkerStart.replace(" */", " resource=transport-import */")
    const removedHelperEnd = removedMarkerEnd.replace(" */", " resource=transport-import */")
    const removedImport = `import { __opencodeDebugEmit as ${removedEmitter} } from "./old-transport.mjs"`
    const removedHelperBlock = `${removedHelperStart}\n${removedImport}\n${removedHelperEnd}\n`
    const removedProbe = {
      ...probe,
      id: "probe_removed",
      status: "removed",
      markerStart: removedMarkerStart,
      markerEnd: removedMarkerEnd,
      expectedBlock: removedBlock,
      expectedHash: createHash("sha256").update(removedBlock).digest("hex"),
      helperSourceFile: `${repositoryRoot}/${filename}`,
      helperImportBlock: removedHelperBlock,
      helperImportHash: createHash("sha256").update(removedHelperBlock).digest("hex"),
    }
    const current = Buffer.concat([
      baseline,
      Buffer.from(expectedBlock),
      Buffer.from(`void ${removedEmitter}()\n${removedImport}\n`),
    ])

    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(current),
      manifest: { probes: [removedProbe, probe], ownedFiles: [], permissionChanges: [] },
    })

    expect(result.errors).toContain(`removed probe ownership remained in the source: ${filename}`)
    expect(result.errors).toContain(`removed helper import ownership remained in the source: ${filename}`)
  })

  it("still rejects an indented helper block whose declared hash is wrong", () => {
    const helperMarkerStart =
      "  /* DEBUG-START opencode-debug-mode session=s run=r hypothesis=h probe=p resource=transport-import */"
    const helperMarkerEnd =
      "  /* DEBUG-END opencode-debug-mode session=s run=r hypothesis=h probe=p resource=transport-import */"
    const indentedHelperBlock = `${helperMarkerStart}\n  import { emit } from "./transport.mjs"\n${helperMarkerEnd}\n`
    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(Buffer.concat([baseline, Buffer.from(expectedBlock), Buffer.from(indentedHelperBlock)])),
      manifest: {
        probes: [
          {
            ...probe,
            helperSourceFile: `${repositoryRoot}/${filename}`,
            helperImportBlock: indentedHelperBlock,
            helperImportHash: "0".repeat(64),
          },
        ],
        ownedFiles: [],
        permissionChanges: [],
      },
    })

    expect(result.passed).toBe(false)
    expect(result.errors.join(" ")).toContain("incomplete or ambiguous")
  })

  it("rejects a behavior edit hidden beside an exact marker block", () => {
    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [],
      files: files(Buffer.from(`export const value = 2\n${expectedBlock}`)),
      manifest: { probes: [probe], ownedFiles: [], permissionChanges: [] },
    })

    expect(result.passed).toBe(false)
    expect(result.errors.join(" ")).toContain("non-instrumentation edits")
  })

  it("rejects undeclared untracked files", () => {
    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [filename],
      files: files(Buffer.from("surprise\n"), null),
      manifest: { probes: [], ownedFiles: [], permissionChanges: [] },
    })

    expect(result.passed).toBe(false)
    expect(result.errors.join(" ")).toContain("undeclared untracked file")
  })

  it("rejects an owned helper whose hash does not match", () => {
    const result = validateExactInstrumentationChanges({
      projectRoot: repositoryRoot,
      changedFiles: [filename],
      untrackedFiles: [filename],
      files: files(Buffer.from("helper\n"), null),
      manifest: {
        probes: [],
        permissionChanges: [],
        ownedFiles: [{ path: filename, sha256: "0".repeat(64), bytes: 7 }],
      },
    })

    expect(result.passed).toBe(false)
    expect(result.errors.join(" ")).toContain("hash or size did not match")
  })
})

describe("behavioral harness isolation and redaction", () => {
  it("enforces a hard deadline when an SDK request ignores abort", async () => {
    const controller = new AbortController()
    const stuckRequest = new Promise<never>(() => undefined)

    await expect(withAbortControllerDeadline("stuck SDK request", 10, controller, () => stuckRequest)).rejects.toThrow(
      "stuck SDK request exceeded its 10ms deadline",
    )
    expect(controller.signal.aborted).toBe(true)
  })

  it("keeps only launch-safe variables and owns OpenCode, HOME, and Git configuration", () => {
    const environment = createIsolatedEnvironment(
      {
        PATH: "relative:/usr/bin::/bin:/usr/bin",
        LANG: "en_US.UTF-8",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        GH_TOKEN: "github-secret",
        NPM_TOKEN: "npm-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        INTERNAL_PASSWORD: "password",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
        NODE_PATH: "/tmp/modules",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        LD_PRELOAD: "/tmp/inject.so",
        GIT_CONFIG_COUNT: "1",
        GIT_EXTERNAL_DIFF: "/tmp/diff-helper",
        DATABASE_URL: "postgres://user:password@localhost/db",
        HTTPS_PROXY: "http://proxy-user:proxy-password@localhost:3128",
        SAFE_CONTEXT: "must-not-cross-the-boundary",
      },
      {
        home: "/tmp/home",
        config: "/tmp/config/opencode",
        data: "/tmp/data",
        state: "/tmp/state",
        cache: "/tmp/cache",
        temp: "/tmp/temp",
      },
    )

    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/tmp/home",
      USERPROFILE: "/tmp/home",
      OPENCODE_CONFIG_DIR: "/tmp/config/opencode",
      XDG_DATA_HOME: "/tmp/data",
      XDG_STATE_HOME: "/tmp/state",
      XDG_CACHE_HOME: "/tmp/cache",
      TMPDIR: "/tmp/temp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    })
    expect(environment.SSH_AUTH_SOCK).toBeUndefined()
    expect(environment.GH_TOKEN).toBeUndefined()
    expect(environment.NPM_TOKEN).toBeUndefined()
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(environment.INTERNAL_PASSWORD).toBeUndefined()
    expect(environment.NODE_OPTIONS).toBeUndefined()
    expect(environment.NODE_PATH).toBeUndefined()
    expect(environment.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(environment.LD_PRELOAD).toBeUndefined()
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined()
    expect(environment.GIT_EXTERNAL_DIFF).toBeUndefined()
    expect(environment.DATABASE_URL).toBeUndefined()
    expect(environment.HTTPS_PROXY).toBeUndefined()
    expect(environment.SAFE_CONTEXT).toBeUndefined()
  })

  it("copies only the selected provider auth entry", () => {
    const auth = createSelectedProviderAuth(
      {
        tokenguard: { type: "api", key: "provider-secret" },
        "github-copilot": { type: "oauth", refresh: "other-secret" },
      },
      "tokenguard",
    )

    expect(auth).toEqual({ tokenguard: { type: "api", key: "provider-secret" } })
    expect(auth["github-copilot"]).toBeUndefined()
    expect(() => createSelectedProviderAuth({}, "tokenguard")).toThrow("no entry")
  })

  it("redacts bare key fields without redacting words that merely end in key", () => {
    expect(redactText("Authorization: Bearer top-secret-token")).toBe("Authorization: [REDACTED]")
    expect(redactText("token=ghp_abcdefghijklmnopqrstuvwxyz123456")).toBe("token=[REDACTED_TOKEN]")
    expect(redactText("token=github_pat_abcdefghijklmnopqrstuvwxyz123456")).toBe("token=[REDACTED_TOKEN]")
    expect(redactText("key=provider-secret monkey=visible")).toBe("key=[REDACTED] monkey=visible")
    expect(
      sanitizeForReport({ key: "secret", token: "secret", nested: { apiKey: "secret", safe: "visible" } }),
    ).toEqual({
      key: "[REDACTED]",
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "visible" },
    })
  })

  it("redacts exact opaque auth and credentialed URL values that do not match token formats", () => {
    const authSecret = "opaque-provider-credential"
    const oauthAccess = "opaque-oauth-access-value"
    const oauthRefresh = "opaque-oauth-refresh-value"
    const databaseUrl = "postgres://fixture:opaque-password@localhost/private"
    const values = collectSensitiveValues(
      { DATABASE_URL: databaseUrl },
      {
        tokenguard: { type: "api", key: authSecret },
        oauth: { type: "oauth", access: oauthAccess, refresh: oauthRefresh, expires: 123 },
      },
    )

    expect(
      redactText(`auth=${authSecret} access=${oauthAccess} refresh=${oauthRefresh} database=${databaseUrl}`, values),
    ).toBe("auth=[REDACTED] access=[REDACTED] refresh=[REDACTED] database=[REDACTED]")
    expect(sanitizeForReport({ message: `provider returned ${authSecret}` }, values)).toEqual({
      message: "provider returned [REDACTED]",
    })
    expect(JSON.parse(sanitizeToolOutput(JSON.stringify({ ok: false, message: authSecret }), values))).toEqual({
      ok: false,
      message: "[REDACTED]",
    })
  })

  it("redacts an opaque secret before truncating an artifact", () => {
    const secret = "opaque-secret-crossing-the-artifact-cutoff"
    const value = `${"x".repeat(64 * 1024 - 8)}${secret}${"y".repeat(128)}`

    const redacted = redactText(value, [secret])

    expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain(secret.slice(0, 8))
    expect(redacted).toContain("[TRUNCATED]")
  })

  it("keeps redacted structured tool output valid JSON", () => {
    const output = sanitizeToolOutput(
      JSON.stringify({ ok: true, data: { status: "complete", secret: { status: "success" } } }),
    )

    expect(JSON.parse(output)).toEqual({
      ok: true,
      data: { status: "complete", secret: "[REDACTED]" },
    })
  })

  it("defaults to the documented small DeepSeek Flash CLI profile", () => {
    const options = parseHarnessOptions([], { HOME: "/Users/test" })

    expect(options.profile).toBe("synthetic-cli")
    expect(options.opencode).toBe("/Users/test/.opencode/bin/opencode")
    expect(options.expectedVersion).toBe("1.18.3")
    expect(options.source).toContain("fixtures/feature-flag-bug")
    expect(options.commit).toBe("")
    expect(options.model).toBe("tokenguard/deepseek-v4-flash")
    expect(options.variant).toBe("high")
    expect(options.prompt).toContain("team/acme")
    expect(options.baseConfig).toBe("/Users/test/.config/opencode/opencode.jsonc")
    expect(options.prepareCommand).toBe("")
    expect(options).not.toHaveProperty("timeoutMs")
    expect(() => parseHarnessOptions(["--timeout-ms", "1000"], { HOME: "/Users/test" })).toThrow(
      "Unknown option: --timeout-ms",
    )

    const ag = parseHarnessOptions(["--profile", "ag-55256"], { HOME: "/Users/test" })
    expect(ag).toMatchObject({
      profile: "ag-55256",
      commit: "3db0d614806984803cc4d5976fd64d78917999f2",
      prepareCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    })
    expect(ag.prompt).toContain("AG-55256")
  })

  it("projects only the selected JSONC provider into the isolated config", () => {
    const base = parseBaseConfig(`{
      // These global definitions must not leak into the harness.
      "plugin": ["some-global-plugin"],
      "agent": { "other": { "prompt": "global" } },
      "permission": { "*": "deny" },
      "model": "tokenguard/glm-5.2",
      "small_model": "other/small",
      "provider": {
        "tokenguard": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "https://example.test/v1" },
          "models": { "glm-5.2": { "name": "GLM 5.2" } },
        },
        "other": { "npm": "other-provider" },
      },
    }`)

    const isolated = createSelectedProviderConfig(base, "tokenguard", "file:///repo/dist/index.js")

    expect(isolated).toEqual({
      model: "tokenguard/glm-5.2",
      provider: {
        tokenguard: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://example.test/v1" },
          models: { "glm-5.2": { name: "GLM 5.2" } },
        },
      },
      plugin: ["file:///repo/dist/index.js"],
      share: "disabled",
      autoupdate: false,
      default_agent: "debug",
      permission: {
        "*": "allow",
        bash: {
          "*": "allow",
          "git push": "deny",
          "git push *": "deny",
          "git commit": "deny",
          "git commit *": "deny",
          "git tag": "deny",
          "git tag *": "deny",
          "gh *": "deny",
          "bb *": "deny",
          "npm publish": "deny",
          "npm publish *": "deny",
          "pnpm publish": "deny",
          "pnpm publish *": "deny",
          "yarn publish": "deny",
          "yarn publish *": "deny",
        },
        external_directory: "deny",
        debug_process_external: "deny",
        question: "allow",
      },
    })
    expect(isolated.agent).toBeUndefined()
  })

  it("rejects inline provider credentials instead of copying them", () => {
    expect(() =>
      createSelectedProviderConfig(
        { provider: { tokenguard: { options: { baseURL: "https://example.test/v1", apiKey: "inline" } } } },
        "tokenguard",
        "file:///repo/dist/index.js",
      ),
    ).toThrow("inline credential")
  })
})
