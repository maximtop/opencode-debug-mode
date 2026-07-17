import path from "node:path"
import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import { validateInstrumentationAuthorization } from "../investigation/gates.js"
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
      helperSourceFile: schema
        .string()
        .min(1)
        .max(8_192)
        .optional()
        .describe("Only for extension-content: the loaded background module that owns the transport listener import"),
      sourceLine: schema
        .number()
        .int()
        .positive()
        .describe("The first untouched original line after the probe; the marker is inserted immediately before it"),
      sourceColumn: schema
        .number()
        .int()
        .positive()
        .optional()
        .describe("Diagnostic metadata only; marker placement is always before sourceLine"),
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
        await validateInstrumentationAuthorization(session, args.runId, args.transport)
        const { sourceColumn, helperSourceFile, ...required } = args
        const probe = await probesFor(session).plan({
          ...required,
          ...(sourceColumn === undefined ? {} : { sourceColumn }),
          ...(helperSourceFile === undefined ? {} : { helperSourceFile }),
        })
        await registry.touch(context.sessionID)
        return jsonSuccess({
          probeId: probe.id,
          markerBlock: probe.markerBlock,
          source: path.relative(session.projectRoot, probe.sourceFile),
          line: probe.sourceLine,
          sourceLineText: probe.sourceLineText,
          sourceContext: probe.sourceContext,
          markerEdit: probe.markerEdit,
          ...(probe.helperImportBlock === undefined
            ? {}
            : {
                helperImportBlock: probe.helperImportBlock,
                helperImportSource: path.relative(session.projectRoot, probe.helperSourceFile ?? probe.sourceFile),
              }),
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
        await validateInstrumentationAuthorization(session)
        const probe = await probesFor(session).register(args.probeId)
        await registry.touch(context.sessionID)
        return jsonSuccess({ probeId: probe.id, status: probe.status, validationStatus: probe.validationStatus })
      } catch (error) {
        return jsonFailure(error, "Probe registration failed")
      }
    },
  })
}

export function createProbeRemoveTool(
  registry: SessionRegistry,
  probesFor: (session: DebugSession) => ProbeRegistry,
): ToolDefinition {
  return tool({
    description:
      "Remove one exact owned probe marker and its companion helper import; safe in any lifecycle phase and preserves the probe's historical validation",
    args: { probeId: schema.string().regex(/^[A-Za-z0-9_-]+$/) },
    execute: async (args, context) => {
      try {
        const session = await registry.requireOwned(context.sessionID)
        const probe = await probesFor(session).remove(args.probeId)
        await registry.touch(context.sessionID)
        return jsonSuccess({ probeId: probe.id, status: probe.status, validationStatus: probe.validationStatus })
      } catch (error) {
        return jsonFailure(error, "Probe removal failed")
      }
    },
  })
}
