import path from "node:path"
import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import type { CleanupService } from "../cleanup/service.js"
import type { FinalReportInput } from "../cleanup/types.js"
import { isContained } from "../session/paths.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema
const reportSchema = schema
  .object({
    outcome: schema.enum(["completed", "unresolved", "abandoned", "escalated"]),
    rootCause: schema.string().max(8_192),
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
    fix: schema.string().max(8_192),
    changedFiles: schema.array(schema.string().max(8_192)).max(200),
    verification: schema.array(schema.string().max(8_192)).max(100),
  })
  .strict()

export function createCleanupTool(
  registry: SessionRegistry,
  cleanupFor: (session: DebugSession) => CleanupService,
): ToolDefinition {
  return tool({
    description: "Tear down every owned debug resource and optionally retain a sanitized report",
    args: {
      reason: schema.enum(["completed", "unresolved", "abandoned", "escalated", "cancelled"]),
      finalReport: reportSchema,
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
        const result = await cleanupFor(session).run({
          reason: args.reason,
          finalReport: args.finalReport as FinalReportInput,
          ...(args.cleanCheck === undefined ? {} : { cleanCheck: args.cleanCheck }),
        })
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
