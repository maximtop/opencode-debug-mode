import { z } from "zod"
import { LIMITS, MANIFEST_SCHEMA_VERSION, PACKAGE_ID } from "../core/constants.js"
import { HexSha256Schema, IsoTimestampSchema, OpaqueIdSchema, RunLabelSchema } from "../core/schemas.js"

export const EvidenceCountersSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    sampled: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
  })
  .strict()

export const CollectorManifestSchema = z
  .object({
    id: OpaqueIdSchema,
    host: z.enum(["127.0.0.1", "::1"]),
    port: z.number().int().min(1).max(65_535),
    status: z.enum(["starting", "ready", "draining", "stopped", "failed"]),
    startedAt: IsoTimestampSchema,
    stoppedAt: IsoTimestampSchema.optional(),
  })
  .strict()

export const RunManifestSchema = z
  .object({
    id: OpaqueIdSchema,
    label: RunLabelSchema,
    reproduction: z.string().max(LIMITS.scalarBytes),
    status: z.enum(["planned", "running", "waiting", "completed", "failed", "timed_out", "cancelled"]),
    createdAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict()

export const ProcessManifestSchema = z
  .object({
    id: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    commandSummary: z.string().max(LIMITS.scalarBytes),
    supervisorPid: z.number().int().positive().optional(),
    targetPid: z.number().int().positive().optional(),
    ownerNonceHash: HexSha256Schema,
    status: z.enum(["starting", "running", "exited", "timed_out", "cancelled", "terminated", "failed"]),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().max(64).nullable().optional(),
  })
  .strict()

export const ProbeManifestSchema = z
  .object({
    id: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    hypothesisId: OpaqueIdSchema,
    sourceFile: z.string().min(1),
    sourceLine: z.number().int().positive(),
    sourceColumn: z.number().int().positive().optional(),
    message: z.string().min(1).max(LIMITS.scalarBytes),
    transport: z.enum(["process", "http-web", "extension-background", "extension-content"]),
    captures: z
      .array(z.object({ label: z.string().min(1).max(128), path: z.string().min(1).max(512) }).strict())
      .max(20),
    sampling: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("every"), n: z.number().int().min(1).max(10_000) }).strict(),
      z.object({ mode: z.literal("aggregate"), windowMs: z.number().int().min(100).max(60_000) }).strict(),
    ]),
    status: z.enum(["planned", "registered", "validated", "active", "removed", "ambiguous"]),
    validationStatus: z.enum(["pending", "validated", "failed"]),
    markerStart: z.string().min(1),
    markerEnd: z.string().min(1),
    expectedBlock: z.string().optional(),
    expectedHash: HexSha256Schema.optional(),
  })
  .strict()

export const OwnedFileManifestSchema = z
  .object({
    path: z.string().min(1),
    sha256: HexSha256Schema,
    bytes: z.number().int().nonnegative(),
    kind: z.enum(["transport-helper", "temporary"]),
  })
  .strict()

export const PermissionChangeSchema = z
  .object({
    manifestPath: z.string().min(1),
    property: z.enum(["permissions", "host_permissions"]),
    matchPattern: z.string().min(1),
    addedBySession: z.boolean(),
  })
  .strict()

export const CleanupProgressSchema = z
  .object({
    status: z.enum(["not_started", "running", "complete", "partial"]),
    completedResources: z.array(z.string().max(256)).max(10_000),
  })
  .strict()

export const ManifestSchema = z
  .object({
    package: z.literal(PACKAGE_ID),
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    sessionId: OpaqueIdSchema,
    trustedSessionHash: HexSha256Schema,
    projectRoot: z.string().min(1),
    sessionDir: z.string().min(1),
    status: z.enum(["active", "cleaning", "cleaned", "partial"]),
    createdAt: IsoTimestampSchema,
    lastActivityAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    waitingForReproduction: z.boolean(),
    keepArtifacts: z.boolean(),
    retentionDestination: z.string().min(1).optional(),
    collector: CollectorManifestSchema.nullable(),
    runs: z.array(RunManifestSchema),
    processes: z.array(ProcessManifestSchema),
    probes: z.array(ProbeManifestSchema),
    ownedFiles: z.array(OwnedFileManifestSchema),
    permissionChanges: z.array(PermissionChangeSchema),
    counters: EvidenceCountersSchema,
    cleanup: CleanupProgressSchema,
  })
  .strict()

export type CleanupManifest = z.infer<typeof ManifestSchema>
export type ManifestProbe = z.infer<typeof ProbeManifestSchema>
export type ManifestRun = z.infer<typeof RunManifestSchema>
export type EvidenceCounters = z.infer<typeof EvidenceCountersSchema>
