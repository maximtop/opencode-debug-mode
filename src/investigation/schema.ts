import { z } from "zod"
import { LIMITS, STATE_SCHEMA_VERSION } from "../core/constants.js"
import { IsoTimestampSchema, OpaqueIdSchema, RunLabelSchema } from "../core/schemas.js"

const Text = z.string().max(LIMITS.scalarBytes)
const TextList = (maximum: number) => z.array(Text).max(maximum)
const EvidenceIds = z.array(OpaqueIdSchema).max(500)

export const HypothesisSchema = z
  .object({
    id: OpaqueIdSchema,
    rank: z.number().int().min(1).max(4),
    statement: Text,
    confirmationSignals: TextList(20),
    eliminationSignals: TextList(20),
    status: z.enum(["open", "confirmed", "eliminated"]),
    evidenceRefs: EvidenceIds,
    invalidatedBy: Text.optional(),
  })
  .strict()

export const CompletedCheckSchema = z
  .object({
    id: OpaqueIdSchema,
    summary: Text,
    interpretation: Text,
    conclusive: z.boolean(),
    evidenceRefs: EvidenceIds,
    completedAt: IsoTimestampSchema,
    invalidatedBy: Text.optional(),
  })
  .strict()

export const RunReferenceSchema = z
  .object({
    id: OpaqueIdSchema,
    label: RunLabelSchema,
    status: z.enum(["planned", "running", "waiting", "completed", "failed", "timed_out", "cancelled"]),
    evidenceRefs: EvidenceIds,
  })
  .strict()

export const ProbeReferenceSchema = z
  .object({
    id: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    hypothesisId: OpaqueIdSchema,
    sourceFile: Text,
    status: z.enum(["planned", "registered", "validated", "active", "removed", "ambiguous"]),
  })
  .strict()

export const DeveloperConfirmationSchema = z
  .object({ id: OpaqueIdSchema, statement: Text, confirmedAt: IsoTimestampSchema })
  .strict()

export const DecisionSchema = z
  .object({ id: OpaqueIdSchema, summary: Text, evidenceRefs: EvidenceIds, decidedAt: IsoTimestampSchema })
  .strict()

export const InvestigationStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    updatedAt: IsoTimestampSchema,
    problemSummary: Text,
    expectedBehavior: Text,
    actualBehavior: Text,
    runtimeContext: z.object({ kind: z.enum(["cli", "web", "extension", "other"]), target: Text }).strict(),
    reproduction: z.object({ method: Text, requiresUser: z.boolean(), confirmed: z.boolean().nullable() }).strict(),
    successCriteria: TextList(50),
    phase: z.enum([
      "intake",
      "hypotheses",
      "baseline",
      "instrumenting",
      "waiting_for_reproduction",
      "analyzing",
      "fixing",
      "verifying",
      "cleaning",
      "completed",
      "abandoned",
      "escalated",
    ]),
    loopIteration: z.number().int().min(0).max(3),
    singleCauseEvidenceRef: OpaqueIdSchema.nullable(),
    hypotheses: z.array(HypothesisSchema).max(4),
    completedChecks: z.array(CompletedCheckSchema).max(100),
    runs: z.array(RunReferenceSchema).max(20),
    probeRefs: z.array(ProbeReferenceSchema).max(100),
    decidingEvidenceIds: EvidenceIds,
    developerConfirmations: z.array(DeveloperConfirmationSchema).max(100),
    decisions: z.array(DecisionSchema).max(100),
    nextAction: Text,
    instrumentedFiles: TextList(200),
    fixedFiles: TextList(200),
    cleanup: z
      .object({
        status: z.enum(["not_started", "running", "complete", "partial"]),
        completedResources: TextList(1_000),
      })
      .strict(),
  })
  .strict()

export type InvestigationState = z.infer<typeof InvestigationStateSchema>
