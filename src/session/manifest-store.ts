import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { LIMITS, MANIFEST_SCHEMA_VERSION, PACKAGE_ID } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import { atomicWriteJson } from "./atomic-json.js"
import { isContained } from "./paths.js"
import { type CleanupManifest, ManifestSchema } from "./types.js"

const MANIFEST_MAX_BYTES = 1024 * 1024

export function createInitialManifest(input: {
  sessionId: string
  trustedSessionHash: string
  projectRoot: string
  sessionDir: string
  now: string
  keepArtifacts?: boolean
  retentionDestination?: string
}): CleanupManifest {
  const expiresAt = new Date(new Date(input.now).getTime() + LIMITS.idleMs).toISOString()
  const candidate = {
    package: PACKAGE_ID,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    revision: 0,
    sessionId: input.sessionId,
    trustedSessionHash: input.trustedSessionHash,
    projectRoot: input.projectRoot,
    sessionDir: input.sessionDir,
    status: "active",
    createdAt: input.now,
    lastActivityAt: input.now,
    expiresAt,
    waitingForReproduction: false,
    keepArtifacts: input.keepArtifacts ?? false,
    collector: null,
    runs: [],
    processes: [],
    probes: [],
    ownedFiles: [],
    permissionChanges: [],
    counters: { accepted: 0, rejected: 0, sampled: 0, truncated: 0, dropped: 0, requests: 0 },
    cleanup: { status: "not_started", completedResources: [] },
    ...(input.retentionDestination === undefined ? {} : { retentionDestination: input.retentionDestination }),
  }
  return ManifestSchema.parse(candidate)
}

export class ManifestStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly filename: string) {}

  async create(value: CleanupManifest): Promise<CleanupManifest> {
    return this.exclusive(async () => {
      const parsed = ManifestSchema.parse(value)
      await this.verifyPaths(parsed)
      try {
        await stat(this.filename)
        throw new DebugModeError("SESSION_EXISTS", "Session manifest already exists")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await atomicWriteJson(this.filename, parsed, MANIFEST_MAX_BYTES)
      return parsed
    })
  }

  async read(): Promise<CleanupManifest> {
    const info = await stat(this.filename)
    if (info.size > MANIFEST_MAX_BYTES) throw new Error("Manifest exceeds its byte limit")
    const parsed = ManifestSchema.parse(JSON.parse(await readFile(this.filename, "utf8")))
    await this.verifyPaths(parsed)
    return parsed
  }

  async update(
    expectedRevision: number,
    mutate: (value: CleanupManifest) => CleanupManifest,
  ): Promise<CleanupManifest> {
    return this.exclusive(async () => {
      const current = await this.read()
      if (current.revision !== expectedRevision) {
        throw new DebugModeError("STALE_REVISION", `Expected revision ${expectedRevision}; found ${current.revision}`)
      }
      const next = ManifestSchema.parse({ ...mutate(structuredClone(current)), revision: expectedRevision + 1 })
      await this.verifyPaths(next)
      await atomicWriteJson(this.filename, next, MANIFEST_MAX_BYTES)
      return next
    })
  }

  private async verifyPaths(value: CleanupManifest): Promise<void> {
    const actualSessionDir = await realpath(path.dirname(this.filename))
    const declaredSessionDir = await realpath(value.sessionDir)
    if (actualSessionDir !== declaredSessionDir)
      throw new Error("Manifest session directory does not match its location")
    const packageBase = await realpath(path.dirname(actualSessionDir))
    if (!isContained(packageBase, actualSessionDir)) throw new Error("Manifest is outside the package temporary base")
    if ((await realpath(value.projectRoot)) !== value.projectRoot) {
      throw new Error("Manifest project root is not canonical")
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
