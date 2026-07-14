import { z } from "zod"

export const ResourceCleanupResultSchema = z
  .object({
    status: z.enum(["success", "already-clean", "skipped", "failed"]),
    reason: z.string().max(8_192).optional(),
    location: z.string().max(8_192).optional(),
  })
  .strict()

export const CleanupResultSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    reason: z.string().max(256),
    resources: z
      .object({
        collector: ResourceCleanupResultSchema,
        processes: z.array(ResourceCleanupResultSchema),
        probes: z.array(ResourceCleanupResultSchema),
        permissions: z.array(ResourceCleanupResultSchema),
        files: z.array(ResourceCleanupResultSchema),
        secret: ResourceCleanupResultSchema,
        sessionDirectory: ResourceCleanupResultSchema,
      })
      .strict(),
    remainingArtifacts: z.array(z.string().max(8_192)),
    durationMs: z.number().nonnegative(),
    cleanCheck: z
      .object({
        command: z.string().max(8_192),
        exitCode: z.number().int().nullable(),
        timedOut: z.boolean(),
        durationMs: z.number().nonnegative(),
      })
      .strict()
      .optional(),
    retainedArtifactLocation: z.string().max(8_192).optional(),
  })
  .strict()

export const FinalReportInputSchema = z
  .object({
    outcome: z.enum(["completed", "unresolved", "abandoned", "escalated"]),
    rootCause: z.string().max(8_192),
    decidingEvidence: z.array(z.string().max(8_192)).max(100),
    hypotheses: z
      .array(
        z
          .object({
            id: z.string().max(64),
            status: z.enum(["open", "confirmed", "eliminated"]),
            statement: z.string().max(8_192),
          })
          .strict(),
      )
      .max(4),
    fix: z.string().max(8_192),
    changedFiles: z.array(z.string().max(8_192)).max(200),
    verification: z.array(z.string().max(8_192)).max(100),
  })
  .strict()

export const FinalReportSchema = FinalReportInputSchema.extend({
  cleanup: CleanupResultSchema,
  retainedArtifactLocation: z.string().max(8_192).optional(),
}).strict()

export type CleanupResult = z.infer<typeof CleanupResultSchema>
export type FinalReportInput = z.infer<typeof FinalReportInputSchema>
export type FinalReport = z.infer<typeof FinalReportSchema>
