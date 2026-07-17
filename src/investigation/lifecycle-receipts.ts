import { createHash } from "node:crypto"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { DebugModeError } from "../core/errors.js"
import { reproductionFingerprint } from "../run/service.js"
import type { DebugSession } from "../session/registry.js"
import type { InvestigationState } from "./schema.js"

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ")
}

function normalizeVisibleText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
}

function containsVisiblePhrase(value: string, expected: string): boolean {
  const normalizedValue = normalizeVisibleText(value)
  const normalizedExpected = normalizeVisibleText(expected)
  return normalizedExpected.length > 0 && ` ${normalizedValue} `.includes(` ${normalizedExpected} `)
}

const PROCEDURE_STOP_WORDS = new Set(
  "a an and after before but did do does for from had has have how i if in into is it its of on or please so that the then this through to was were what when where which with you your now only actual expected happened following prepared step steps".split(
    " ",
  ),
)

const PROCEDURE_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  added: "subscribe",
  adding: "subscribe",
  adds: "subscribe",
  click: "run",
  clicked: "run",
  clicking: "run",
  clicks: "run",
  changes: "change",
  changed: "change",
  changing: "change",
  created: "create",
  creates: "create",
  creating: "create",
  edited: "change",
  edit: "change",
  editing: "change",
  edits: "change",
  executed: "run",
  executing: "run",
  executes: "run",
  filters: "filter",
  go: "open",
  goes: "open",
  imported: "subscribe",
  make: "create",
  importing: "subscribe",
  imports: "subscribe",
  made: "create",
  makes: "create",
  modified: "change",
  modify: "change",
  modifies: "change",
  modifying: "change",
  opened: "open",
  navigate: "open",
  opening: "open",
  opens: "open",
  navigated: "open",
  navigates: "open",
  navigating: "open",
  redirected: "redirect",
  redirecting: "redirect",
  redirects: "redirect",
  renamed: "rename",
  renames: "rename",
  renaming: "rename",
  repo: "repository",
  repositories: "repository",
  ran: "run",
  refresh: "update",
  refreshed: "update",
  remain: "stay",
  refreshes: "update",
  refreshing: "update",
  remained: "stay",
  remaining: "stay",
  remains: "stay",
  rule: "content",
  rules: "content",
  running: "run",
  runs: "run",
  stayed: "stay",
  stays: "stay",
  subscribed: "subscribe",
  trigger: "run",
  subscribes: "subscribe",
  subscribing: "subscribe",
  triggered: "run",
  triggering: "run",
  triggers: "run",
  unchanged: "stale",
  updated: "update",
  updates: "update",
  updating: "update",
}

function procedureTokenList(value: string): string[] {
  const tokens = normalizeVisibleText(value)
    .split(" ")
    .map((token) => PROCEDURE_TOKEN_ALIASES[token] ?? token)
  return tokens
    .map((token, index) => {
      const context = tokens.slice(Math.max(0, index - 2), index + 3)
      if (token === "change" && context.includes("repository") && context.includes("name")) return "rename"
      if (token === "update" && context.includes("content")) return "change"
      if ((token === "add" || token === "import") && (context.includes("url") || context.includes("filter"))) {
        return "subscribe"
      }
      if (token === "old" && context.includes("content") && !context.includes("raw")) return "stale"
      return token
    })
    .filter((token) => token.length >= 2 && !/^\d+$/u.test(token) && !PROCEDURE_STOP_WORDS.has(token))
}

function procedureActions(tokens: readonly string[]): string[] {
  const actions: string[] = []
  for (const [index, token] of tokens.entries()) {
    const context = tokens.slice(Math.max(0, index - 2), index + 3)
    const belongsToUpdateCheck = token === "run" && context.includes("check") && context.includes("update")
    if (token === "check" && context.includes("update")) {
      actions.push("trigger-update-check")
    } else if (!belongsToUpdateCheck && ["subscribe", "rename", "change", "open", "run"].includes(token)) {
      actions.push(token)
    }
  }
  return actions
}

function orderedActionsCovered(expected: readonly string[], actual: readonly string[]): boolean {
  let cursor = 0
  for (const action of expected) {
    const found = actual.indexOf(action, cursor)
    if (found < 0) return false
    cursor = found + 1
  }
  return true
}

function coversPreparedProcedure(prompt: string, procedure: string): boolean {
  if (containsVisiblePhrase(prompt, procedure)) return true
  const expectedTokens = procedureTokenList(procedure)
  const expected = new Set(expectedTokens)
  if (expected.size === 0) return false
  const actualTokens = procedureTokenList(prompt)
  const actual = new Set(actualTokens)
  let matched = 0
  for (const token of expected) {
    if (actual.has(token)) matched += 1
  }
  if (matched < Math.ceil(expected.size * 0.8)) return false
  if (!orderedActionsCovered(procedureActions(expectedTokens), procedureActions(actualTokens))) return false
  return ["redirect", "stale"].every((signal) => !expected.has(signal) || actual.has(signal))
}

function rankIsVisible(value: string, rank: number): boolean {
  return (
    new RegExp(`(?:^|\\n)\\s{0,3}${rank}[.)]\\s+`, "u").test(value) ||
    new RegExp(`(?:^|\\|)\\s*${rank}\\s*(?:\\||$)`, "u").test(value) ||
    new RegExp(`\\brank\\s*:?\\s*${rank}\\b`, "iu").test(value)
  )
}

function visibleHypothesisSegments(text: string, id: string): string[] {
  const lines = text.split(/\r?\n/u)
  const normalizedId = id.toLowerCase()
  return lines.flatMap((line, index) => {
    if (!line.toLowerCase().includes(normalizedId)) return []
    if (line.includes("|")) return [line]

    const segment = [line]
    for (const following of lines.slice(index + 1)) {
      if (/^\s{0,3}(?:#{1,6}\s+|\d{1,2}[.)]\s+)/u.test(following)) break
      segment.push(following)
    }
    return [segment.join("\n")]
  })
}

function hypothesisIsVisible(text: string, hypothesis: InvestigationState["hypotheses"][number]): boolean {
  return visibleHypothesisSegments(text, hypothesis.id).some(
    (segment) =>
      rankIsVisible(segment, hypothesis.rank) &&
      containsVisiblePhrase(segment, hypothesis.statement) &&
      hypothesis.confirmationSignals.every((signal) => containsVisiblePhrase(segment, signal)) &&
      hypothesis.eliminationSignals.every((signal) => containsVisiblePhrase(segment, signal)),
  )
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function hypothesisSlateFingerprint(state: InvestigationState): string {
  return sha256(
    JSON.stringify(
      [...state.hypotheses]
        .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
        .map(({ id, rank, statement, confirmationSignals, eliminationSignals }) => ({
          id,
          rank,
          statement,
          confirmationSignals,
          eliminationSignals,
        })),
    ),
  )
}

function receiptLine(value: string): string {
  return value.replace(/\r?\n/gu, " ").trim()
}

/**
 * Produces the canonical user-visible hypothesis receipt returned by state tools.
 * Agents should copy this block verbatim instead of reconstructing long hypothesis
 * fields from conversational memory.
 */
export function renderWorkingHypothesesMarkdown(state: InvestigationState): string | undefined {
  if (state.hypotheses.length < 2 || state.hypotheses.length > 4) return undefined
  return [
    "## Working hypotheses",
    ...[...state.hypotheses]
      .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
      .flatMap((hypothesis) => [
        `${hypothesis.rank}. ${receiptLine(hypothesis.id)} — ${receiptLine(hypothesis.statement)}`,
        `   - Confirmation signals: ${hypothesis.confirmationSignals.map(receiptLine).join("; ")}`,
        `   - Elimination signals: ${hypothesis.eliminationSignals.map(receiptLine).join("; ")}`,
      ]),
  ].join("\n")
}

export function hypothesisSemanticFingerprint(hypothesis: InvestigationState["hypotheses"][number]): string {
  return sha256(
    JSON.stringify({
      id: hypothesis.id,
      rank: hypothesis.rank,
      statement: hypothesis.statement,
      confirmationSignals: hypothesis.confirmationSignals,
      eliminationSignals: hypothesis.eliminationSignals,
    }),
  )
}

export function evidenceDecisionFingerprint(state: InvestigationState): string {
  return decisionProjectionFingerprint(
    state.hypotheses.map(({ id, status }) => ({ id, status })),
    state.decidingEvidenceIds,
  )
}

export function renderEvidenceDecisionMarkdown(state: InvestigationState): string | undefined {
  if (state.decidingEvidenceIds.length === 0 || !state.hypotheses.some((item) => item.status === "confirmed")) {
    return undefined
  }
  return [
    "## Evidence decision",
    ...[...state.hypotheses]
      .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
      .map((hypothesis) => {
        const references = hypothesis.evidenceRefs.filter((eventId) => state.decidingEvidenceIds.includes(eventId))
        return `- ${receiptLine(hypothesis.id)}: ${hypothesis.status}${references.length === 0 ? "" : ` — ${references.join(", ")}`}`
      }),
    `Deciding evidence: ${state.decidingEvidenceIds.join(", ")}`,
  ].join("\n")
}

function decisionProjectionFingerprint(
  hypotheses: Array<{ id: string; status: "open" | "confirmed" | "eliminated" }>,
  decidingEvidenceIds: readonly string[],
): string {
  return sha256(
    JSON.stringify({
      hypotheses: [...hypotheses].sort((left, right) => left.id.localeCompare(right.id)),
      decidingEvidenceIds: [...decidingEvidenceIds].sort(),
    }),
  )
}

function visibleDecisionFingerprint(state: InvestigationState, text: string): string | undefined {
  const statuses: Array<{ id: string; status: "open" | "confirmed" | "eliminated" }> = []
  for (const hypothesis of state.hypotheses) {
    const line = text.split(/\r?\n/u).find((candidate) => candidate.includes(hypothesis.id))
    const status = line?.match(/\b(open|confirmed|eliminated)\b/iu)?.[1]?.toLowerCase()
    if (status !== "open" && status !== "confirmed" && status !== "eliminated") return undefined
    statuses.push({ id: hypothesis.id, status })
  }
  const decidingEvidenceIds = [...new Set(text.match(/\bevent_[A-Za-z0-9_-]+\b/gu) ?? [])]
  if (decidingEvidenceIds.length === 0) return undefined
  return decisionProjectionFingerprint(statuses, decidingEvidenceIds)
}

function expectedOutcomes(label: "pre-fix" | "post-fix"): Map<string, boolean | null> {
  return label === "pre-fix"
    ? new Map([
        ["reproduced", true],
        ["did not reproduce", false],
        ["could not complete", null],
      ])
    : new Map([
        ["fixed", false],
        ["still reproduces", true],
        ["could not verify", null],
      ])
}

export function renderPreparedQuestionArgs(label: "pre-fix" | "post-fix", procedure: string) {
  const reproduction = label === "pre-fix"
  return {
    questions: [
      {
        header: reproduction ? "Reproduce" : "Verify fix",
        question: `Perform the prepared ${reproduction ? "reproduction" : "verification"} procedure exactly:\n${procedure}\nWhat outcome did you observe?`,
        multiple: false,
        custom: false,
        options: reproduction
          ? [
              { label: "Reproduced", description: "The reported issue occurred during the prepared procedure." },
              {
                label: "Did not reproduce",
                description: "The reported issue did not occur during the prepared procedure.",
              },
              {
                label: "Could not complete",
                description: "The prepared procedure could not be completed.",
              },
            ]
          : [
              { label: "Fixed", description: "The reported issue no longer occurs." },
              { label: "Still reproduces", description: "The reported issue still occurs." },
              {
                label: "Could not verify",
                description: "The prepared verification procedure could not be completed.",
              },
            ],
      },
    ],
  }
}

function exactQuestionOutcomes(value: unknown, label: "pre-fix" | "post-fix"): boolean {
  const args = asRecord(value)
  const questions = Array.isArray(args?.questions) ? args.questions : []
  if (questions.length !== 1) return false
  const question = asRecord(questions[0])
  const options = Array.isArray(question?.options) ? question.options : []
  if (question?.multiple !== false || question.custom !== false) return false
  const labels = options
    .map((option) => asRecord(option)?.label)
    .filter((item): item is string => typeof item === "string")
    .map(normalizeLabel)
  const expected = expectedOutcomes(label)
  return (
    labels.length === expected.size &&
    labels.every((item) => expected.has(item)) &&
    new Set(labels).size === labels.length
  )
}

function questionIsObservational(value: unknown): boolean {
  const args = asRecord(value)
  const question = asRecord(Array.isArray(args?.questions) ? args.questions[0] : undefined)
  if (question === undefined) return false
  const prompt = question.question
  if (typeof prompt !== "string" || prompt.trim().length === 0) return false
  const options = Array.isArray(question.options) ? question.options : []
  const optionRecords = options.map(asRecord).filter((item): item is JsonRecord => item !== undefined)
  const framing = [question.header, prompt].filter((item): item is string => typeof item === "string").join("\n")
  if (
    /\b(?:root cause|fix direction|implementation (?:choice|option)|speculative workaround|preferred (?:fix|approach)|hypothesis selection)\b/iu.test(
      framing,
    ) ||
    /\b(?:how|what|which)\b[\s\S]{0,80}\b(?:want|should|prefer|choose|select|pick|decide|implement|apply|proceed)\b/iu.test(
      framing,
    ) ||
    /\b(?:choose|select|pick|decide)\b[\s\S]{0,80}\b(?:hypothesis|root cause|cause|fix|implementation|workaround|approach|direction|option)\b/iu.test(
      framing,
    )
  ) {
    return false
  }
  return optionRecords.every((option) => {
    const description = option.description
    return (
      typeof description === "string" &&
      !/^\s*(?:please\s+)?(?:apply|implement|choose|select|pick|proceed|use|prefer|try|change|modify|edit|fix|investigate|coordinate)\b/iu.test(
        description,
      ) &&
      !/\b(?:if|when)\s+(?:(?:this|the)\s+)?(?:option\s+)?(?:is\s+)?selected\b/iu.test(description) &&
      !/\b(?:i|we|the agent|the assistant)\s+(?:will|would|can|should)\s+(?:then\s+)?(?:apply|implement|use|try|change|modify|edit|fix|investigate|coordinate)\b/iu.test(
        description,
      ) &&
      !/\b(?:apply|implement|use|try|change|modify|edit)\b[\s\S]{0,80}\b(?:fix|patch|workaround|solution|approach|implementation)\b/iu.test(
        description,
      )
    )
  })
}

function questionContainsProcedure(value: unknown, procedure: string): boolean {
  const args = asRecord(value)
  const question = asRecord(Array.isArray(args?.questions) ? args.questions[0] : undefined)
  const prompt = question?.question
  return typeof prompt === "string" && coversPreparedProcedure(prompt, procedure)
}

function isBoundedHeadingSuffix(value: string): boolean {
  const suffix = value.trim()
  if (suffix === "" || suffix === ":") return true

  const parenthetical = suffix.endsWith(":") ? suffix.slice(0, -1).trimEnd() : suffix
  if (/^\([^()\r\n]{1,120}\)$/u.test(parenthetical)) return true

  const descriptor = suffix.match(/^(?:[-–—]|:)[ \t]+(.+)$/u)?.[1]?.trim()
  if (descriptor === undefined || descriptor.length === 0 || descriptor.length > 120) return false

  let parenthesisDepth = 0
  for (const character of descriptor) {
    if (character === "(") {
      parenthesisDepth += 1
      if (parenthesisDepth > 1) return false
    } else if (character === ")") {
      parenthesisDepth -= 1
      if (parenthesisDepth < 0) return false
    }
  }
  return parenthesisDepth === 0
}

function hasWorkingHypothesesHeading(text: string): boolean {
  return text.split(/\r?\n/u).some((line) => {
    const match = line.match(/^[ \t]{0,3}(?:#{1,6}[ \t]*)?(?:\*\*working hypotheses\*\*|working hypotheses)(.*)$/iu)
    if (match !== null && isBoundedHeadingSuffix(match[1] ?? "")) return true
    return (
      line.length <= 240 &&
      /\bhere (?:is|are)\b[^\r\n]{0,100}\bworking hypotheses\b(?:[ \t]+(?:ledger|list|slate|table))?[ \t]*:?[ \t]*$/iu.test(
        line,
      )
    )
  })
}

function selectedAnswer(metadata: unknown): string | undefined {
  const answers = asRecord(metadata)?.answers
  if (!Array.isArray(answers) || answers.length !== 1 || !Array.isArray(answers[0]) || answers[0].length !== 1) {
    return undefined
  }
  return typeof answers[0][0] === "string" ? answers[0][0] : undefined
}

export function normalizeQuestionRequest(value: unknown): unknown {
  const args = asRecord(value)
  if (args === undefined || !Array.isArray(args.questions) || args.questions.length !== 1) return value
  const question = asRecord(args.questions[0])
  if (question === undefined) return value
  if (question.custom !== undefined && question.multiple !== undefined) return value
  return {
    ...args,
    questions: [
      {
        ...question,
        ...(question.multiple === undefined ? { multiple: false } : {}),
        ...(question.custom === undefined ? { custom: false } : {}),
      },
    ],
  }
}

export async function recordQuestionAsked(input: {
  session: DebugSession
  callId: string
  args: unknown
  clock?: Clock
}): Promise<void> {
  const manifest = await input.session.manifestStore.read()
  const waiting = manifest.runs.filter((run) => run.status === "waiting")
  if (waiting.length === 0) return
  const run = waiting[0]
  if (
    waiting.length !== 1 ||
    run === undefined ||
    !exactQuestionOutcomes(input.args, run.label) ||
    !questionIsObservational(input.args) ||
    !questionContainsProcedure(input.args, run.reproduction)
  ) {
    throw new DebugModeError(
      "INVALID_PHASE",
      "A waiting human checkpoint accepts only its prepared reproduction or verification Question",
      false,
      {
        action:
          "Prepare the waiting run and ask exactly one observational Question that faithfully covers its reproduction procedure, uses multiple:false and custom:false, and offers only the required three outcome options",
      },
    )
  }
  const state = await input.session.investigationStore.read()
  if (
    (run.label === "pre-fix" && state.phase !== "waiting_for_reproduction") ||
    (run.label === "post-fix" && state.phase !== "verifying")
  ) {
    throw new DebugModeError("INVALID_PHASE", "Question does not match the prepared lifecycle phase", false, {
      action:
        "Checkpoint waiting_for_reproduction before the pre-fix Question, or verifying before the post-fix Question",
    })
  }
  const now = (input.clock ?? systemClock).now().toISOString()
  const purpose = run.label === "pre-fix" ? "reproduction" : "verification"
  await input.session.manifestStore.modify((current) => ({
    ...current,
    humanCheckpoints: [
      ...(current.humanCheckpoints ?? []).filter((checkpoint) => checkpoint.requestId !== input.callId),
      {
        requestId: input.callId,
        runId: run.id,
        purpose,
        reproductionFingerprint:
          run.reproductionFingerprint ??
          reproductionFingerprint(typeof run.reproduction === "string" ? run.reproduction : state.reproduction.method),
        questionSha256: sha256(JSON.stringify(input.args)),
        askedAt: now,
        status: "asked" as const,
      },
    ],
  }))
}

export async function recordQuestionReply(input: {
  session: DebugSession
  callId: string
  metadata: unknown
  clock?: Clock
}): Promise<void> {
  const manifest = await input.session.manifestStore.read()
  const checkpoint = (manifest.humanCheckpoints ?? []).find((item) => item.requestId === input.callId)
  if (checkpoint === undefined) return
  const run = manifest.runs.find((item) => item.id === checkpoint.runId)
  const answer = selectedAnswer(input.metadata)
  const outcome =
    run === undefined || answer === undefined ? undefined : expectedOutcomes(run.label).get(normalizeLabel(answer))
  const now = (input.clock ?? systemClock).now().toISOString()
  await input.session.manifestStore.modify((current) => ({
    ...current,
    humanCheckpoints: (current.humanCheckpoints ?? []).map((item) =>
      item.requestId !== input.callId
        ? item
        : {
            ...item,
            status: outcome === undefined ? ("rejected" as const) : ("replied" as const),
            ...(outcome === undefined ? {} : { issueReproduced: outcome }),
            repliedAt: now,
          },
    ),
  }))
}

export async function recordVisibleLifecycleUpdate(
  session: DebugSession,
  text: string,
  clock: Clock = systemClock,
): Promise<void> {
  const state = await session.investigationStore.read()
  const workingHeading = hasWorkingHypothesesHeading(text)
  const evidenceHeading = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?evidence decision(?:\*\*)?\s*(?:\n|$)/iu.test(text)
  const visibleHypotheses =
    workingHeading &&
    state.hypotheses.length >= 2 &&
    state.hypotheses.length <= 4 &&
    state.hypotheses.every((hypothesis) => hypothesisIsVisible(text, hypothesis)) &&
    /confirm/iu.test(text) &&
    /eliminat/iu.test(text)
  const visibleEvidenceFingerprint = evidenceHeading ? visibleDecisionFingerprint(state, text) : undefined
  const visibleEvidence = visibleEvidenceFingerprint !== undefined
  if (!visibleHypotheses && !visibleEvidence) return
  const now = clock.now().toISOString()
  await session.manifestStore.modify((manifest) => ({
    ...manifest,
    ...(visibleHypotheses
      ? { visibleHypothesesAt: now, visibleHypothesesSha256: hypothesisSlateFingerprint(state) }
      : {}),
    ...(visibleEvidence
      ? { visibleEvidenceDecisionAt: now, visibleEvidenceDecisionSha256: visibleEvidenceFingerprint }
      : {}),
  }))
}
