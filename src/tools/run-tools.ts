import { randomBytes } from "node:crypto"
import path from "node:path"
import { type ToolContext, type ToolDefinition, tool } from "@opencode-ai/plugin"
import { EVENT_SCHEMA_VERSION } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import { failure, success } from "../core/result.js"
import type { EvidenceStore } from "../evidence/store.js"
import { validateProcessCapture, validateRunFinish, validateRunStart } from "../investigation/gates.js"
import type { ProbeRegistry } from "../probes/registry.js"
import type { ProcessCaptureResult, ProcessService } from "../process/service.js"
import type { RunService } from "../run/service.js"
import { isContained } from "../session/paths.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"

const schema = tool.schema

const ApprovalClassSchema = schema.enum([
  "local-deterministic",
  "credentials",
  "device",
  "external-state",
  "materially-different",
])

const OutcomePredicateArgumentSchema = schema.object({
  kind: schema.literal("exit-code"),
  operator: schema.enum(["equals", "not-equals"]),
  value: schema.number().int().min(0).max(255),
})

const ProcessArgs = {
  approvalClass: ApprovalClassSchema,
  purpose: schema.enum(["instrumentation-check", "reproduction", "verification"]),
  outcomePredicate: OutcomePredicateArgumentSchema.optional(),
  probeIds: schema.array(schema.string().regex(/^[A-Za-z0-9_-]+$/)).max(100),
  executable: schema.string().min(1).max(8_192),
  args: schema.array(schema.string().max(8_192)).max(256),
  cwd: schema.string().min(1).max(8_192),
  env: schema
    .record(schema.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), schema.string().max(8_192))
    .refine((value) => Object.keys(value).length <= 256),
  runId: schema.string().regex(/^[A-Za-z0-9_-]+$/),
  timeoutMs: schema.number().int().min(1).max(300_000),
}

export interface RunToolDependencies {
  registry: Pick<SessionRegistry, "requireOwned">
  processFor(session: DebugSession): Pick<ProcessService, "capture">
  probesFor(session: DebugSession): Pick<ProbeRegistry, "validate" | "requireValidatedForRun">
  capturePolicy?: typeof validateProcessCapture
}

async function requestApproval(
  context: ToolContext,
  permission: string,
  executable: string,
  args: string[],
): Promise<void> {
  try {
    await context.ask({
      permission,
      patterns: [[path.basename(executable), ...args.map((value) => path.basename(value))].join(" ").slice(0, 512)],
      always: [],
      metadata: { executable: path.basename(executable), argumentCount: args.length },
    })
  } catch {
    throw new DebugModeError("COMMAND_REQUIRES_APPROVAL", "The requested process command was not approved")
  }
}

function serializeResult(result: ProcessCaptureResult, validatedProbeIds: readonly string[] = []): string {
  return JSON.stringify(
    success({
      ...result,
      ...(validatedProbeIds.length === 0 ? {} : { validatedProbeIds }),
    }),
  )
}

export function createProcessCaptureTool(dependencies: RunToolDependencies): ToolDefinition {
  return tool({
    description:
      "Run one supervised command and capture bounded runtime evidence; always pass the executable separately from args; omit outcomePredicate for instrumentation-check and provide it for reproduction or verification",
    args: ProcessArgs,
    execute: async (args, context) => {
      try {
        if (typeof args.executable !== "string" || args.executable.trim().length === 0) {
          throw new DebugModeError("PROCESS_START_FAILED", "Process capture requires the executable field", true, {
            action:
              'Retry with executable set separately, for example executable: "node" with args: ["script.mjs"], or executable: "/bin/sh" with args: ["-c", "..."]',
          })
        }
        const session = await dependencies.registry.requireOwned(context.sessionID)
        await (dependencies.capturePolicy ?? validateProcessCapture)({
          session,
          runId: args.runId,
          purpose: args.purpose,
          probeIds: args.probeIds,
          executable: args.executable,
          args: args.args,
          env: args.env,
          cwd: args.cwd,
          ...(args.outcomePredicate === undefined ? {} : { outcomePredicate: args.outcomePredicate }),
        })
        if (args.approvalClass !== "local-deterministic") {
          await requestApproval(context, "debug_process_external", args.executable, args.args)
        }
        const resolvedCwd = path.resolve(args.cwd)
        const worktree = path.resolve(context.worktree)
        if (resolvedCwd !== worktree && !isContained(worktree, resolvedCwd)) {
          await requestApproval(context, "external_directory", args.executable, args.args)
        }
        const probes = dependencies.probesFor(session)
        if (args.purpose === "reproduction") await probes.requireValidatedForRun(args.runId)
        const result = await dependencies.processFor(session).capture({
          runId: args.runId,
          executable: args.executable,
          args: args.args,
          cwd: resolvedCwd,
          env: args.env,
          timeoutMs: args.timeoutMs,
          probeIds: args.probeIds,
          purpose: args.purpose,
          ...(args.outcomePredicate === undefined ? {} : { outcomePredicate: args.outcomePredicate }),
          signal: context.abort,
        })
        let validatedProbeIds: string[] = []
        if (args.purpose === "instrumentation-check" && result.exitCode === 0) {
          await probes.validate(args.probeIds)
          validatedProbeIds = [...args.probeIds]
        }
        return serializeResult(result, validatedProbeIds)
      } catch (error) {
        if (error instanceof DebugModeError) {
          return JSON.stringify(
            failure(error.code, error.message, error.retryable, {
              ...(error.action === undefined ? {} : { action: error.action }),
              ...(error.details === undefined ? {} : { details: error.details }),
            }),
          )
        }
        return JSON.stringify(failure("INTERNAL_ERROR", "Process capture failed", false))
      }
    },
  })
}

export function createRunStartTool(
  registry: SessionRegistry,
  runFor: (session: DebugSession) => RunService,
): ToolDefinition {
  return tool({
    description: "MANDATORY: start a correlated pre-fix baseline or post-fix same-path verification run",
    args: {
      label: schema.enum(["pre-fix", "post-fix"]),
      reproduction: schema.string().min(1).max(8_192),
      waitingForUser: schema.boolean().default(false),
    },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const canonicalArgs = await validateRunStart(session, args)
        const canonicalized =
          args.waitingForUser !== canonicalArgs.waitingForUser || args.reproduction !== canonicalArgs.reproduction
        const run = await runFor(session).start(canonicalArgs)
        await registry.touch(context.sessionID)
        return JSON.stringify(
          success(
            { runId: run.id, status: run.status, label: run.label },
            canonicalized
              ? [
                  {
                    code: "RUN_INPUT_CANONICALIZED",
                    message: "Run reproduction and waiting mode were derived from the durable checkpointed boundary",
                  },
                ]
              : [],
          ),
        )
      } catch (error) {
        if (error instanceof DebugModeError) {
          return JSON.stringify(
            failure(error.code, error.message, error.retryable, {
              ...(error.action === undefined ? {} : { action: error.action }),
              ...(error.details === undefined ? {} : { details: error.details }),
            }),
          )
        }
        return JSON.stringify(failure("INTERNAL_ERROR", "Run could not be started", false))
      }
    },
  })
}

export function createRunFinishTool(
  registry: SessionRegistry,
  runFor: (session: DebugSession) => RunService,
  evidenceFor: (session: DebugSession) => EvidenceStore,
): ToolDefinition {
  return tool({
    description:
      "MANDATORY: finish a pre-fix or post-fix run with the observed issue outcome and persist that observation as evidence",
    args: {
      runId: schema.string().regex(/^[A-Za-z0-9_-]+$/),
      status: schema.enum(["completed", "failed", "timed_out", "cancelled"]),
      issueReproduced: schema.boolean().nullable(),
      observationSource: schema.enum(["deterministic", "human"]),
      observation: schema.string().min(1).max(8_192),
    },
    execute: async (args, context) => {
      try {
        if (args.status === "completed" && args.issueReproduced === null) {
          throw new DebugModeError("INVALID_PHASE", "A completed run requires an observed issueReproduced result")
        }
        const session = await registry.requireOwned(context.sessionID)
        const runs = runFor(session)
        const run = await runs.require(args.runId)
        if (["completed", "failed", "timed_out", "cancelled"].includes(run.status)) {
          throw new DebugModeError("INVALID_PHASE", "Run is already finished")
        }
        await validateRunFinish(session, evidenceFor(session), run, args)
        const appended = await evidenceFor(session).append({
          schemaVersion: EVENT_SCHEMA_VERSION,
          eventId: `event_${randomBytes(16).toString("base64url")}`,
          timestamp: new Date().toISOString(),
          sessionId: session.publicId,
          runId: run.id,
          runLabel: run.label,
          hypothesisId: "hyp_observation",
          probeId: "probe_observation",
          kind: `${args.observationSource}.observation`,
          message: args.observation,
          data: { issueReproduced: args.issueReproduced, status: args.status },
          source: { file: args.observationSource === "human" ? "human-checkpoint" : "deterministic-check", line: 1 },
        })
        if (appended.status !== "accepted" || appended.event === undefined) {
          throw new DebugModeError("EVIDENCE_UNAVAILABLE", "The run observation could not be persisted")
        }
        const completed = await runs.complete(args.runId, args.status, {
          issueReproduced: args.issueReproduced,
          observationSource: args.observationSource,
          observation: args.observation,
        })
        await registry.touch(context.sessionID)
        return JSON.stringify(
          success({
            runId: completed.id,
            status: completed.status,
            label: completed.label,
            issueReproduced: completed.issueReproduced ?? null,
            observationEvidenceId: appended.event.eventId,
          }),
        )
      } catch (error) {
        if (error instanceof DebugModeError) {
          return JSON.stringify(
            failure(error.code, error.message, error.retryable, {
              ...(error.action === undefined ? {} : { action: error.action }),
              ...(error.details === undefined ? {} : { details: error.details }),
            }),
          )
        }
        return JSON.stringify(failure("INTERNAL_ERROR", "Run could not be finished", false))
      }
    },
  })
}
