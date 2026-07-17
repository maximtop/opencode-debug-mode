import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import { LIMITS } from "../core/constants.js"
import type { PackageDiagnostics } from "../core/package-metadata.js"
import type { SessionRegistry } from "../session/registry.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema

export function createSessionStartTool(registry: SessionRegistry, diagnostics?: PackageDiagnostics): ToolDefinition {
  return tool({
    description: "MANDATORY FIRST LIFECYCLE TOOL: start an isolated runtime-debugging session before file mutations",
    args: {
      keepArtifacts: schema.boolean().default(false),
      retentionDestination: schema.string().min(1).max(8_192).optional(),
    },
    execute: async (args, context) => {
      try {
        const session = await registry.start(
          context.sessionID,
          { directory: context.directory, worktree: context.worktree },
          {
            keepArtifacts: args.keepArtifacts,
            ...(args.retentionDestination === undefined ? {} : { retentionDestination: args.retentionDestination }),
          },
        )
        return jsonSuccess({
          sessionId: session.publicId,
          status: "active",
          limits: LIMITS,
          capabilities: { process: true, web: true, extension: true, languages: ["javascript", "typescript"] },
          ...(diagnostics === undefined ? {} : { plugin: diagnostics }),
        })
      } catch (error) {
        return jsonFailure(error, "Debug session could not be started")
      }
    },
  })
}

export function createSessionStatusTool(registry: SessionRegistry, diagnostics?: PackageDiagnostics): ToolDefinition {
  return tool({
    description: "Read the public status of the active debug session",
    args: {},
    execute: async (_args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const manifest = await session.manifestStore.read()
        const state = await session.investigationStore.readRecovery()
        return jsonSuccess({
          sessionId: session.publicId,
          status: manifest.status,
          phase: state.ok ? state.state.phase : "recovery-required",
          revision: state.ok ? state.state.revision : manifest.revision,
          collector:
            manifest.collector === null
              ? null
              : { status: manifest.collector.status, host: manifest.collector.host, port: manifest.collector.port },
          processCount: manifest.processes.length,
          probeCount: manifest.probes.length,
          counters: manifest.counters,
          limits: LIMITS,
          ...(diagnostics === undefined ? {} : { plugin: diagnostics }),
        })
      } catch (error) {
        return jsonFailure(error, "Debug session status is unavailable")
      }
    },
  })
}
