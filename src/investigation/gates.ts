import { realpathSync } from "node:fs"
import path from "node:path"
import type { FinalReportInput } from "../cleanup/types.js"
import { DebugModeError } from "../core/errors.js"
import type { EvidenceStore } from "../evidence/store.js"
import type { EvidenceEvent } from "../evidence/types.js"
import { validateRuntimeCaptureCommand, validateRuntimeCaptureEnvironment } from "../process/command-policy.js"
import {
  evaluateOutcomePredicate,
  type OutcomePredicate,
  OutcomePredicateSchema,
  sameOutcomePredicate,
} from "../run/outcome.js"
import { reproductionFingerprint } from "../run/service.js"
import type { DebugSession } from "../session/registry.js"
import type { ManifestProbe, ManifestRun } from "../session/types.js"
import type { InvestigationState } from "./schema.js"

type RunFinishInput = Readonly<{
  status: "completed" | "failed" | "timed_out" | "cancelled"
  issueReproduced: boolean | null
  observationSource: "deterministic" | "human"
  observation?: string
}>

type ProcessPurpose = "instrumentation-check" | "reproduction" | "verification"

const SOURCE_AWARE_INSTRUMENTATION_COMMANDS = new Set(["node", "tsc", "tsgo"])

function reject(message: string, action: string): never {
  throw new DebugModeError("INVALID_PHASE", message, false, { action })
}

function executableName(executable: string): string {
  return path
    .basename(executable)
    .toLowerCase()
    .replace(/\.(?:bat|cmd|exe)$/u, "")
}

function argumentCoversSource(argument: string, cwd: string, sourceFile: string): boolean {
  if (argument.startsWith("-") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(argument)) return false
  if (/[*?{[]/u.test(argument)) return false
  return path.resolve(cwd, argument) === sourceFile
}

function instrumentationCheckCoversProbes(input: {
  executable: string
  args: readonly string[]
  cwd: string
  projectRoot: string
  probes: readonly ManifestProbe[]
}): boolean {
  const command = executableName(input.executable)
  const cwd = path.resolve(input.cwd)
  const sourceFiles = input.probes.map((probe) =>
    path.isAbsolute(probe.sourceFile)
      ? path.resolve(probe.sourceFile)
      : path.resolve(input.projectRoot, probe.sourceFile),
  )
  const explicitlyCovered = sourceFiles.every((sourceFile) =>
    input.args.some((argument) => argumentCoversSource(argument, cwd, sourceFile)),
  )
  if (!explicitlyCovered || !SOURCE_AWARE_INSTRUMENTATION_COMMANDS.has(command)) return false
  if (command === "node") {
    return (input.args[0] === "--check" || input.args[0] === "-c") && input.args.length === 2
  }
  return true
}

function eventData(event: EvidenceEvent): Record<string, unknown> | undefined {
  return typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : undefined
}

async function readRunEvidence(evidence: EvidenceStore, sessionId: string, runId: string): Promise<EvidenceEvent[]> {
  const events: EvidenceEvent[] = []
  let cursor: string | undefined
  do {
    const page = await evidence.read({
      sessionId,
      runId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    events.push(...page.events)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return events
}

function assertHypothesisSlate(state: InvestigationState): void {
  if (state.hypotheses.length < 2 || state.hypotheses.length > 4) {
    reject(
      "A runtime investigation requires two to four ranked falsifiable hypotheses",
      "Checkpoint two to four hypotheses with confirmation and elimination signals before instrumentation",
    )
  }
  const ids = new Set(state.hypotheses.map((hypothesis) => hypothesis.id))
  const ranks = new Set(state.hypotheses.map((hypothesis) => hypothesis.rank))
  if (ids.size !== state.hypotheses.length || ranks.size !== state.hypotheses.length) {
    reject("Hypothesis IDs and ranks must be unique", "Checkpoint a uniquely ranked hypothesis slate before continuing")
  }
}

function confirmedHypothesisIds(state: InvestigationState): Set<string> {
  return new Set(
    state.hypotheses.filter((hypothesis) => hypothesis.status === "confirmed").map((hypothesis) => hypothesis.id),
  )
}

function hasReferencedEvidence(state: InvestigationState): boolean {
  return state.hypotheses.some(
    (hypothesis) =>
      hypothesis.status === "confirmed" &&
      hypothesis.evidenceRefs.some((eventId) => state.decidingEvidenceIds.includes(eventId)),
  )
}

function qualifyingProbeEvent(
  event: EvidenceEvent,
  manifest: Awaited<ReturnType<DebugSession["manifestStore"]["read"]>>,
  reproducedRunIds: ReadonlySet<string>,
  confirmedIds: ReadonlySet<string>,
): boolean {
  if (
    event.kind !== "probe" ||
    event.runLabel !== "pre-fix" ||
    !reproducedRunIds.has(event.runId) ||
    !confirmedIds.has(event.hypothesisId)
  ) {
    return false
  }
  const run = manifest.runs.find((candidate) => candidate.id === event.runId)
  if (
    run === undefined ||
    run.completedAt === undefined ||
    new Date(event.receivedAt).getTime() < new Date(run.createdAt).getTime() ||
    new Date(event.receivedAt).getTime() > new Date(run.completedAt).getTime()
  ) {
    return false
  }
  return manifest.probes.some(
    (probe) =>
      probe.id === event.probeId &&
      probe.runId === event.runId &&
      probe.hypothesisId === event.hypothesisId &&
      probe.validationStatus === "validated",
  )
}

async function requireEvidence(
  evidence: EvidenceStore,
  eventIds: readonly string[],
  predicate: (event: EvidenceEvent) => boolean,
  message: string,
): Promise<EvidenceEvent[]> {
  const uniqueIds = [...new Set(eventIds)]
  const events = await evidence.findByIds(uniqueIds)
  if (events.length !== uniqueIds.length || events.some((event) => !predicate(event))) {
    reject(message, "Read the relevant run with debug_evidence_read and checkpoint only returned eventId values")
  }
  return events
}

function sameReproduction(left: ManifestRun, right: ManifestRun): boolean {
  const leftFingerprint = left.reproductionFingerprint ?? reproductionFingerprint(left.reproduction)
  const rightFingerprint = right.reproductionFingerprint ?? reproductionFingerprint(right.reproduction)
  return leftFingerprint === rightFingerprint
}

function latestBehavioralMutationAt(
  manifest: Awaited<ReturnType<DebugSession["manifestStore"]["read"]>>,
): string | undefined {
  return manifest.lastBehavioralMutationAt ?? manifest.fixStartedAt
}

function runMatchesCurrentBehavior(run: ManifestRun, behavioralRevision: number | undefined): boolean {
  return run.behavioralRevisionAtStart === (behavioralRevision ?? 0)
}

function derivedProcessOutcome(
  events: readonly EvidenceEvent[],
  purpose: ProcessPurpose,
  run: ManifestRun,
): { issueReproduced: boolean; resultEvent: EvidenceEvent } | undefined {
  const resultEvent = [...events]
    .reverse()
    .find((event) => event.kind === "process.result" && eventData(event)?.purpose === purpose)
  if (resultEvent === undefined) return undefined
  const data = eventData(resultEvent)
  const predicate = OutcomePredicateSchema.safeParse(data?.outcomePredicate)
  if (
    data === undefined ||
    predicate.success === false ||
    run.outcomePredicate === undefined ||
    !sameOutcomePredicate(run.outcomePredicate, predicate.data)
  ) {
    reject(
      "The supervised result is not bound to this run's deterministic outcome predicate",
      `Repeat debug_process_capture with purpose ${purpose} and the baseline outcome predicate`,
    )
  }
  const exitCode = data.exitCode
  const timedOut = data.timedOut
  if (
    (exitCode !== null && (!Number.isInteger(exitCode) || typeof exitCode !== "number")) ||
    typeof timedOut !== "boolean"
  ) {
    reject(
      "The supervised process result cannot be evaluated deterministically",
      `Repeat debug_process_capture with purpose ${purpose}`,
    )
  }
  const derived = evaluateOutcomePredicate(predicate.data, { exitCode, timedOut })
  if (derived === null || data.issueReproduced !== derived) {
    reject(
      "The supervised process did not produce a valid deterministic issue outcome",
      `Repeat debug_process_capture with purpose ${purpose} and use its returned issueReproduced value`,
    )
  }
  return { issueReproduced: derived, resultEvent }
}

function deterministicReproductionCrossedProbeBoundary(
  events: readonly EvidenceEvent[],
  resultEvent: EvidenceEvent,
  manifest: Awaited<ReturnType<DebugSession["manifestStore"]["read"]>>,
  run: ManifestRun,
): boolean {
  const data = eventData(resultEvent)
  const probeIds = data?.probeIds
  const probeEvents = data?.probeEvents
  const matchingProbeEventIds = data?.matchingProbeEventIds
  const matchingProbeEvents = data?.matchingProbeEvents
  if (
    !Array.isArray(probeIds) ||
    probeIds.length === 0 ||
    probeIds.some((value) => typeof value !== "string") ||
    new Set(probeIds).size !== probeIds.length ||
    !Array.isArray(matchingProbeEventIds) ||
    matchingProbeEventIds.length === 0 ||
    matchingProbeEventIds.some((value) => typeof value !== "string") ||
    new Set(matchingProbeEventIds).size !== matchingProbeEventIds.length ||
    !Number.isInteger(probeEvents) ||
    !Number.isInteger(matchingProbeEvents) ||
    probeEvents !== matchingProbeEvents ||
    matchingProbeEvents !== matchingProbeEventIds.length
  ) {
    return false
  }

  const selectedProbeIds = new Set(probeIds)
  const activeProbes = new Map(
    manifest.probes
      .filter(
        (probe) =>
          selectedProbeIds.has(probe.id) &&
          probe.runId === run.id &&
          probe.validationStatus === "validated" &&
          ["validated", "active"].includes(probe.status),
      )
      .map((probe) => [probe.id, probe] as const),
  )
  if (activeProbes.size !== selectedProbeIds.size) return false

  const resultIndex = events.indexOf(resultEvent)
  if (resultIndex < 0) return false
  const matchingIds = new Set(matchingProbeEventIds)
  const matchingEvents = events.slice(0, resultIndex).filter((event) => {
    if (event.kind !== "probe" || !matchingIds.has(event.eventId)) return false
    const probe = activeProbes.get(event.probeId)
    return (
      probe !== undefined &&
      event.sessionId === manifest.sessionId &&
      event.runId === run.id &&
      event.runLabel === "pre-fix" &&
      event.hypothesisId === probe.hypothesisId
    )
  })
  return matchingEvents.length === matchingProbeEventIds.length
}

function humanReceiptMatches(
  manifest: Awaited<ReturnType<DebugSession["manifestStore"]["read"]>>,
  runId: string,
  issueReproduced: boolean | null,
): boolean {
  const run = manifest.runs.find((candidate) => candidate.id === runId)
  if (run === undefined) return false
  const purpose = run.label === "pre-fix" ? "reproduction" : "verification"
  const fingerprint = run.reproductionFingerprint ?? reproductionFingerprint(run.reproduction)
  return (manifest.humanCheckpoints ?? []).some(
    (checkpoint) =>
      checkpoint.runId === runId &&
      checkpoint.purpose === purpose &&
      checkpoint.reproductionFingerprint === fingerprint &&
      checkpoint.questionSha256 !== undefined &&
      checkpoint.status === "replied" &&
      checkpoint.issueReproduced === issueReproduced,
  )
}

export async function validateFixAuthorization(
  session: DebugSession,
  evidence: EvidenceStore,
  state: InvestigationState,
): Promise<void> {
  if (state.phase !== "fixing") return
  assertHypothesisSlate(state)
  if (state.reproduction.confirmed !== true) {
    reject(
      "A behavioral fix is blocked until the reported failure is confirmed in a pre-fix run",
      "Finish the pre-fix run with debug_run_finish and checkpoint reproduction.confirmed=true only if it reproduced",
    )
  }
  const confirmedIds = confirmedHypothesisIds(state)
  if (confirmedIds.size === 0) {
    reject(
      "A behavioral fix requires at least one confirmed hypothesis",
      "Classify the hypothesis slate from persisted runtime probe evidence before requesting phase fixing",
    )
  }
  if (state.decidingEvidenceIds.length === 0 || !hasReferencedEvidence(state)) {
    reject(
      "A behavioral fix requires deciding evidence tied to a confirmed hypothesis",
      "Use debug_evidence_read, classify the hypotheses, and reference the deciding eventId values",
    )
  }
  if (state.singleCauseEvidenceRef !== null && !state.decidingEvidenceIds.includes(state.singleCauseEvidenceRef)) {
    reject(
      "The direct-cause reference must also be retained as deciding evidence",
      "Reference the same qualifying runtime probe event in decidingEvidenceIds and the confirmed hypothesis",
    )
  }
  if (state.decisions.length === 0 || state.fixedFiles.length === 0) {
    reject(
      "A behavioral fix requires a checkpointed evidence decision and an explicit file scope",
      "Record the selected evidence-backed change in decisions and list every intended path in fixedFiles",
    )
  }

  const manifest = await session.manifestStore.read()
  const reproducedRuns = manifest.runs.filter(
    (run) => run.label === "pre-fix" && run.status === "completed" && run.issueReproduced === true,
  )
  if (reproducedRuns.length === 0) {
    reject(
      "A behavioral fix requires a completed pre-fix run whose issueReproduced result is true",
      "Call debug_run_finish for the reproduced pre-fix run before requesting phase fixing",
    )
  }
  const reproducedRunIds = new Set(reproducedRuns.map((run) => run.id))
  const decidingEvents = await requireEvidence(
    evidence,
    state.decidingEvidenceIds,
    (event) => qualifyingProbeEvent(event, manifest, reproducedRunIds, confirmedIds),
    "Every deciding evidence ID must be a validated runtime probe event from the reproduced pre-fix run",
  )
  const referenced = state.hypotheses.some(
    (hypothesis) =>
      hypothesis.status === "confirmed" &&
      decidingEvents.some(
        (event) => event.hypothesisId === hypothesis.id && hypothesis.evidenceRefs.includes(event.eventId),
      ),
  )
  if (!referenced) {
    reject(
      "Deciding probe evidence must be referenced by its confirmed hypothesis",
      "Use debug_evidence_read and attach the matching pre-fix probe eventId to the confirmed hypothesis",
    )
  }
}

export async function validateInstrumentationAuthorization(
  session: DebugSession,
  runId?: string,
  requestedTransport?: "process" | "http-web" | "extension-background" | "extension-content",
): Promise<void> {
  const state = await session.investigationStore.read()
  assertHypothesisSlate(state)
  if (state.phase !== "instrumenting") {
    reject(
      "Collector and probe instrumentation are available only in phase instrumenting",
      "Checkpoint the ranked hypotheses and phase instrumenting before preparing owned instrumentation",
    )
  }
  const manifest = await session.manifestStore.read()
  const run = manifest.runs.find(
    (candidate) =>
      candidate.label === "pre-fix" &&
      ["running", "waiting"].includes(candidate.status) &&
      (runId === undefined || candidate.id === runId),
  )
  if (run === undefined) {
    reject("Instrumentation requires an active pre-fix run", "Start the pre-fix run before the collector or probe")
  }
  const requiresBrowserProbe =
    state.reproduction.requiresUser && ["web", "extension"].includes(state.runtimeContext.kind)
  const hasActiveBrowserProbe = manifest.probes.some(
    (probe) => probe.runId === run.id && probe.status !== "removed" && probe.transport !== "process",
  )
  if (requestedTransport === "process" && requiresBrowserProbe && !hasActiveBrowserProbe) {
    reject(
      "A process probe cannot substitute for the first browser or extension probe in a human reproduction",
      "Prepare the first probe with http-web, extension-background, or extension-content in the actual runtime path; a process probe in a test file may be added only after that browser probe exists",
    )
  }
}

export async function validateRunStart(
  session: DebugSession,
  input: { label: "pre-fix" | "post-fix"; reproduction: string; waitingForUser: boolean },
): Promise<{ label: "pre-fix" | "post-fix"; reproduction: string; waitingForUser: boolean }> {
  const state = await session.investigationStore.read()
  const manifest = await session.manifestStore.read()
  assertHypothesisSlate(state)
  if (state.reproduction.method.trim().length === 0) {
    reject(
      "A run requires a concrete checkpointed reproduction procedure",
      "Checkpoint a non-empty reproduction.method that crosses the reported runtime boundary before starting the run",
    )
  }
  const expectedRunStart = {
    label: input.label,
    reproduction: state.reproduction.method,
    waitingForUser: state.reproduction.requiresUser,
  }
  if (manifest.runs.some((run) => run.label === input.label && ["running", "waiting"].includes(run.status))) {
    reject("Another run with this label is still active", "Finish or cancel the active run before starting another")
  }
  if (input.label === "pre-fix") {
    if (!["hypotheses", "baseline", "instrumenting"].includes(state.phase)) {
      reject("A pre-fix run must start before fixing", "Checkpoint phase baseline, then start the failing baseline")
    }
    return expectedRunStart
  }
  if (
    state.phase !== "verifying" ||
    latestBehavioralMutationAt(manifest) === undefined ||
    (manifest.behavioralRevision ?? 0) < 1
  ) {
    reject(
      "A post-fix run can start only after a successful evidence-authorized behavioral edit",
      "Apply the scoped fix, checkpoint phase verifying, then start the post-fix run",
    )
  }
  const preFix = manifest.runs.find(
    (run) => run.label === "pre-fix" && run.status === "completed" && run.issueReproduced === true,
  )
  if (
    preFix === undefined ||
    reproductionFingerprint(expectedRunStart.reproduction) !==
      (preFix.reproductionFingerprint ?? reproductionFingerprint(preFix.reproduction))
  ) {
    reject(
      "Post-fix verification must repeat the reproduced pre-fix procedure",
      "Use the exact same runtime-boundary reproduction for the post-fix run",
    )
  }
  return expectedRunStart
}

export async function validateRunFinish(
  session: DebugSession,
  evidence: EvidenceStore,
  run: ManifestRun,
  input: RunFinishInput,
): Promise<void> {
  if (input.status !== "completed") return
  if (input.issueReproduced === null) {
    reject("A completed run requires an observed issue outcome", "Set issueReproduced from the actual run result")
  }
  const state = await session.investigationStore.read()
  const manifest = await session.manifestStore.read()
  if (input.observationSource === "human") {
    if (run.status !== "waiting" || !humanReceiptMatches(manifest, run.id, input.issueReproduced)) {
      reject(
        "A human run outcome requires the matching replied reproduction Question",
        "Ask the prepared outcome Question and pass the observed answer to debug_run_finish",
      )
    }
  } else {
    if (state.reproduction.requiresUser || run.status !== "running") {
      reject(
        "A human-only runtime boundary cannot be self-attested as deterministic",
        "Use a waiting run and the prepared reproduction or verification Question",
      )
    }
    const events = await readRunEvidence(evidence, session.publicId, run.id)
    const purpose = run.label === "pre-fix" ? "reproduction" : "verification"
    const derived = derivedProcessOutcome(events, purpose, run)
    if (derived === undefined) {
      reject(
        "A deterministic run outcome requires a completed supervised runtime capture",
        `Run debug_process_capture with purpose ${purpose} and an outcome predicate before finishing this run`,
      )
    }
    if (derived.issueReproduced !== input.issueReproduced) {
      reject(
        "The claimed deterministic issue outcome conflicts with the supervised process result",
        "Use the issueReproduced value returned by debug_process_capture",
      )
    }
    if (
      run.label === "pre-fix" &&
      input.issueReproduced === true &&
      !deterministicReproductionCrossedProbeBoundary(events, derived.resultEvent, manifest, run)
    ) {
      reject(
        "The supervised reproduction did not cross a registered active validated runtime probe boundary",
        "Repeat the exact same-path reproduction until one of the capture's registered probeIds emits evidence, or use the prepared human reproduction Question when the boundary requires manual interaction; do not treat an unrelated process exit failure as the reported symptom",
      )
    }
  }
  if (run.label === "pre-fix") {
    if (!["baseline", "instrumenting", "waiting_for_reproduction", "analyzing"].includes(state.phase)) {
      reject("The pre-fix result arrived outside the baseline lifecycle", "Reconcile state before finishing the run")
    }
    return
  }
  const lastMutationAt = latestBehavioralMutationAt(manifest)
  if (
    state.phase !== "verifying" ||
    lastMutationAt === undefined ||
    !runMatchesCurrentBehavior(run, manifest.behavioralRevision)
  ) {
    reject("Post-fix verification is blocked until after the fix", "Apply the authorized fix before verification")
  }
  if (new Date(run.createdAt).getTime() < new Date(lastMutationAt).getTime()) {
    reject("This post-fix run began before the fix", "Start a new same-path post-fix run after the edit")
  }
  const preFix = manifest.runs.find(
    (candidate) =>
      candidate.label === "pre-fix" && candidate.status === "completed" && candidate.issueReproduced === true,
  )
  if (preFix === undefined || !sameReproduction(preFix, run)) {
    reject("Post-fix verification does not match the reproduced baseline", "Repeat the exact same reproduction path")
  }
}

export async function validateProcessCapture(input: {
  session: DebugSession
  runId: string
  purpose: ProcessPurpose
  probeIds: string[]
  executable: string
  args: string[]
  env: Record<string, string>
  cwd: string
  outcomePredicate?: OutcomePredicate
}): Promise<void> {
  const policyArgs = input.args.map((argument) => {
    if (!path.isAbsolute(argument)) return argument
    let canonical = path.resolve(argument)
    try {
      canonical = realpathSync(canonical)
    } catch {
      // The command policy still rejects unresolved paths that escape the project.
    }
    const relative = path.relative(input.session.projectRoot, canonical)
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      reject(
        "Supervised command arguments cannot reference absolute paths outside the active project",
        "Use project-contained check and test paths",
      )
    }
    return relative
  })
  validateControlledCommand(input.executable, policyArgs)
  validateRuntimeCaptureEnvironment(input.env)
  if (input.purpose === "instrumentation-check" && input.outcomePredicate !== undefined) {
    reject(
      "Instrumentation checks cannot define the reported issue outcome",
      "Omit outcomePredicate from the instrumentation-check capture",
    )
  }
  const state = await input.session.investigationStore.read()
  const manifest = await input.session.manifestStore.read()
  const run = manifest.runs.find((candidate) => candidate.id === input.runId)
  if (run === undefined || !["running", "waiting"].includes(run.status)) {
    reject("Process capture requires an active run", "Start or resume the matching run before executing a capture")
  }
  if (input.purpose !== "instrumentation-check" && input.outcomePredicate === undefined) {
    reject(
      "A reproduction or verification capture requires a deterministic outcome predicate",
      "Set outcomePredicate to the exit-code condition that means the reported issue is present",
    )
  }
  if (input.purpose === "verification") {
    if (
      run.label !== "post-fix" ||
      state.phase !== "verifying" ||
      latestBehavioralMutationAt(manifest) === undefined ||
      !runMatchesCurrentBehavior(run, manifest.behavioralRevision)
    ) {
      reject("Verification capture is blocked until after the fix", "Start the post-fix run in phase verifying")
    }
    const baseline = manifest.runs.find(
      (candidate) =>
        candidate.label === "pre-fix" &&
        candidate.status === "completed" &&
        candidate.issueReproduced === true &&
        sameReproduction(candidate, run),
    )
    if (
      baseline?.outcomePredicate === undefined ||
      input.outcomePredicate === undefined ||
      !sameOutcomePredicate(baseline.outcomePredicate, input.outcomePredicate)
    ) {
      reject(
        "Post-fix verification must use the baseline deterministic outcome predicate",
        "Repeat the same-path verification with the exact outcomePredicate used by the reproduced pre-fix run",
      )
    }
    return
  }
  if (run.label !== "pre-fix" || state.phase !== "instrumenting") {
    reject(
      "Pre-fix captures require the active instrumenting baseline",
      "Checkpoint phase instrumenting and use the pre-fix run",
    )
  }
  if (input.probeIds.length === 0) {
    reject(
      "Pre-fix runtime capture requires an owned probe",
      "Prepare, register, and validate the discriminating probe",
    )
  }
  if (
    input.probeIds.some((probeId) => !manifest.probes.some((probe) => probe.id === probeId && probe.runId === run.id))
  ) {
    reject("Capture probes must belong to this run", "Use only the registered probe IDs for the active pre-fix run")
  }
  if (input.purpose === "instrumentation-check") {
    const probes = input.probeIds
      .map((probeId) => manifest.probes.find((probe) => probe.id === probeId && probe.runId === run.id))
      .filter((probe): probe is ManifestProbe => probe !== undefined)
    if (probes.some((probe) => !["registered", "validated", "active"].includes(probe.status))) {
      reject(
        "Instrumentation checks require registered owned probes",
        "Insert each exact prepared block, call debug_probe_register, then run a check that covers every probed source file",
      )
    }
    if (
      !instrumentationCheckCoversProbes({
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        projectRoot: input.session.projectRoot,
        probes,
      })
    ) {
      const sourceFiles = probes.map((probe) => path.relative(input.session.projectRoot, probe.sourceFile)).join(", ")
      reject(
        "The instrumentation-check command does not cover every probed source file",
        `Run node --check for every probed source, or a direct tsc/tsgo --noEmit command that explicitly names every probed source: ${sourceFiles}`,
      )
    }
  }
}

export function validateControlledCommand(executable: string, args: readonly string[]): void {
  validateRuntimeCaptureCommand(executable, args)
}

export async function validateCheckpointTransition(session: DebugSession, state: InvestigationState): Promise<void> {
  if (
    [
      "hypotheses",
      "baseline",
      "instrumenting",
      "waiting_for_reproduction",
      "analyzing",
      "fixing",
      "verifying",
      "cleaning",
    ].includes(state.phase)
  ) {
    assertHypothesisSlate(state)
  }
  const manifest = await session.manifestStore.read()
  const currentState = await session.investigationStore.read()
  if (
    currentState.phase === "waiting_for_reproduction" &&
    state.phase !== "waiting_for_reproduction" &&
    manifest.runs.some((run) => run.label === "pre-fix" && run.status === "waiting")
  ) {
    reject(
      "The prepared human reproduction checkpoint cannot be bypassed",
      "Invoke Question with preparedQuestionArgs, record its reply, and finish the waiting pre-fix run before changing phase",
    )
  }
  if (state.phase === "fixing") return
  if (state.phase === "instrumenting") {
    if (!manifest.runs.some((run) => run.label === "pre-fix" && ["running", "waiting"].includes(run.status))) {
      reject("Phase instrumenting requires an active pre-fix run", "Start the baseline before instrumentation")
    }
  }
  if (state.phase === "waiting_for_reproduction") {
    const waiting = manifest.runs.find((run) => run.label === "pre-fix" && run.status === "waiting")
    const activeRunProbes = manifest.probes.filter((probe) => probe.runId === waiting?.id && probe.status !== "removed")
    const everyProbeValidated = activeRunProbes.every(
      (probe) => probe.validationStatus === "validated" && ["validated", "active"].includes(probe.status),
    )
    const validatedBrowserProbe = activeRunProbes.some(
      (probe) =>
        probe.transport !== "process" &&
        probe.validationStatus === "validated" &&
        ["validated", "active"].includes(probe.status),
    )
    if (
      waiting === undefined ||
      manifest.collector?.status !== "ready" ||
      !everyProbeValidated ||
      !validatedBrowserProbe
    ) {
      reject(
        "Human reproduction is blocked until its collector and every active owned probe are ready",
        "Start the collector, prepare at least one non-process probe in the actual web or extension runtime path, register every non-removed probe, and pass instrumentation-check for all probes. A process probe in a test file cannot satisfy this checkpoint",
      )
    }
  }
  if (
    ["verifying", "cleaning"].includes(state.phase) &&
    (latestBehavioralMutationAt(manifest) === undefined || (manifest.behavioralRevision ?? 0) < 1)
  ) {
    reject("Verification cannot precede the behavioral edit", "Apply the evidence-authorized fix before advancing")
  }
}

export async function validateCompletedOutcome(
  session: DebugSession,
  evidence: EvidenceStore,
  report: FinalReportInput,
): Promise<FinalReportInput> {
  if (report.outcome !== "completed") return report
  const state = await session.investigationStore.read()
  assertHypothesisSlate(state)
  if (state.phase !== "verifying" && state.phase !== "cleaning") {
    reject(
      "A completed report is blocked until the investigation reaches verification",
      "Checkpoint phase verifying and complete a post-fix run before cleanup",
    )
  }
  if (state.decidingEvidenceIds.length === 0 || !hasReferencedEvidence(state)) {
    reject(
      "A completed report requires the pre-fix deciding evidence retained in state",
      "Checkpoint confirmed hypotheses and their deciding eventId values before cleanup",
    )
  }
  const manifest = await session.manifestStore.read()
  const stateHypotheses = [...state.hypotheses]
    .map(({ id, status, statement }) => ({ id, status, statement }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const mutationFiles = new Set((manifest.behavioralMutations ?? []).flatMap((mutation) => mutation.paths))
  if (mutationFiles.size === 0) {
    reject(
      "A completed report requires a successful behavioral mutation",
      "Apply the evidence-authorized fix before cleanup",
    )
  }
  const confirmedStatements = state.hypotheses
    .filter((hypothesis) => hypothesis.status === "confirmed")
    .map((hypothesis) => hypothesis.statement)
  const decisionSummaries = state.decisions.map((decision) => decision.summary)
  const preFixRuns = manifest.runs.filter(
    (run) => run.label === "pre-fix" && run.status === "completed" && run.issueReproduced === true,
  )
  const postFixRuns = manifest.runs.filter(
    (run) =>
      run.label === "post-fix" &&
      run.status === "completed" &&
      run.issueReproduced === false &&
      latestBehavioralMutationAt(manifest) !== undefined &&
      runMatchesCurrentBehavior(run, manifest.behavioralRevision) &&
      new Date(run.createdAt).getTime() >= new Date(latestBehavioralMutationAt(manifest) as string).getTime() &&
      preFixRuns.some((preFix) => sameReproduction(preFix, run)),
  )
  if (preFixRuns.length === 0 || postFixRuns.length === 0) {
    reject(
      "A completed report requires reproduced pre-fix and same-path post-fix runs created after the fix",
      "Finish both runs with debug_run_finish and record the observed issue outcome",
    )
  }
  if (
    (state.reproduction.requiresUser || preFixRuns.some((run) => run.observationSource === "human")) &&
    !postFixRuns.some((run) => run.observationSource === "human" && humanReceiptMatches(manifest, run.id, false))
  ) {
    reject(
      "A human-reproduced baseline requires same-path human post-fix verification",
      "Ask the prepared Fixed / Still reproduces / Could not verify Question, then finish the post-fix run as human",
    )
  }
  const confirmedIds = confirmedHypothesisIds(state)
  const preFixRunIds = new Set(preFixRuns.map((run) => run.id))
  await requireEvidence(
    evidence,
    state.decidingEvidenceIds,
    (event) => qualifyingProbeEvent(event, manifest, preFixRunIds, confirmedIds),
    "The final pre-fix evidence no longer matches a qualifying validated probe",
  )

  const postEvents = (
    await Promise.all(postFixRuns.map((run) => readRunEvidence(evidence, session.publicId, run.id)))
  ).flat()
  const qualifyingPostEvents = postEvents.filter((event) => {
    if (event.kind === "human.observation") return true
    return event.kind === "process.result" && eventData(event)?.purpose === "verification"
  })
  if (qualifyingPostEvents.length === 0) {
    reject(
      "A completed report requires attested post-fix evidence",
      "Complete the same-path verification run before cleanup",
    )
  }

  return {
    ...report,
    rootCause: confirmedStatements.join("; "),
    decidingEvidence: [...state.decidingEvidenceIds],
    hypotheses: stateHypotheses,
    fix: decisionSummaries.join("; "),
    changedFiles: [...mutationFiles].sort(),
    verification: qualifyingPostEvents.map(
      (event) => `${event.eventId}: same-path post-fix verification did not reproduce the issue`,
    ),
  }
}

export function validateCleanupReason(reason: string, outcome: FinalReportInput["outcome"]): void {
  const expected: Partial<Record<string, FinalReportInput["outcome"]>> = {
    completed: "completed",
    unresolved: "unresolved",
    abandoned: "abandoned",
    escalated: "escalated",
  }
  if (
    (expected[reason] !== undefined && expected[reason] !== outcome) ||
    (reason === "cancelled" && outcome === "completed")
  ) {
    reject("Cleanup reason and report outcome are inconsistent", "Use the matching terminal reason and outcome")
  }
}
