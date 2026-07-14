import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import type { EvidenceStore } from "../evidence/store.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema

export function createEvidenceReadTool(
  registry: SessionRegistry,
  evidenceFor: (session: DebugSession) => EvidenceStore,
): ToolDefinition {
  return tool({
    description: "Read a bounded filtered page of sanitized local evidence",
    args: {
      runId: schema.string().optional(),
      hypothesisId: schema.string().optional(),
      probeId: schema.string().optional(),
      from: schema.string().optional(),
      to: schema.string().optional(),
      keyword: schema.string().max(8_192).optional(),
      cursor: schema.string().regex(/^\d+$/).optional(),
      limit: schema.number().int().min(1).max(100).default(100),
    },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const result = await evidenceFor(session).read({
          sessionId: session.publicId,
          limit: args.limit,
          ...(args.runId === undefined ? {} : { runId: args.runId }),
          ...(args.hypothesisId === undefined ? {} : { hypothesisId: args.hypothesisId }),
          ...(args.probeId === undefined ? {} : { probeId: args.probeId }),
          ...(args.from === undefined ? {} : { from: args.from }),
          ...(args.to === undefined ? {} : { to: args.to }),
          ...(args.keyword === undefined ? {} : { keyword: args.keyword }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        })
        await registry.touch(context.sessionID)
        return jsonSuccess(result)
      } catch (error) {
        return jsonFailure(error, "Evidence is unavailable")
      }
    },
  })
}
