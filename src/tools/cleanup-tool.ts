import path from "node:path"
import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import type { CleanupService } from "../cleanup/service.js"
import { type FinalReportInput, FinalReportInputSchema } from "../cleanup/types.js"
import { DebugModeError } from "../core/errors.js"
import type { EvidenceStore } from "../evidence/store.js"
import { validateCleanupReason, validateCompletedOutcome } from "../investigation/gates.js"
import { validateCleanupCleanCheckCommand } from "../process/command-policy.js"
import { isContained } from "../session/paths.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema
const reportSchema = schema
  .object({
    outcome: schema.enum(["completed", "unresolved", "abandoned", "escalated"]),
    rootCause: schema.string().trim().min(1).max(8_192),
    decidingEvidence: schema.array(schema.string().max(8_192)).max(100),
    hypotheses: schema
      .array(
        schema
          .object({
            id: schema.string().max(64),
            status: schema.enum(["open", "confirmed", "eliminated"]),
            statement: schema.string().max(8_192),
          })
          .strict(),
      )
      .max(4),
    fix: schema.string().trim().min(1).max(8_192),
    changedFiles: schema.array(schema.string().max(8_192)).max(200),
    verification: schema.array(schema.string().max(8_192)).max(100),
  })
  .strict()

type CleanupReason = "completed" | "unresolved" | "abandoned" | "escalated" | "cancelled"

function parseFinalReportInput(value: unknown): FinalReportInput | undefined {
  if (value === undefined) return undefined
  let candidate = value
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 262_144) {
      throw new DebugModeError("STATE_INVALID", "Serialized final report exceeds the 262144-byte limit", false, {
        action: "Omit finalReport and let debug_cleanup derive it from durable investigation state",
      })
    }
    try {
      candidate = JSON.parse(value)
    } catch {
      throw new DebugModeError("STATE_INVALID", "Serialized final report must be valid JSON", false, {
        action: "Omit finalReport and let debug_cleanup derive it from durable investigation state",
      })
    }
  }
  const parsed = FinalReportInputSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new DebugModeError("STATE_INVALID", "Final report does not match the cleanup report schema", false, {
      action: "Omit finalReport and let debug_cleanup derive it from durable investigation state",
    })
  }
  return parsed.data
}

async function deriveFinalReport(session: DebugSession, reason: CleanupReason): Promise<FinalReportInput> {
  const [state, manifest] = await Promise.all([session.investigationStore.read(), session.manifestStore.read()])
  const confirmed = state.hypotheses.filter((hypothesis) => hypothesis.status === "confirmed")
  const changedFiles = [...new Set((manifest.behavioralMutations ?? []).flatMap((mutation) => mutation.paths))].sort()
  const outcome: FinalReportInput["outcome"] = reason === "cancelled" ? "abandoned" : reason
  return {
    outcome,
    rootCause:
      confirmed.length === 0
        ? "No root cause was confirmed"
        : confirmed.map((hypothesis) => hypothesis.statement).join("; "),
    decidingEvidence: [...state.decidingEvidenceIds],
    hypotheses: state.hypotheses.map(({ id, status, statement }) => ({ id, status, statement })),
    fix:
      state.decisions.length === 0
        ? "No behavioral fix was recorded"
        : state.decisions.map((decision) => decision.summary).join("; "),
    changedFiles,
    verification: state.runs.flatMap((run) =>
      run.observation === undefined ? [] : [`${run.label}: ${run.observation}`],
    ),
  }
}

export function createCleanupTool(
  registry: SessionRegistry,
  cleanupFor: (session: DebugSession) => CleanupService,
  evidenceFor: (session: DebugSession) => EvidenceStore,
  onCleaned?: (session: DebugSession) => void,
): ToolDefinition {
  return tool({
    description:
      "Tear down every owned debug resource. Pass only reason by default; finalReport is optional and is derived from durable state, decisions, mutations, and pre/post evidence",
    args: {
      reason: schema.enum(["completed", "unresolved", "abandoned", "escalated", "cancelled"]),
      finalReport: schema.union([reportSchema, schema.string().trim().min(2).max(262_144)]).optional(),
      cleanCheck: schema
        .object({
          executable: schema.string().min(1).max(8_192),
          args: schema.array(schema.string().max(8_192)).max(256),
          cwd: schema.string().min(1).max(8_192),
          timeoutMs: schema.number().int().min(1).max(300_000),
        })
        .strict()
        .optional(),
    },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const suppliedReport = parseFinalReportInput(args.finalReport)
        const report = suppliedReport ?? (await deriveFinalReport(session, args.reason))
        validateCleanupReason(args.reason, report.outcome)
        if (args.cleanCheck !== undefined) {
          validateCleanupCleanCheckCommand(args.cleanCheck.executable, args.cleanCheck.args)
          const cleanCwd = path.resolve(args.cleanCheck.cwd)
          if (cleanCwd !== session.projectRoot && !isContained(session.projectRoot, cleanCwd)) {
            throw new DebugModeError(
              "INVALID_PHASE",
              "Cleanup cleanCheck cwd must be inside the active project",
              false,
              { action: "Use the active project root for the whole-worktree clean check" },
            )
          }
        }
        const finalReport = await validateCompletedOutcome(session, evidenceFor(session), report)
        const result = await cleanupFor(session).run({
          reason: args.reason,
          finalReport,
          ...(args.cleanCheck === undefined ? {} : { cleanCheck: args.cleanCheck }),
        })
        registry.forgetTrusted(context.sessionID)
        onCleaned?.(session)
        const sanitize = (location: string | undefined) => {
          if (location === undefined) return undefined
          const absolute = path.resolve(location)
          return absolute === session.projectRoot || isContained(session.projectRoot, absolute)
            ? path.relative(session.projectRoot, absolute) || "."
            : undefined
        }
        const resources = {
          ...result.resources,
          probes: result.resources.probes.map((value) => ({ ...value, location: sanitize(value.location) })),
          permissions: result.resources.permissions.map((value) => ({ ...value, location: sanitize(value.location) })),
          files: result.resources.files.map((value) => ({ ...value, location: sanitize(value.location) })),
        }
        return jsonSuccess({
          ...result,
          resources,
          remainingArtifacts: result.remainingArtifacts.map(sanitize).filter(Boolean),
        })
      } catch (error) {
        return jsonFailure(error, "Cleanup failed")
      }
    },
  })
}
