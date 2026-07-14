import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema

export interface PublicCollectorService {
  start(input: {
    runtime: "web" | "extension-background"
    transportTargetPath?: string
    extensionManifestPath?: string
  }): Promise<{
    collectorId: string
    host: "127.0.0.1" | "::1"
    port: number
    status: string
    helperImport?: string
    helperPath?: string
  }>
}

export function createCollectorStartTool(
  registry: SessionRegistry,
  collectorFor: (session: DebugSession) => PublicCollectorService,
): ToolDefinition {
  return tool({
    description: "Start the authenticated loopback evidence collector",
    args: {
      runtime: schema.enum(["web", "extension-background"]),
      transportTargetPath: schema.string().min(1).max(8_192).optional(),
      extensionManifestPath: schema.string().min(1).max(8_192).optional(),
    },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const result = await collectorFor(session).start({
          runtime: args.runtime,
          ...(args.transportTargetPath === undefined ? {} : { transportTargetPath: args.transportTargetPath }),
          ...(args.extensionManifestPath === undefined ? {} : { extensionManifestPath: args.extensionManifestPath }),
        })
        await registry.touch(context.sessionID)
        return jsonSuccess(result)
      } catch (error) {
        return jsonFailure(error, "Collector startup failed")
      }
    },
  })
}
