import { createHash, randomBytes } from "node:crypto"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { DebugModeError } from "../core/errors.js"
import { RunLabelSchema } from "../core/schemas.js"
import type { CleanupManifest, ManifestRun } from "../session/types.js"
import { type OutcomePredicate, OutcomePredicateSchema, sameOutcomePredicate } from "./outcome.js"

export interface RunPersistence {
  read(): Promise<CleanupManifest>
  update(expectedRevision: number, mutate: (value: CleanupManifest) => CleanupManifest): Promise<CleanupManifest>
}

export type LeaseFactory = (kind: "process" | "waiting") => Promise<() => void> | (() => void)

function createId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("base64url")}`
}

export function reproductionFingerprint(value: string): string {
  return createHash("sha256").update(value.trim().replace(/\s+/gu, " ")).digest("hex")
}

export class RunService {
  private readonly waitingReleases = new Map<string, () => void>()

  constructor(
    private readonly persistence: RunPersistence,
    private readonly clock: Clock = systemClock,
    private readonly acquireLease?: LeaseFactory,
  ) {}

  async start(input: {
    label: "pre-fix" | "post-fix"
    reproduction: string
    waitingForUser: boolean
  }): Promise<ManifestRun> {
    const label = RunLabelSchema.parse(input.label)
    const current = await this.persistence.read()
    if (current.runs.length >= 20) throw new DebugModeError("RUN_LIMIT", "The run limit has been reached")
    const now = this.clock.now().toISOString()
    const run: ManifestRun = {
      id: createId("run_"),
      label,
      reproduction: input.reproduction.slice(0, 8_192),
      reproductionFingerprint: reproductionFingerprint(input.reproduction),
      ...(label === "post-fix" ? { behavioralRevisionAtStart: current.behavioralRevision ?? 0 } : {}),
      status: input.waitingForUser ? "waiting" : "running",
      createdAt: now,
    }
    await this.persistence.update(current.revision, (manifest) => ({
      ...manifest,
      waitingForReproduction: input.waitingForUser || manifest.waitingForReproduction,
      runs: [...manifest.runs, run],
    }))
    if (input.waitingForUser && this.acquireLease !== undefined) {
      this.waitingReleases.set(run.id, await this.acquireLease("waiting"))
    }
    return run
  }

  async require(runId: string): Promise<ManifestRun> {
    const manifest = await this.persistence.read()
    const run = manifest.runs.find((candidate) => candidate.id === runId)
    if (run === undefined) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    return run
  }

  async bindOutcomePredicate(runId: string, input: OutcomePredicate): Promise<ManifestRun> {
    const parsed = OutcomePredicateSchema.safeParse(input)
    if (!parsed.success) throw new DebugModeError("STATE_INVALID", "The deterministic outcome predicate is invalid")
    const current = await this.persistence.read()
    const index = current.runs.findIndex((candidate) => candidate.id === runId)
    if (index < 0) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    const existing = current.runs[index]
    if (existing === undefined) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    if (!["running", "waiting"].includes(existing.status)) {
      throw new DebugModeError("INVALID_PHASE", "A finished run cannot change its deterministic outcome predicate")
    }
    if (existing.outcomePredicate !== undefined && !sameOutcomePredicate(existing.outcomePredicate, parsed.data)) {
      throw new DebugModeError("INVALID_PHASE", "A run must use one deterministic outcome predicate")
    }
    if (existing.label === "post-fix") {
      const baseline = current.runs.find(
        (candidate) =>
          candidate.label === "pre-fix" &&
          candidate.status === "completed" &&
          candidate.issueReproduced === true &&
          (candidate.reproductionFingerprint ?? reproductionFingerprint(candidate.reproduction)) ===
            (existing.reproductionFingerprint ?? reproductionFingerprint(existing.reproduction)),
      )
      if (baseline?.outcomePredicate === undefined || !sameOutcomePredicate(baseline.outcomePredicate, parsed.data)) {
        throw new DebugModeError(
          "INVALID_PHASE",
          "Post-fix verification must use the same deterministic outcome predicate as the reproduced baseline",
        )
      }
    }
    if (existing.outcomePredicate !== undefined) return existing
    const updated: ManifestRun = { ...existing, outcomePredicate: parsed.data }
    await this.persistence.update(current.revision, (manifest) => ({
      ...manifest,
      runs: manifest.runs.map((candidate) => (candidate.id === runId ? updated : candidate)),
    }))
    return updated
  }

  async complete(
    runId: string,
    status: "completed" | "failed" | "timed_out" | "cancelled",
    result: {
      issueReproduced?: boolean | null
      observationSource?: "deterministic" | "human"
      observation?: string
    } = {},
  ): Promise<ManifestRun> {
    const current = await this.persistence.read()
    const index = current.runs.findIndex((candidate) => candidate.id === runId)
    if (index < 0) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    const existing = current.runs[index]
    if (existing === undefined) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    if (["completed", "failed", "timed_out", "cancelled"].includes(existing.status)) {
      throw new DebugModeError("INVALID_PHASE", "Run is already finished")
    }
    const updated: ManifestRun = {
      ...existing,
      status,
      completedAt: this.clock.now().toISOString(),
      ...(result.issueReproduced === undefined ? {} : { issueReproduced: result.issueReproduced }),
      ...(result.observationSource === undefined ? {} : { observationSource: result.observationSource }),
      ...(result.observation === undefined ? {} : { observation: result.observation.slice(0, 8_192) }),
    }
    await this.persistence.update(current.revision, (manifest) => {
      const runs = manifest.runs.map((candidate) => (candidate.id === runId ? updated : candidate))
      return { ...manifest, waitingForReproduction: runs.some((candidate) => candidate.status === "waiting"), runs }
    })
    this.waitingReleases.get(runId)?.()
    this.waitingReleases.delete(runId)
    return updated
  }
}
