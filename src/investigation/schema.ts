import { z } from "zod"
import { LIMITS, STATE_SCHEMA_VERSION } from "../core/constants.js"
import { IsoTimestampSchema, OpaqueIdSchema, RunLabelSchema } from "../core/schemas.js"

const Text = z.string().max(LIMITS.scalarBytes)
const NonEmptyText = z.string().trim().min(1).max(LIMITS.scalarBytes)
const TextList = (maximum: number) => z.array(Text).max(maximum)
const EvidenceIds = z.array(OpaqueIdSchema).max(500)

export const HypothesisSchema = z
  .object({
    id: OpaqueIdSchema,
    rank: z.number().int().min(1).max(4),
    statement: NonEmptyText,
    confirmationSignals: z.array(NonEmptyText).min(1).max(20),
    eliminationSignals: z.array(NonEmptyText).min(1).max(20),
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
    issueReproduced: z.boolean().nullable().optional(),
    observationSource: z.enum(["deterministic", "human"]).optional(),
    observation: Text.optional(),
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

const ReproductionSchema = z
  .object({
    method: Text.describe(
      "The exact pre-fix procedure that exercises the reported runtime boundary; preserve the developer-provided interactive steps instead of replacing them with an approximation",
    ),
    requiresUser: z
      .boolean()
      .describe(
        "At the first checkpoint, set true whenever the provided procedure requires a person to interact with a browser, extension, device, or other external state. Set false only when an existing command that can be supervised by debug_process_capture already reproduces the exact same runtime symptom across the same relevant boundary. A local Node, fetch, mock, fixture, or test approximation does not justify false. After the first baseline run starts, true can never become false; a mistaken false may become true only in a gated new hypothesis iteration after every run is terminal, before deciding evidence or a behavioral fix.",
      ),
    confirmed: z.boolean().nullable(),
  })
  .strict()
  .describe(
    "The authoritative reproduction boundary selected at the first scope checkpoint; after the first baseline run starts only a gated false-to-true recovery at a safe new hypothesis iteration is allowed",
  )

export const InvestigationStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    updatedAt: IsoTimestampSchema,
    problemSummary: Text,
    expectedBehavior: Text,
    actualBehavior: Text,
    runtimeContext: z.object({ kind: z.enum(["cli", "web", "extension", "other"]), target: Text }).strict(),
    reproduction: ReproductionSchema,
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
