import path from "node:path"
import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import type { ProbeRegistry } from "../probes/registry.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import { jsonFailure, jsonSuccess } from "./common.js"

const schema = tool.schema

export function createProbePrepareTool(
  registry: SessionRegistry,
  probesFor: (session: DebugSession) => ProbeRegistry,
): ToolDefinition {
  return tool({
    description: "Prepare one safe owned JavaScript or TypeScript probe",
    args: {
      runId: schema.string().regex(/^[A-Za-z0-9_-]+$/),
      hypothesisId: schema.string().regex(/^[A-Za-z0-9_-]+$/),
      sourceFile: schema.string().min(1).max(8_192),
      sourceLine: schema.number().int().positive(),
      sourceColumn: schema.number().int().positive().optional(),
      message: schema.string().min(1).max(8_192),
      captures: schema
        .array(
          schema.object({ label: schema.string().min(1).max(128), path: schema.string().min(1).max(512) }).strict(),
        )
        .max(20),
      transport: schema.enum(["process", "http-web", "extension-background", "extension-content"]),
      sampling: schema.union([
        schema.object({ mode: schema.literal("every"), n: schema.number().int().min(1).max(10_000) }).strict(),
        schema
          .object({ mode: schema.literal("aggregate"), windowMs: schema.number().int().min(100).max(60_000) })
          .strict(),
      ]),
    },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const { sourceColumn, ...required } = args
        const probe = await probesFor(session).plan({
          ...required,
          ...(sourceColumn === undefined ? {} : { sourceColumn }),
        })
        await registry.touch(context.sessionID)
        return jsonSuccess({
          probeId: probe.id,
          markerBlock: probe.markerBlock,
          source: path.relative(session.projectRoot, probe.sourceFile),
          line: probe.sourceLine,
        })
      } catch (error) {
        return jsonFailure(error, "Probe preparation failed")
      }
    },
  })
}

export function createProbeRegisterTool(
  registry: SessionRegistry,
  probesFor: (session: DebugSession) => ProbeRegistry,
): ToolDefinition {
  return tool({
    description: "Verify and register an exact owned probe marker",
    args: { probeId: schema.string().regex(/^[A-Za-z0-9_-]+$/) },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const probe = await probesFor(session).register(args.probeId)
        await registry.touch(context.sessionID)
        return jsonSuccess({ probeId: probe.id, status: probe.status, validationStatus: probe.validationStatus })
      } catch (error) {
        return jsonFailure(error, "Probe registration failed")
      }
    },
  })
}
