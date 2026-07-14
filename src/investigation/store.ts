import { readFile, stat } from "node:fs/promises"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { LIMITS, STATE_SCHEMA_VERSION } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import { atomicWriteJson } from "../session/atomic-json.js"
import { type InvestigationState, InvestigationStateSchema } from "./schema.js"

export type StateRecoveryResult =
  | { ok: true; state: InvestigationState; warnings: string[] }
  | { ok: false; error: { code: "STATE_MISSING" | "STATE_INVALID" | "STATE_VERSION_UNSUPPORTED"; message: string } }

export function initialInvestigationState(now: string): InvestigationState {
  return InvestigationStateSchema.parse({
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    problemSummary: "",
    expectedBehavior: "",
    actualBehavior: "",
    runtimeContext: { kind: "other", target: "" },
    reproduction: { method: "", requiresUser: false, confirmed: null },
    successCriteria: [],
    phase: "intake",
    loopIteration: 0,
    singleCauseEvidenceRef: null,
    hypotheses: [],
    completedChecks: [],
    runs: [],
    probeRefs: [],
    decidingEvidenceIds: [],
    developerConfirmations: [],
    decisions: [],
    nextAction: "",
    instrumentedFiles: [],
    fixedFiles: [],
    cleanup: { status: "not_started", completedResources: [] },
  })
}

export class InvestigationStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly filename: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(state: InvestigationState): Promise<number> {
    const parsed = this.validate(state)
    try {
      await stat(this.filename)
      throw new DebugModeError("STATE_INVALID", "Investigation checkpoint already exists")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return this.write(parsed)
  }

  async read(): Promise<InvestigationState> {
    const recovery = await this.readRecovery()
    if (!recovery.ok) throw new DebugModeError(recovery.error.code, recovery.error.message)
    return recovery.state
  }

  async readRecovery(): Promise<StateRecoveryResult> {
    let raw: string
    try {
      const info = await stat(this.filename)
      if (info.size > LIMITS.checkpointBytes) {
        return { ok: false, error: { code: "STATE_INVALID", message: "Checkpoint exceeds its byte limit" } }
      }
      raw = await readFile(this.filename, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, error: { code: "STATE_MISSING", message: "Investigation checkpoint is missing" } }
      }
      return { ok: false, error: { code: "STATE_INVALID", message: "Investigation checkpoint could not be read" } }
    }

    try {
      const value: unknown = JSON.parse(raw)
      if (
        typeof value === "object" &&
        value !== null &&
        "schemaVersion" in value &&
        (value as { schemaVersion?: unknown }).schemaVersion !== STATE_SCHEMA_VERSION
      ) {
        return {
          ok: false,
          error: { code: "STATE_VERSION_UNSUPPORTED", message: "Investigation checkpoint version is unsupported" },
        }
      }
      return { ok: true, state: InvestigationStateSchema.parse(value), warnings: [] }
    } catch {
      return { ok: false, error: { code: "STATE_INVALID", message: "Investigation checkpoint is invalid" } }
    }
  }

  async checkpoint(
    expectedRevision: number,
    state: InvestigationState,
  ): Promise<{ state: InvestigationState; bytes: number }> {
    return this.exclusive(async () => {
      const current = await this.read()
      if (current.revision !== expectedRevision) {
        throw new DebugModeError("STALE_REVISION", `Expected revision ${expectedRevision}; found ${current.revision}`)
      }
      const candidate = this.validate({
        ...(state as unknown as Record<string, unknown>),
        revision: expectedRevision + 1,
        updatedAt: this.clock.now().toISOString(),
      })
      const bytes = await this.write(candidate)
      return { state: candidate, bytes }
    })
  }

  private validate(value: unknown): InvestigationState {
    const result = InvestigationStateSchema.safeParse(value)
    if (!result.success) throw new DebugModeError("STATE_INVALID", "Investigation checkpoint failed schema validation")
    const bytes = Buffer.byteLength(`${JSON.stringify(result.data)}\n`)
    if (bytes > LIMITS.checkpointBytes)
      throw new DebugModeError("STATE_TOO_LARGE", "Investigation checkpoint is too large")
    return result.data
  }

  private async write(state: InvestigationState): Promise<number> {
    try {
      return await atomicWriteJson(this.filename, state, LIMITS.checkpointBytes)
    } catch (error) {
      if (error instanceof RangeError)
        throw new DebugModeError("STATE_TOO_LARGE", "Investigation checkpoint is too large")
      throw error
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
