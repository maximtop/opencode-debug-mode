import { z } from "zod"
import { EVENT_SCHEMA_VERSION, LIMITS } from "../core/constants.js"
import { IsoTimestampSchema, OpaqueIdSchema, RunLabelSchema } from "../core/schemas.js"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export const SourceLocationSchema = z
  .object({
    file: z.string().min(1).max(LIMITS.scalarBytes),
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
  })
  .strict()

export const EventInputSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    sessionId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    runLabel: RunLabelSchema,
    hypothesisId: OpaqueIdSchema,
    probeId: OpaqueIdSchema,
    timestamp: IsoTimestampSchema,
    message: z.string().min(1).max(LIMITS.scalarBytes),
    source: SourceLocationSchema,
    data: z.unknown().optional(),
  })
  .strict()

export const SanitizationFlagSchema = z.enum(["redacted", "truncated", "cycle", "binary", "unsupported"])

export const EvidenceEventSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    eventId: OpaqueIdSchema,
    receivedAt: IsoTimestampSchema,
    timestamp: IsoTimestampSchema,
    sessionId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    runLabel: RunLabelSchema,
    hypothesisId: OpaqueIdSchema,
    probeId: OpaqueIdSchema,
    kind: z.string().min(1).max(128),
    message: z.string().min(1).max(LIMITS.scalarBytes),
    data: z.unknown(),
    source: SourceLocationSchema,
    sanitization: z
      .object({
        flags: z.array(SanitizationFlagSchema),
        droppedKeys: z.number().int().nonnegative(),
        originalBytes: z.number().int().nonnegative().optional(),
        storedBytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export type EventInput = z.infer<typeof EventInputSchema>
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>
export type SanitizationFlag = z.infer<typeof SanitizationFlagSchema>

export type EvidenceFilter = Readonly<{
  sessionId?: string
  runId?: string
  hypothesisId?: string
  probeId?: string
  from?: string
  to?: string
  keyword?: string
  cursor?: string
  limit?: number
}>
