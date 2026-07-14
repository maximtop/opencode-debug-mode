import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import type { InvestigationState } from "../investigation/schema.js"
import type { SessionRegistry } from "../session/registry.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema

export function createStateReadTool(registry: SessionRegistry): ToolDefinition {
  return tool({
    description: "Read and reconcile the durable investigation checkpoint",
    args: {},
    execute: async (_args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const result = await session.investigationStore.readRecovery()
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        return jsonSuccess({ state: result.state, recoveryWarnings: result.warnings })
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

export function createStateCheckpointTool(registry: SessionRegistry): ToolDefinition {
  return tool({
    description: "Atomically replace the durable investigation checkpoint",
    args: { expectedRevision: schema.number().int().nonnegative(), state: schema.unknown() },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const result = await session.investigationStore.checkpoint(
          args.expectedRevision,
          args.state as InvestigationState,
        )
        await registry.touch(context.sessionID)
        return jsonSuccess({ revision: result.state.revision, bytes: result.bytes })
      } catch (error) {
        return jsonFailure(error, "Checkpoint update failed")
      }
    },
  })
}
