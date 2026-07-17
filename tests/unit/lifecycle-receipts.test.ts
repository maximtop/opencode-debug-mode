import { describe, expect, it } from "vitest"
import {
  normalizeQuestionRequest,
  recordQuestionAsked,
  recordQuestionReply,
  recordVisibleLifecycleUpdate,
  renderEvidenceDecisionMarkdown,
  renderPreparedQuestionArgs,
} from "../../src/investigation/lifecycle-receipts.js"
import { initialInvestigationState } from "../../src/investigation/store.js"

function fixture(
  options: {
    label?: "pre-fix" | "post-fix"
    phase?: "waiting_for_reproduction" | "verifying"
    reproduction?: string
  } = {},
) {
  const label = options.label ?? "pre-fix"
  let manifest: Record<string, unknown> = {
    runs: [
      {
        id: "run_A",
        label,
        status: "waiting",
        reproduction: options.reproduction ?? "Open Filters and run Check for updates",
      },
    ],
    humanCheckpoints: [],
  }
  const state = {
    ...initialInvestigationState("2026-07-15T00:00:00.000Z"),
    phase: options.phase ?? ("waiting_for_reproduction" as const),
    hypotheses: [
      {
        id: "hyp_A",
        rank: 1,
        statement: "first cause",
        confirmationSignals: ["redirected request fails"],
        eliminationSignals: ["redirected request succeeds"],
        status: "confirmed" as const,
        evidenceRefs: ["event_A"],
      },
      {
        id: "hyp_B",
        rank: 2,
        statement: "second cause",
        confirmationSignals: ["timeout fires first"],
        eliminationSignals: ["response completes first"],
        status: "eliminated" as const,
        evidenceRefs: ["event_A"],
      },
    ],
    decidingEvidenceIds: ["event_A"],
  }
  const session = {
    manifestStore: {
      read: async () => structuredClone(manifest),
      modify: async (mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        manifest = mutate(structuredClone(manifest))
        return structuredClone(manifest)
      },
    },
    investigationStore: { read: async () => structuredClone(state) },
  }
  return { session: session as never, state, manifest: () => manifest }
}

const reproductionQuestion = {
  questions: [
    {
      header: "Reproduce",
      question: "Open Filters and run Check for updates. What happened?",
      multiple: false,
      custom: false,
      options: [
        { label: "Reproduced", description: "The issue occurred." },
        { label: "Did not reproduce", description: "The issue did not occur." },
        { label: "Could not complete", description: "The steps could not be completed." },
      ],
    },
  ],
}

const verificationQuestion = {
  questions: [
    {
      header: "Verify",
      question: "Open Filters and run Check for updates. What happened?",
      multiple: false,
      custom: false,
      options: [
        { label: "Fixed", description: "The issue is gone." },
        { label: "Still reproduces", description: "The issue still occurs." },
        { label: "Could not verify", description: "The steps could not be completed." },
      ],
    },
  ],
}

const fiveStepProcedure =
  "1) Create a GitHub filter repository. 2) Subscribe to its raw filter URL in the MV3 extension. 3) Rename the repository. 4) Change the filter content. 5) Open Filters and run Check for updates. The old raw URL now redirects; the custom filter stays stale."

describe("lifecycle receipts", () => {
  it("normalizes omitted optional Question flags to single-choice without free-form input", () => {
    const question = structuredClone(reproductionQuestion) as { questions: Array<Record<string, unknown>> }
    delete question.questions[0]?.custom
    delete question.questions[0]?.multiple

    expect(normalizeQuestionRequest(question)).toMatchObject({
      questions: [{ multiple: false, custom: false }],
    })
    const explicitlyCustom = structuredClone(reproductionQuestion)
    if (explicitlyCustom.questions[0] !== undefined) explicitlyCustom.questions[0].custom = true
    expect(normalizeQuestionRequest(explicitlyCustom)).toEqual(explicitlyCustom)
  })

  it("allows a last-resort blocker Question without attesting runtime evidence", async () => {
    const value = fixture()
    ;(value.manifest().runs as Array<Record<string, unknown>>).splice(0)

    await expect(
      recordQuestionAsked({
        session: value.session,
        callId: "call_blocker",
        args: {
          questions: [
            {
              header: "Input needed",
              question: "The required private runtime is unavailable. Can you provide access or captured output?",
              multiple: false,
              custom: false,
              options: [
                { label: "Provide access", description: "Continue with the real runtime." },
                { label: "Provide output", description: "Continue from developer-captured evidence." },
              ],
            },
          ],
        },
      }),
    ).resolves.toBeUndefined()
    expect(value.manifest().humanCheckpoints).toEqual([])
  })

  it.each([
    [
      "pre-fix" as const,
      "waiting_for_reproduction" as const,
      ["Reproduced", "Did not reproduce", "Could not complete"],
    ],
    ["post-fix" as const, "verifying" as const, ["Fixed", "Still reproduces", "Could not verify"]],
  ])("renders and accepts canonical %s Question arguments", async (label, phase, labels) => {
    const procedure = "Open Filters and run Check for updates"
    const value = fixture({ label, phase, reproduction: procedure })
    const args = renderPreparedQuestionArgs(label, procedure)

    expect(args.questions[0]?.question).toContain(procedure)
    expect(args.questions[0]?.options.map((option) => option.label)).toEqual(labels)
    await expect(
      recordQuestionAsked({ session: value.session, callId: `call_${label}`, args }),
    ).resolves.toBeUndefined()
  })

  it("accepts a paraphrased observational Question that covers the prepared procedure", async () => {
    const value = fixture()
    const paraphrased = structuredClone(reproductionQuestion) as { questions: Array<Record<string, unknown>> }
    if (paraphrased.questions[0] !== undefined) {
      paraphrased.questions[0].question = "Open the filter screen and check for updates. What happened?"
      delete paraphrased.questions[0].custom
      delete paraphrased.questions[0].multiple
    }
    const normalized = normalizeQuestionRequest(paraphrased) as typeof reproductionQuestion

    expect(normalized.questions[0]?.question).toBe("Open the filter screen and check for updates. What happened?")
    expect(normalized.questions[0]?.multiple).toBe(false)
    expect(normalized.questions[0]?.custom).toBe(false)
    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_normalized", args: normalized }),
    ).resolves.toBeUndefined()
  })

  it("binds a paraphrased post-fix Question to the prepared verification procedure", async () => {
    const value = fixture({ label: "post-fix", phase: "verifying" })
    const paraphrased = structuredClone(verificationQuestion)
    if (paraphrased.questions[0] !== undefined) {
      paraphrased.questions[0].question =
        "Open the filter screen, run the update check, and report whether it is fixed."
    }
    const normalized = normalizeQuestionRequest(paraphrased) as typeof verificationQuestion

    expect(normalized.questions[0]?.question).toBe(
      "Open the filter screen, run the update check, and report whether it is fixed.",
    )
    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_verify_normalized", args: normalized }),
    ).resolves.toBeUndefined()
  })

  it("attests only an exact reproduction question and its returned answer", async () => {
    const value = fixture()
    await recordQuestionAsked({ session: value.session, callId: "call_A", args: reproductionQuestion })
    expect(value.manifest().humanCheckpoints).toEqual([
      expect.objectContaining({ requestId: "call_A", runId: "run_A", status: "asked" }),
    ])
    await recordQuestionReply({
      session: value.session,
      callId: "call_A",
      metadata: { answers: [["Reproduced"]] },
    })
    expect(value.manifest().humanCheckpoints).toEqual([
      expect.objectContaining({ requestId: "call_A", status: "replied", issueReproduced: true }),
    ])
  })

  it("accepts an expanded five-step Question that preserves the prepared procedure meaning", async () => {
    const value = fixture({ reproduction: fiveStepProcedure })
    const question = structuredClone(reproductionQuestion)
    if (question.questions[0] !== undefined) {
      question.questions[0].question =
        "Please reproduce in the running MV3 extension. Steps: (1) Rebuild and load the extension. (2) Subscribe to a GitHub raw filter URL. (3) On GitHub, rename the repository so the old raw URL redirects. (4) Change the filter content in the renamed repo. (5) In the extension, open Filters and run Check for updates. Did the custom filter remain stale?"
    }

    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_expanded", args: question }),
    ).resolves.toBeUndefined()
  })

  it.each([
    [
      "the rename step",
      "Create a GitHub filter repository, subscribe to its raw filter URL in the MV3 extension, change the filter content, open Filters, and run Check for updates. The raw URL redirects and the custom filter stays stale.",
    ],
    [
      "the content-change step",
      "Create a GitHub filter repository, subscribe to its raw filter URL in the MV3 extension, rename the repository, open Filters, and run Check for updates. The old raw URL redirects and the custom filter stays stale.",
    ],
    [
      "the prepared action order",
      "Rename the GitHub repository, then subscribe to its old raw filter URL in the MV3 extension, change the filter content, open Filters, and run Check for updates. The raw URL redirects and the custom filter stays stale.",
    ],
  ])("rejects an expanded Question that omits %s", async (_label, prompt) => {
    const value = fixture({ reproduction: fiveStepProcedure })
    const question = structuredClone(reproductionQuestion)
    if (question.questions[0] !== undefined) question.questions[0].question = prompt

    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_incomplete", args: question }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("attests the exact post-fix outcomes and nullable verification answer", async () => {
    const value = fixture({ label: "post-fix", phase: "verifying" })
    await recordQuestionAsked({ session: value.session, callId: "call_verify", args: verificationQuestion })
    await recordQuestionReply({
      session: value.session,
      callId: "call_verify",
      metadata: { answers: [["Could not verify"]] },
    })

    expect(value.manifest().humanCheckpoints).toEqual([
      expect.objectContaining({
        requestId: "call_verify",
        purpose: "verification",
        status: "replied",
        issueReproduced: null,
      }),
    ])
  })

  it("rejects an answer that is missing, unknown, or detached from its run", async () => {
    const missing = fixture()
    await recordQuestionReply({ session: missing.session, callId: "missing", metadata: { answers: [["Reproduced"]] } })
    expect(missing.manifest().humanCheckpoints).toEqual([])

    const unknown = fixture()
    await recordQuestionAsked({ session: unknown.session, callId: "call_unknown", args: reproductionQuestion })
    await recordQuestionReply({
      session: unknown.session,
      callId: "call_unknown",
      metadata: { answers: [["Choose a fix"], ["Reproduced"]] },
    })
    expect(unknown.manifest().humanCheckpoints).toEqual([
      expect.objectContaining({ requestId: "call_unknown", status: "rejected" }),
    ])

    const detached = fixture()
    await recordQuestionAsked({ session: detached.session, callId: "call_detached", args: reproductionQuestion })
    ;(detached.manifest().runs as Array<Record<string, unknown>>).splice(0)
    await recordQuestionReply({
      session: detached.session,
      callId: "call_detached",
      metadata: { answers: [["Reproduced"]] },
    })
    expect(detached.manifest().humanCheckpoints).toEqual([
      expect.objectContaining({ requestId: "call_detached", status: "rejected" }),
    ])
  })

  it("replaces a repeated call receipt and enforces the prepared phase", async () => {
    const value = fixture()
    await recordQuestionAsked({ session: value.session, callId: "call_repeat", args: reproductionQuestion })
    await recordQuestionAsked({ session: value.session, callId: "call_repeat", args: reproductionQuestion })
    expect(value.manifest().humanCheckpoints).toHaveLength(1)

    const wrongPhase = fixture({ phase: "verifying" })
    await expect(
      recordQuestionAsked({ session: wrongPhase.session, callId: "call_wrong_phase", args: reproductionQuestion }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("does not attest a Question with an extra fix option", async () => {
    const value = fixture()
    const question = structuredClone(reproductionQuestion)
    question.questions[0]?.options.push({ label: "Apply timeout fix", description: "Change behavior now." })
    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_extra", args: question }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    expect(value.manifest().humanCheckpoints).toEqual([])
  })

  it("does not attest a Question that omits the prepared reproduction procedure", async () => {
    const value = fixture()
    const question = structuredClone(reproductionQuestion)
    if (question.questions[0] !== undefined) question.questions[0].question = "Run the prepared steps. What happened?"

    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_missing_steps", args: question }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    expect(value.manifest().humanCheckpoints).toEqual([])
  })

  it("does not attest a disguised root-cause choice with outcome-shaped options", async () => {
    const value = fixture()
    const question = structuredClone(reproductionQuestion)
    if (question.questions[0] !== undefined) {
      question.questions[0].question = "Which root cause should we fix after these steps?"
    }
    const normalized = normalizeQuestionRequest(question)

    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_fix_choice", args: normalized }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    expect(value.manifest().humanCheckpoints).toEqual([])
  })

  it("rejects fix-direction framing even when the outcome labels and procedure are exact", async () => {
    const value = fixture()
    const question = structuredClone(reproductionQuestion)
    if (question.questions[0] !== undefined) question.questions[0].header = "Root cause / fix direction"

    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_fix_header", args: question }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    expect(value.manifest().humanCheckpoints).toEqual([])
  })

  it("rejects imperative fix descriptions under otherwise observational outcome labels", async () => {
    const value = fixture()
    const question = structuredClone(reproductionQuestion)
    if (question.questions[0]?.options[0] !== undefined) {
      question.questions[0].options[0].description = "Apply the timeout fix."
    }

    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_fix_description", args: question }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    expect(value.manifest().humanCheckpoints).toEqual([])
  })

  it("rejects conditional fix promises hidden inside outcome descriptions", async () => {
    const value = fixture()
    const question = structuredClone(reproductionQuestion)
    if (question.questions[0]?.options[0] !== undefined) {
      question.questions[0].options[0].description = "If selected, I will apply the timeout fix."
    }

    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_conditional_fix", args: question }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
    expect(value.manifest().humanCheckpoints).toEqual([])
  })

  it("requires explicit single-choice mode without custom input", async () => {
    const value = fixture()
    const question = structuredClone(reproductionQuestion) as { questions: Array<Record<string, unknown>> }
    delete question.questions[0]?.custom
    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_missing_custom", args: question }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const multiple = structuredClone(reproductionQuestion)
    if (multiple.questions[0] !== undefined) multiple.questions[0].multiple = true
    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_multiple", args: multiple }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("leaves malformed Question envelopes untouched and rejects duplicate outcome labels", async () => {
    expect(normalizeQuestionRequest(null)).toBeNull()
    expect(normalizeQuestionRequest({ questions: [] })).toEqual({ questions: [] })
    expect(normalizeQuestionRequest({ questions: [null] })).toEqual({ questions: [null] })

    const missingPrompt = structuredClone(reproductionQuestion) as { questions: Array<Record<string, unknown>> }
    delete missingPrompt.questions[0]?.question
    const value = fixture()
    await expect(
      recordQuestionAsked({
        session: value.session,
        callId: "call_missing_prompt",
        args: normalizeQuestionRequest(missingPrompt),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })

    const duplicate = structuredClone(reproductionQuestion)
    if (duplicate.questions[0] !== undefined) {
      duplicate.questions[0].options[2] = { label: "Reproduced", description: "Duplicate." }
    }
    await expect(
      recordQuestionAsked({ session: value.session, callId: "call_duplicate", args: duplicate }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" })
  })

  it("records visible updates only when they contain the checkpointed IDs", async () => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(value.session, "## Working hypotheses\n1. first cause\n2. second cause")
    expect(value.manifest().visibleHypothesesAt).toBeUndefined()
    await recordVisibleLifecycleUpdate(
      value.session,
      "## Working hypotheses\n1. hyp_A — first cause; confirm: redirected request fails; eliminate: redirected request succeeds\n2. hyp_B — second cause; confirm: timeout fires first; eliminate: response completes first",
    )
    expect(value.manifest().visibleHypothesesAt).toEqual(expect.any(String))
    await recordVisibleLifecycleUpdate(
      value.session,
      "## Evidence decision\nhyp_A confirmed by event_A; hyp_B eliminated by event_A",
    )
    expect(value.manifest().visibleEvidenceDecisionAt).toEqual(expect.any(String))
  })

  it("renders and records the canonical evidence-decision receipt", async () => {
    const value = fixture()

    const receipt = renderEvidenceDecisionMarkdown(value.state)

    expect(receipt).toBe(
      [
        "## Evidence decision",
        "- hyp_A: confirmed — event_A",
        "- hyp_B: eliminated — event_A",
        "Deciding evidence: event_A",
      ].join("\n"),
    )
    await recordVisibleLifecycleUpdate(value.session, receipt ?? "")
    expect(value.manifest().visibleEvidenceDecisionAt).toEqual(expect.any(String))
  })

  it("does not attest incomplete evidence-decision projections", async () => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(value.session, "## Evidence decision\nhyp_A confirmed; hyp_B eliminated")
    expect(value.manifest().visibleEvidenceDecisionAt).toBeUndefined()
    await recordVisibleLifecycleUpdate(
      value.session,
      "## Evidence decision\nhyp_A confirmed by event_A\nhyp_B maybe event_A",
    )
    expect(value.manifest().visibleEvidenceDecisionAt).toBeUndefined()
  })

  it.each([
    "## Working hypotheses — AG-55256 (instrumentation gate receipt)",
    "## Working hypotheses — receipt (exact copy from checkpoint revision 3)",
  ])("accepts a complete slate under a natural bounded heading: %s", async (heading) => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(
      value.session,
      `${heading}\n1. hyp_A — first cause; confirm: redirected request fails; eliminate: redirected request succeeds\n2. hyp_B — second cause; confirm: timeout fires first; eliminate: response completes first`,
    )

    expect(value.manifest().visibleHypothesesAt).toEqual(expect.any(String))
  })

  it.each([
    "Here is the initial Working hypotheses ledger:",
    "I need to re-establish the hypotheses visibility receipt. Here is the exact Working hypotheses:",
  ])("accepts a complete slate after a bounded declarative lead-in: %s", async (heading) => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(
      value.session,
      `${heading}\n1. hyp_A — first cause; confirm: redirected request fails; eliminate: redirected request succeeds\n2. hyp_B — second cause; confirm: timeout fires first; eliminate: response completes first`,
    )

    expect(value.manifest().visibleHypothesesAt).toEqual(expect.any(String))
  })

  it.each([
    "Status: Working hypotheses — receipt",
    "## Working hypotheses receipt",
    "## Working hypotheses — receipt (unclosed",
    `## Working hypotheses — ${"x".repeat(121)}`,
  ])("does not accept an unrelated or malformed heading: %s", async (heading) => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(
      value.session,
      `${heading}\n1. hyp_A — first cause; confirm: redirected request fails; eliminate: redirected request succeeds\n2. hyp_B — second cause; confirm: timeout fires first; eliminate: response completes first`,
    )

    expect(value.manifest().visibleHypothesesAt).toBeUndefined()
  })

  it("records a complete checkpointed hypothesis slate rendered as a Markdown table", async () => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(
      value.session,
      [
        "**Working hypotheses** (provisional slate):",
        "| # | ID | Rank | Statement | Confirmation signal | Elimination signal |",
        "| --- | --- | ---: | --- | --- | --- |",
        "| 1 | hyp_A | 1 | first cause | redirected request fails | redirected request succeeds |",
        "| 2 | hyp_B | 2 | second cause | timeout fires first | response completes first |",
      ].join("\n"),
    )

    expect(value.manifest().visibleHypothesesAt).toEqual(expect.any(String))
  })

  it("rejects a ranked table that paraphrases durable hypothesis details", async () => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(
      value.session,
      [
        "### Working hypotheses",
        "| ID | Rank | Statement | Confirmation signals | Elimination signals | First probe |",
        "| --- | ---: | --- | --- | --- | --- |",
        "| hyp_A | 1 | redirected request may fail | a failure is observed | the request succeeds | inspect redirect outcome |",
        "| hyp_B | 2 | a timeout may win | timeout is observed | response wins | inspect completion timing |",
      ].join("\n"),
    )

    expect(value.manifest().visibleHypothesesAt).toBeUndefined()
  })

  it.each([
    [
      "rank",
      "| Rank | ID | Statement | Confirmation signal | Elimination signal |\n| ---: | --- | --- | --- | --- |\n| 3 | hyp_A | first cause | redirected request fails | redirected request succeeds |\n| 2 | hyp_B | second cause | timeout fires first | response completes first |",
    ],
  ])("does not record a Markdown table with a mismatched checkpointed %s", async (_field, table) => {
    const value = fixture()
    await recordVisibleLifecycleUpdate(value.session, `## Working hypotheses\n${table}`)

    expect(value.manifest().visibleHypothesesAt).toBeUndefined()
  })
})
