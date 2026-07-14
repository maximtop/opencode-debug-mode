import path from "node:path"
import { type ToolContext, type ToolDefinition, tool } from "@opencode-ai/plugin"
import { DebugModeError } from "../core/errors.js"
import { failure, success } from "../core/result.js"
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

const ProcessArgs = {
  approvalClass: ApprovalClassSchema,
  purpose: schema.enum(["instrumentation-check", "reproduction", "verification"]),
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

function serializeResult(result: ProcessCaptureResult): string {
  return JSON.stringify(success(result))
}

export function createProcessCaptureTool(dependencies: RunToolDependencies): ToolDefinition {
  return tool({
    description: "Run one supervised command and capture bounded runtime evidence",
    args: ProcessArgs,
    execute: async (args, context) => {
      try {
        const session = await dependencies.registry.requireOwned(context.sessionID)
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
          signal: context.abort,
        })
        if (args.purpose === "instrumentation-check" && result.exitCode === 0) await probes.validate(args.probeIds)
        return serializeResult(result)
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
    description: "Start a correlated pre-fix or post-fix reproduction run",
    args: {
      label: schema.enum(["pre-fix", "post-fix"]),
      reproduction: schema.string().min(1).max(8_192),
      waitingForUser: schema.boolean().default(false),
    },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const run = await runFor(session).start(args)
        await registry.touch(context.sessionID)
        return JSON.stringify(success({ runId: run.id, status: run.status, label: run.label }))
      } catch (error) {
        if (error instanceof DebugModeError) return JSON.stringify(failure(error.code, error.message, error.retryable))
        return JSON.stringify(failure("INTERNAL_ERROR", "Run could not be started", false))
      }
    },
  })
}
