import { describe, expect, it } from "vitest"
import {
  type BehavioralSnapshot,
  evaluateSyntheticCliAcceptance,
  type OrderedTool,
  REQUIRED_DEBUG_TOOLS,
} from "../../scripts/opencode-behavioral-acceptance.js"

const promptSha256 = "a".repeat(64)
const packageVersion = "0.1.3"
const repositoryRoot = "/tmp/opencode-debug-acceptance/repo"
const reproduction = "npm test"
const reproductionCommand = {
  executable: "node",
  args: ["--test", "test/feature-flags.test.mjs"],
  cwd: repositoryRoot,
  env: {},
}
const fixPatch = `diff --git a/src/feature-flags.mjs b/src/feature-flags.mjs
--- a/src/feature-flags.mjs
+++ b/src/feature-flags.mjs
@@ -7,1 +7,1 @@
-  const fileName = \`\${encodeURI(accountId)}.json\`
+  const fileName = \`\${encodeURIComponent(accountId)}.json\`
`

function success(data: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, data, warnings: [] })
}

function tool(
  index: number,
  name: string,
  input: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): OrderedTool {
  return {
    index,
    messageIndex: index,
    partIndex: 0,
    name,
    status: "completed",
    input,
    output: success(data),
  }
}

function hypotheses(): Record<string, unknown>[] {
  return [
    {
      id: "hyp_path_encoding",
      rank: 1,
      statement: "The account ID maps to the wrong data-file path",
      confirmationSignals: ["The attempted path preserves the slash"],
      eliminationSignals: ["The attempted path uses the encoded filename"],
      status: "open",
      evidenceRefs: [],
    },
    {
      id: "hyp_record_shape",
      rank: 2,
      statement: "The checked-in record does not expose beta=true",
      confirmationSignals: ["JSON parses without a beta flag"],
      eliminationSignals: ["The parsed record contains beta=true"],
      status: "open",
      evidenceRefs: [],
    },
  ]
}

function passingSnapshot(): BehavioralSnapshot {
  const orderedTools: OrderedTool[] = [
    tool(0, "debug_session_start", { keepArtifacts: false }, { plugin: { packageVersion, promptSha256 } }),
    tool(1, "debug_state_checkpoint", {
      expectedRevision: 0,
      state: { phase: "hypotheses", hypotheses: hypotheses(), runs: [], probeRefs: [] },
    }),
    tool(
      2,
      "debug_run_start",
      { label: "pre-fix", reproduction },
      { runId: "run_pre", label: "pre-fix", status: "running" },
    ),
    tool(
      3,
      "debug_probe_prepare",
      {
        runId: "run_pre",
        hypothesisId: "hyp_path_encoding",
        sourceFile: "src/feature-flags.mjs",
        sourceLine: 12,
        captures: [{ label: "filePath", path: "filePath" }],
        transport: "process",
      },
      {
        probeId: "probe_before",
        source: "src/feature-flags.mjs",
        line: 12,
        sourceLineText: '    const raw = await readFile(filePath, "utf8")',
      },
    ),
    tool(4, "edit", { filePath: "src/feature-flags.mjs" }),
    tool(5, "debug_probe_register", { probeId: "probe_before" }, { probeId: "probe_before", status: "registered" }),
    tool(
      6,
      "debug_probe_prepare",
      {
        runId: "run_pre",
        hypothesisId: "hyp_record_shape",
        sourceFile: "src/feature-flags.mjs",
        sourceLine: 13,
        captures: [{ label: "raw", path: "raw" }],
        transport: "process",
      },
      {
        probeId: "probe_after",
        source: "src/feature-flags.mjs",
        line: 13,
        sourceLineText: "    const record = JSON.parse(raw)",
      },
    ),
    tool(7, "edit", { filePath: "src/feature-flags.mjs" }),
    tool(8, "debug_probe_register", { probeId: "probe_after" }, { probeId: "probe_after", status: "registered" }),
    tool(
      9,
      "debug_process_capture",
      { purpose: "instrumentation-check", runId: "run_pre", probeIds: ["probe_before", "probe_after"] },
      { exitCode: 0, validatedProbeIds: ["probe_before", "probe_after"] },
    ),
    tool(
      10,
      "debug_process_capture",
      { purpose: "reproduction", runId: "run_pre", ...reproductionCommand },
      { exitCode: 1, issueReproduced: true, probeEvents: 1, probeIds: ["probe_before", "probe_after"] },
    ),
    tool(
      11,
      "debug_run_finish",
      { runId: "run_pre", issueReproduced: true },
      { runId: "run_pre", issueReproduced: true, status: "failed" },
    ),
    tool(
      12,
      "debug_evidence_read",
      { runId: "run_pre" },
      {
        events: [
          {
            id: "event_path",
            probeId: "probe_before",
            data: { accountId: "team/acme", filePath: "data/team/acme.json", errorCode: "ENOENT" },
          },
        ],
      },
    ),
    tool(13, "debug_state_checkpoint", {
      expectedRevision: 1,
      state: {
        phase: "fixing",
        hypotheses: hypotheses(),
        decidingEvidenceIds: ["event_path"],
        fixedFiles: ["src/feature-flags.mjs"],
      },
    }),
    tool(14, "edit", { filePath: "src/feature-flags.mjs" }),
    tool(
      15,
      "debug_run_start",
      { label: "post-fix", reproduction },
      { runId: "run_post", label: "post-fix", status: "running" },
    ),
    tool(
      16,
      "debug_process_capture",
      { purpose: "verification", runId: "run_post", ...reproductionCommand },
      { exitCode: 0, issueReproduced: false },
    ),
    tool(
      17,
      "debug_run_finish",
      { runId: "run_post", issueReproduced: false },
      { runId: "run_post", issueReproduced: false, status: "passed" },
    ),
    tool(18, "debug_cleanup", {}, { status: "complete" }),
  ]

  const repository = {
    root: repositoryRoot,
    status: " M src/feature-flags.mjs\n",
    patch: fixPatch,
    changedFiles: ["src/feature-flags.mjs"],
    untrackedFiles: [],
  }

  return {
    fingerprint: {
      profileId: "synthetic-cli",
      model: "tokenguard/deepseek-v4-flash",
      variant: "high",
      sourceRevision: `fixture-tree:${"f".repeat(40)}`,
      opencodeVersion: "1.18.3",
      expectedVersion: "1.18.3",
      packageVersion,
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
      debugSessionStart: { packageVersion, promptSha256 },
    },
    stopReason: "idle",
    pendingQuestions: [],
    openCodeSessionStatus: { type: "idle" },
    orderedTools,
    transcript: [
      {
        messageIndex: 1,
        role: "assistant",
        text: [
          "Working hypotheses\n1. H1 — The account ID maps to the wrong data-file path\n2. H2 — The record shape omits beta=true",
        ],
        tools: [{ name: "debug_state_checkpoint", status: "completed" }],
      },
      {
        messageIndex: 13,
        role: "assistant",
        text: ["Evidence decision: event_path confirms the failing encoded-path hypothesis; apply the minimal fix."],
        tools: [{ name: "debug_state_checkpoint", status: "completed" }],
      },
    ],
    sessionDiff: [],
    repository,
    plugin: { found: false, evidence: [] },
    postCleanup: {
      remainingPluginSessionDirectories: [],
      repository: { ...repository },
    },
  }
}

function check(snapshot: BehavioralSnapshot, id: string): boolean | undefined {
  return evaluateSyntheticCliAcceptance(snapshot).checks.find((item) => item.id === id)?.passed
}

describe("synthetic CLI behavioral acceptance", () => {
  it("accepts an autonomous evidence-backed fix and same-path verification", () => {
    const result = evaluateSyntheticCliAcceptance(passingSnapshot())

    expect(result.passed).toBe(true)
    expect(result.checks.every((item) => item.passed)).toBe(true)
  })

  it("accepts JSON-string checkpoint states emitted by OpenCode", () => {
    const snapshot = passingSnapshot()
    for (const checkpoint of snapshot.orderedTools.filter((item) => item.name === "debug_state_checkpoint")) {
      const input = checkpoint.input as Record<string, unknown>
      input.state = JSON.stringify(input.state)
    }

    const result = evaluateSyntheticCliAcceptance(snapshot)

    expect(result.passed).toBe(true)
    expect(check(snapshot, "synthetic-visible-hypotheses")).toBe(true)
    expect(check(snapshot, "synthetic-evidence-backed-fix")).toBe(true)
  })

  it("rejects a run that stops for a Question instead of completing autonomously", () => {
    const snapshot = passingSnapshot()
    snapshot.stopReason = "question"
    snapshot.question = { id: "question_1", questions: [] }
    snapshot.pendingQuestions = [snapshot.question]

    expect(check(snapshot, "synthetic-autonomous-completion")).toBe(false)
  })

  it("rejects repeated protocol-error loops even when the lifecycle eventually completes", () => {
    const snapshot = passingSnapshot()
    const repeatedErrors = [0, 1, 2].map((offset) => {
      const failed = tool(100 + offset, "debug_state_checkpoint")
      failed.output = JSON.stringify({
        ok: false,
        error: { code: "INVALID_PHASE", message: "The same recovery instruction was ignored" },
      })
      return failed
    })
    snapshot.orderedTools.splice(-1, 0, ...repeatedErrors)

    expect(check(snapshot, "synthetic-no-protocol-loop")).toBe(false)
  })

  it("matches same-path verification by process invocation rather than description wording", () => {
    const snapshot = passingSnapshot()
    const postStart = snapshot.orderedTools.find(
      (item) => item.name === "debug_run_start" && JSON.stringify(item.input).includes("post-fix"),
    )
    if (postStart === undefined) throw new Error("missing post-fix run")
    const postStartInput = postStart.input as Record<string, unknown>
    postStartInput.reproduction = "equivalent human-readable wording"

    expect(check(snapshot, "synthetic-same-path-verification")).toBe(true)
  })

  it("rejects post-fix verification that runs a different command", () => {
    const snapshot = passingSnapshot()
    const verification = snapshot.orderedTools.find(
      (item) => item.name === "debug_process_capture" && JSON.stringify(item.input).includes("verification"),
    )
    if (verification === undefined) throw new Error("missing verification capture")
    const verificationInput = verification.input as Record<string, unknown>
    verificationInput.args = ["--test", "test/other.test.mjs"]

    expect(check(snapshot, "synthetic-same-path-verification")).toBe(false)
  })

  it("accepts one decisive runtime probe without prescribing a probe pair", () => {
    const snapshot = passingSnapshot()
    snapshot.orderedTools = snapshot.orderedTools.filter((item) => ![6, 7, 8].includes(item.index))
    const instrumentation = snapshot.orderedTools.find(
      (item) => item.name === "debug_process_capture" && JSON.stringify(item.input).includes("instrumentation-check"),
    )
    if (instrumentation === undefined) throw new Error("missing instrumentation check")
    const instrumentationInput = instrumentation.input as Record<string, unknown>
    instrumentationInput.probeIds = ["probe_before"]
    instrumentation.output = success({ exitCode: 0, validatedProbeIds: ["probe_before"] })

    const result = evaluateSyntheticCliAcceptance(snapshot)

    expect(result.passed).toBe(true)
    expect(check(snapshot, "synthetic-runtime-probe")).toBe(true)
  })

  it("bounds hypothesis visibility by the first successful probe preparation", () => {
    const snapshot = passingSnapshot()
    const receipt = snapshot.transcript.find((entry) => entry.text.some((text) => /Working hypotheses/u.test(text)))
    const successfulProbe = snapshot.orderedTools.find((item) => item.name === "debug_probe_prepare")
    if (receipt === undefined || successfulProbe === undefined) throw new Error("missing hypothesis receipt fixture")
    receipt.messageIndex = 4
    successfulProbe.messageIndex = 5
    const failedProbe = tool(99, "debug_probe_prepare", {
      runId: "run_pre",
      hypothesisId: "hyp_path_encoding",
      transport: "process",
    })
    failedProbe.messageIndex = 3
    failedProbe.output = JSON.stringify({ ok: false, error: { code: "INVALID_PHASE" } })
    snapshot.orderedTools.splice(3, 0, failedProbe)

    expect(check(snapshot, "synthetic-visible-hypotheses")).toBe(true)
  })

  it("uses the latest corrected hypothesis checkpoint before instrumentation", () => {
    const snapshot = passingSnapshot()
    const corrected = snapshot.orderedTools.find((item) => item.name === "debug_state_checkpoint" && item.index === 1)
    const receipt = snapshot.transcript.find((entry) => entry.text.some((text) => /Working hypotheses/u.test(text)))
    const firstProbe = snapshot.orderedTools.find((item) => item.name === "debug_probe_prepare" && item.index === 3)
    if (corrected === undefined || receipt === undefined || firstProbe === undefined) {
      throw new Error("missing hypothesis fixture")
    }
    corrected.messageIndex = 2
    receipt.messageIndex = 2
    firstProbe.messageIndex = 3
    const early = tool(99, "debug_state_checkpoint", {
      expectedRevision: 0,
      state: {
        phase: "hypotheses",
        hypotheses: [
          ...hypotheses(),
          {
            id: "hyp_early_extra",
            rank: 3,
            statement: "Early extra hypothesis",
            confirmationSignals: ["extra signal"],
            eliminationSignals: ["extra elimination"],
            status: "open",
            evidenceRefs: [],
          },
        ],
      },
    })
    early.messageIndex = 1
    snapshot.orderedTools.splice(1, 0, early)

    expect(check(snapshot, "synthetic-visible-hypotheses")).toBe(true)
  })

  it("ignores a later phase checkpoint that repeats the same hypothesis slate", () => {
    const snapshot = passingSnapshot()
    const repeated = tool(99, "debug_state_checkpoint", {
      expectedRevision: 1,
      state: {
        phase: "instrumenting",
        hypotheses: hypotheses(),
        runs: [{ id: "run_pre", label: "pre-fix", status: "running", evidenceRefs: [] }],
        probeRefs: [],
      },
    })
    repeated.messageIndex = 2
    snapshot.orderedTools.splice(3, 0, repeated)

    const result = evaluateSyntheticCliAcceptance(snapshot)

    expect(result.passed).toBe(true)
    expect(check(snapshot, "synthetic-visible-hypotheses")).toBe(true)
    expect(check(snapshot, "synthetic-runtime-probe")).toBe(true)
  })

  it("ignores a prepared probe that was abandoned before registration", () => {
    const snapshot = passingSnapshot()
    const abandoned = tool(
      99,
      "debug_probe_prepare",
      {
        runId: "run_pre",
        hypothesisId: "hyp_path_encoding",
        sourceFile: "src/feature-flags.mjs",
        sourceLine: 11,
        captures: [{ label: "filePath", path: "filePath" }],
        transport: "process",
      },
      {
        probeId: "probe_abandoned",
        source: "src/feature-flags.mjs",
        line: 11,
        sourceLineText: "  try {",
      },
    )
    abandoned.messageIndex = 2
    snapshot.orderedTools.splice(3, 0, abandoned)

    expect(evaluateSyntheticCliAcceptance(snapshot).passed).toBe(true)
  })

  it("requires the instrumentation check to validate the selected runtime probe", () => {
    const snapshot = passingSnapshot()
    const instrumentation = snapshot.orderedTools.find(
      (item) => item.name === "debug_process_capture" && JSON.stringify(item.input).includes("instrumentation-check"),
    )
    if (instrumentation === undefined) throw new Error("missing instrumentation check")
    instrumentation.output = success({ exitCode: 0, validatedProbeIds: ["probe_unrelated"] })

    expect(check(snapshot, "synthetic-reproduced-with-evidence")).toBe(false)
  })

  it("ignores a rejected edit attempt when locating the evidence-backed fix", () => {
    const snapshot = passingSnapshot()
    const receipt = snapshot.transcript.find((entry) => entry.text.some((text) => /Evidence decision/iu.test(text)))
    const appliedEdit = snapshot.orderedTools.find((item) => item.name === "edit" && item.index === 14)
    if (receipt === undefined || appliedEdit === undefined) throw new Error("missing fix fixture")
    receipt.messageIndex = 14
    appliedEdit.messageIndex = 15
    const rejectedEdit = tool(99, "edit", { filePath: "src/feature-flags.mjs" })
    rejectedEdit.messageIndex = 13
    rejectedEdit.status = "error"
    rejectedEdit.output = JSON.stringify({ ok: false, error: { code: "INVALID_PHASE" } })
    snapshot.orderedTools.splice(14, 0, rejectedEdit)

    expect(check(snapshot, "synthetic-evidence-backed-fix")).toBe(true)
  })

  it("accepts a probe on the try boundary immediately before readFile", () => {
    const snapshot = passingSnapshot()
    const beforeRead = snapshot.orderedTools.find(
      (item) => item.name === "debug_probe_prepare" && JSON.stringify(item.input).includes("hyp_path_encoding"),
    )
    if (beforeRead === undefined) throw new Error("missing readFile probe")
    beforeRead.output = success({
      probeId: "probe_before",
      source: "src/feature-flags.mjs",
      line: 11,
      sourceLineText: "  try {",
    })

    expect(check(snapshot, "synthetic-runtime-probe")).toBe(true)
  })

  it("rejects a probe that does not capture the failing file path", () => {
    const snapshot = passingSnapshot()
    const beforeRead = snapshot.orderedTools.find(
      (item) => item.name === "debug_probe_prepare" && JSON.stringify(item.input).includes("hyp_path_encoding"),
    )
    if (beforeRead === undefined) throw new Error("missing readFile probe")
    const beforeReadInput = beforeRead.input as Record<string, unknown>
    beforeReadInput.captures = [{ label: "accountId", path: "accountId" }]
    beforeRead.output = success({
      probeId: "probe_before",
      source: "src/feature-flags.mjs",
      line: 13,
      sourceLineText: "    const record = JSON.parse(raw)",
    })
    const evidence = snapshot.orderedTools.find((item) => item.name === "debug_evidence_read")
    if (evidence === undefined) throw new Error("missing evidence read")
    evidence.output = success({ events: [{ probeId: "probe_before", data: { accountId: "team/acme" } }] })

    expect(check(snapshot, "synthetic-runtime-probe")).toBe(false)
  })

  it("rejects a fix that also changes an unrelated file", () => {
    const snapshot = passingSnapshot()
    snapshot.repository.changedFiles.push("README.md")
    snapshot.postCleanup.repository.changedFiles.push("README.md")

    expect(check(snapshot, "synthetic-minimal-fix")).toBe(false)
  })
})
