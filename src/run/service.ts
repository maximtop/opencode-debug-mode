import { randomBytes } from "node:crypto"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { DebugModeError } from "../core/errors.js"
import { RunLabelSchema } from "../core/schemas.js"
import type { CleanupManifest, ManifestRun } from "../session/types.js"

export interface RunPersistence {
  read(): Promise<CleanupManifest>
  update(expectedRevision: number, mutate: (value: CleanupManifest) => CleanupManifest): Promise<CleanupManifest>
}

export type LeaseFactory = (kind: "process" | "waiting") => Promise<() => void> | (() => void)

function createId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("base64url")}`
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

  async complete(runId: string, status: "completed" | "failed" | "timed_out" | "cancelled"): Promise<ManifestRun> {
    const current = await this.persistence.read()
    const index = current.runs.findIndex((candidate) => candidate.id === runId)
    if (index < 0) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    const existing = current.runs[index]
    if (existing === undefined) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    const updated: ManifestRun = { ...existing, status, completedAt: this.clock.now().toISOString() }
    await this.persistence.update(current.revision, (manifest) => ({
      ...manifest,
      waitingForReproduction: false,
      runs: manifest.runs.map((candidate) => (candidate.id === runId ? updated : candidate)),
    }))
    this.waitingReleases.get(runId)?.()
    this.waitingReleases.delete(runId)
    return updated
  }
}
