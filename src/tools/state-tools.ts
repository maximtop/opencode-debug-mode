import path from "node:path"
import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import { DebugModeError } from "../core/errors.js"
import type { EvidenceStore } from "../evidence/store.js"
import { validateCheckpointTransition, validateFixAuthorization } from "../investigation/gates.js"
import {
  renderEvidenceDecisionMarkdown,
  renderPreparedQuestionArgs,
  renderWorkingHypothesesMarkdown,
} from "../investigation/lifecycle-receipts.js"
import { type InvestigationState, InvestigationStateSchema } from "../investigation/schema.js"
import { reproductionFingerprint } from "../run/service.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import type { CleanupManifest } from "../session/types.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema
type ToolCompatibleInvestigationStateSchema = ReturnType<typeof schema.custom<InvestigationState>>

// @opencode-ai/plugin and this package can resolve separate Zod instances. Mirror the
// state metadata into the tool's registry so OpenCode receives these descriptions.
function exposeDescriptionToToolSchema(value: { description?: string }): void {
  if (value.description === undefined) return
  schema.globalRegistry.add(value as never, { description: value.description })
}

exposeDescriptionToToolSchema(InvestigationStateSchema.shape.reproduction)
exposeDescriptionToToolSchema(InvestigationStateSchema.shape.reproduction.shape.method)
exposeDescriptionToToolSchema(InvestigationStateSchema.shape.reproduction.shape.requiresUser)

const CheckpointStateSchema = InvestigationStateSchema as unknown as ToolCompatibleInvestigationStateSchema

function parseCheckpointStateInput(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (Buffer.byteLength(value) > 262_144) {
    throw new DebugModeError("STATE_INVALID", "Serialized checkpoint state exceeds the 262144-byte limit", false, {
      action: "Call debug_state_read and submit its complete state without unrelated content",
    })
  }
  try {
    return JSON.parse(value)
  } catch {
    throw new DebugModeError("STATE_INVALID", "Serialized checkpoint state must be valid JSON", false, {
      action: "Call debug_state_read, preserve every returned field, and retry with the complete state object",
    })
  }
}

function checkpointIssueDetails(issues: ReadonlyArray<{ code: string; path: PropertyKey[] }>): {
  issueCount: number
  listedIssueCount: number
  issueSummary: string
  paths: string[]
} {
  const visible = issues.slice(0, 20).map((issue) => ({
    code: issue.code,
    path: `state${issue.path
      .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`))
      .join("")}`,
  }))
  return {
    issueCount: issues.length,
    listedIssueCount: visible.length,
    issueSummary: visible
      .map((issue) => `${issue.path} (${issue.code})`)
      .join("; ")
      .slice(0, 4_096),
    paths: visible.map((issue) => issue.path),
  }
}

async function reconcileProbeReferenceStatuses(
  session: DebugSession,
  state: InvestigationState,
): Promise<InvestigationState> {
  if (state.probeRefs.length === 0) return state
  const manifest = await session.manifestStore.read()
  const probes = new Map(manifest.probes.map((probe) => [probe.id, probe] as const))
  let changed = false
  const probeRefs = state.probeRefs.map((reference) => {
    const probe = probes.get(reference.id)
    const referenceSource = path.resolve(session.projectRoot, reference.sourceFile)
    const manifestSource = probe === undefined ? undefined : path.resolve(session.projectRoot, probe.sourceFile)
    if (
      probe === undefined ||
      probe.runId !== reference.runId ||
      probe.hypothesisId !== reference.hypothesisId ||
      manifestSource !== referenceSource ||
      probe.status === reference.status
    ) {
      return reference
    }
    changed = true
    return { ...reference, status: probe.status }
  })
  return changed ? { ...state, probeRefs } : state
}

async function reconcileRunReferences(session: DebugSession, state: InvestigationState): Promise<InvestigationState> {
  const manifest = await session.manifestStore.read()
  const manifestRuns = manifest.runs ?? []
  const existing = new Map(state.runs.map((run) => [run.id, run] as const))
  const runs = manifestRuns.map((run) => {
    const current = existing.get(run.id)
    return {
      id: run.id,
      label: run.label,
      status: run.status,
      ...(run.issueReproduced === undefined ? {} : { issueReproduced: run.issueReproduced }),
      ...(run.observationSource === undefined ? {} : { observationSource: run.observationSource }),
      ...(run.observation === undefined ? {} : { observation: run.observation }),
      evidenceRefs: current?.evidenceRefs ?? [],
    }
  })
  return JSON.stringify(runs) === JSON.stringify(state.runs) ? state : { ...state, runs }
}

function preparedQuestionArgs(state: InvestigationState, manifest: Pick<CleanupManifest, "runs">) {
  const waiting = manifest.runs.filter((run) => run.status === "waiting")
  const run = waiting[0]
  if (waiting.length !== 1 || run === undefined) return undefined
  if (
    (run.label === "pre-fix" && state.phase !== "waiting_for_reproduction") ||
    (run.label === "post-fix" && state.phase !== "verifying")
  ) {
    return undefined
  }
  return renderPreparedQuestionArgs(run.label, run.reproduction)
}

const TERMINAL_RUN_STATUSES = new Set<CleanupManifest["runs"][number]["status"]>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
])

function canPromoteReproductionToUser(
  currentState: InvestigationState,
  state: InvestigationState,
  manifest: CleanupManifest,
): {
  allowed: boolean
  details: Record<string, string | number | boolean>
} {
  const runtimeKindMatches = currentState.runtimeContext.kind === state.runtimeContext.kind
  const reproductionMethodMatches =
    reproductionFingerprint(currentState.reproduction.method) === reproductionFingerprint(state.reproduction.method)
  const allRunsTerminal = manifest.runs.every((run) => TERMINAL_RUN_STATUSES.has(run.status))
  const deterministicPreFixReproduced = manifest.runs.some(
    (run) =>
      run.label === "pre-fix" &&
      run.status === "completed" &&
      run.observationSource === "deterministic" &&
      run.issueReproduced === true,
  )
  const behavioralMutationStarted =
    manifest.fixStartedAt !== undefined ||
    manifest.lastBehavioralMutationAt !== undefined ||
    (manifest.behavioralRevision ?? 0) > 0 ||
    (manifest.behavioralMutations?.length ?? 0) > 0
  const decidingEvidencePresent = currentState.decidingEvidenceIds.length > 0 || state.decidingEvidenceIds.length > 0
  const startsNewHypothesisIteration = state.phase === "hypotheses" && state.loopIteration > currentState.loopIteration
  const isFalseToTruePromotion =
    currentState.reproduction.requiresUser === false && state.reproduction.requiresUser === true

  return {
    allowed:
      isFalseToTruePromotion &&
      runtimeKindMatches &&
      reproductionMethodMatches &&
      allRunsTerminal &&
      !deterministicPreFixReproduced &&
      !behavioralMutationStarted &&
      !decidingEvidencePresent &&
      startsNewHypothesisIteration,
    details: {
      runtimeKindMatches,
      reproductionMethodMatches,
      allRunsTerminal,
      deterministicPreFixReproduced,
      behavioralMutationStarted,
      decidingEvidencePresent,
      incomingPhaseIsHypotheses: state.phase === "hypotheses",
      currentLoopIteration: currentState.loopIteration,
      incomingLoopIteration: state.loopIteration,
    },
  }
}

export function createStateReadTool(registry: SessionRegistry): ToolDefinition {
  return tool({
    description:
      "Read and reconcile the durable investigation checkpoint, including the authoritative reproduction boundary and its gated false-to-true new-iteration recovery",
    args: {},
    execute: async (_args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const result = await session.investigationStore.readRecovery()
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        const state = await reconcileRunReferences(
          session,
          await reconcileProbeReferenceStatuses(session, result.state),
        )
        const manifest = await session.manifestStore.read()
        const visibilityReceiptMarkdown = renderWorkingHypothesesMarkdown(state)
        const evidenceDecisionReceiptMarkdown = renderEvidenceDecisionMarkdown(state)
        const questionArgs = preparedQuestionArgs(state, manifest)
        return jsonSuccess({
          ...(visibilityReceiptMarkdown === undefined ? {} : { visibilityReceiptMarkdown }),
          ...(evidenceDecisionReceiptMarkdown === undefined ? {} : { evidenceDecisionReceiptMarkdown }),
          ...(questionArgs === undefined ? {} : { preparedQuestionArgs: questionArgs }),
          preFixRunStartArgs: {
            label: "pre-fix" as const,
            reproduction: state.reproduction.method,
            waitingForUser: state.reproduction.requiresUser,
          },
          state,
          recoveryWarnings: result.warnings,
        })
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
          const value = error as { code: string; message: string }
          const { DebugModeError } = await import("../core/errors.js")
          return jsonFailure(new DebugModeError(value.code as never, value.message), "Checkpoint is unavailable")
        }
        return jsonFailure(error, "Checkpoint is unavailable")
      }
    },
  })
}

export function createStateCheckpointTool(
  registry: SessionRegistry,
  evidenceFor: (session: DebugSession) => EvidenceStore,
): ToolDefinition {
  return tool({
    description:
      "Persist the durable investigation state. IMPORTANT: when a successful response includes nextAssistantAction, follow it in ordinary assistant text before making another tool call; no debug_state_read handshake is needed. At the first checkpoint, set reproduction.requiresUser=true for a provided interactive browser, extension, device, or external-state procedure; false is valid only when an existing supervised command already reproduces the exact same runtime symptom. Local Node, mock, fixture, or test approximations do not qualify. After the first baseline run starts, true can never become false; a mistaken false may become true only in a gated new hypothesis iteration after every run is terminal, before deciding evidence or a behavioral fix. phase=fixing is rejected without a reproduced pre-fix run and real deciding evidence IDs",
    args: { expectedRevision: schema.number().int().nonnegative(), state: CheckpointStateSchema },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const parsed = InvestigationStateSchema.safeParse(parseCheckpointStateInput(args.state))
        if (!parsed.success) {
          const details = checkpointIssueDetails(parsed.error.issues)
          const fields = [...new Set(details.paths)]
          throw new DebugModeError(
            "STATE_INVALID",
            "Checkpoint must contain the complete investigation state returned by debug_state_read",
            false,
            {
              action: `Call debug_state_read and restore or correct these fields exactly: ${fields.join(", ")}. Copy every sibling field unchanged, then retry with the current revision`,
              details: {
                issueCount: details.issueCount,
                listedIssueCount: details.listedIssueCount,
                issueSummary: details.issueSummary,
              },
            },
          )
        }
        const state = await reconcileRunReferences(session, await reconcileProbeReferenceStatuses(session, parsed.data))
        const manifest = await session.manifestStore.read()
        if (
          (manifest.runs?.length ?? 0) > 0 ||
          (manifest.visibleHypothesesAt !== undefined && manifest.visibleHypothesesSha256 !== undefined)
        ) {
          const currentState = await session.investigationStore.read()
          if (currentState.revision === args.expectedRevision) {
            const runtimeKindChanged = currentState.runtimeContext.kind !== state.runtimeContext.kind
            const reproductionMethodChanged =
              reproductionFingerprint(currentState.reproduction.method) !==
              reproductionFingerprint(state.reproduction.method)
            const requiresUserChanged = currentState.reproduction.requiresUser !== state.reproduction.requiresUser
            const scopeChanged = runtimeKindChanged || reproductionMethodChanged || requiresUserChanged
            const promotion = canPromoteReproductionToUser(currentState, state, manifest)
            if ((manifest.runs?.length ?? 0) > 0 && scopeChanged && !promotion.allowed) {
              if (currentState.reproduction.requiresUser === false && state.reproduction.requiresUser === true) {
                throw new DebugModeError(
                  "INVALID_PHASE",
                  "The reproduction boundary can be promoted to a human checkpoint only at a safe new hypothesis iteration",
                  true,
                  {
                    action:
                      "Keep runtimeContext.kind and reproduction.method unchanged. Finish or cancel every nonterminal run, leave behavioral code and decidingEvidenceIds untouched, increment loopIteration, and checkpoint phase hypotheses for the new iteration. If a completed deterministic pre-fix run already reproduced the symptom or a behavioral fix started, begin a new debug session instead",
                    details: promotion.details,
                  },
                )
              }
              throw new DebugModeError(
                "INVALID_PHASE",
                "The runtime and reproduction boundary are frozen after the first baseline run starts",
                true,
                {
                  action:
                    "Call debug_state_read and preserve runtimeContext.kind and reproduction.method exactly. Never change reproduction.requiresUser from true to false; a local process or test substitute cannot replace a human web or extension reproduction",
                  details: {
                    expectedRuntimeKind: currentState.runtimeContext.kind,
                    incomingRuntimeKind: state.runtimeContext.kind,
                    expectedRequiresUser: currentState.reproduction.requiresUser,
                    incomingRequiresUser: state.reproduction.requiresUser,
                  },
                },
              )
            }
          }
        }
        await validateCheckpointTransition(session, state)
        await validateFixAuthorization(session, evidenceFor(session), state)
        const result = await session.investigationStore.checkpoint(args.expectedRevision, state as InvestigationState)
        await registry.touch(context.sessionID)
        const visibilityReceiptMarkdown = renderWorkingHypothesesMarkdown(result.state)
        const evidenceDecisionReceiptMarkdown = renderEvidenceDecisionMarkdown(result.state)
        const questionArgs = preparedQuestionArgs(result.state, manifest)
        const nextAssistantAction =
          result.state.phase === "hypotheses" && visibilityReceiptMarkdown !== undefined
            ? "Before any further tool call, send visibilityReceiptMarkdown as the visible ## Working hypotheses update."
            : result.state.phase === "fixing" && evidenceDecisionReceiptMarkdown !== undefined
              ? "Before the behavioral edit, send a visible ## Evidence decision using evidenceDecisionReceiptMarkdown and the observed runtime values."
              : undefined
        return jsonSuccess({
          revision: result.state.revision,
          bytes: result.bytes,
          ...(visibilityReceiptMarkdown === undefined ? {} : { visibilityReceiptMarkdown }),
          ...(evidenceDecisionReceiptMarkdown === undefined ? {} : { evidenceDecisionReceiptMarkdown }),
          ...(nextAssistantAction === undefined ? {} : { nextAssistantAction }),
          ...(questionArgs === undefined ? {} : { preparedQuestionArgs: questionArgs }),
          preFixRunStartArgs: {
            label: "pre-fix" as const,
            reproduction: result.state.reproduction.method,
            waitingForUser: result.state.reproduction.requiresUser,
          },
        })
      } catch (error) {
        return jsonFailure(error, "Checkpoint update failed")
      }
    },
  })
}
