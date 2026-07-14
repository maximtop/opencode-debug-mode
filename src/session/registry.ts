import { createHash, randomBytes } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, readdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { LIMITS } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import { InvestigationStore, initialInvestigationState } from "../investigation/store.js"
import { createInitialManifest, ManifestStore } from "./manifest-store.js"
import { createSessionPaths, isContained, type SessionPaths } from "./paths.js"
import { SecretStore } from "./secret-store.js"
import type { CleanupManifest } from "./types.js"

export function trustedSessionHash(openCodeSessionId: string): string {
  return createHash("sha256").update("opencode-debug-mode:v1:", "utf8").update(openCodeSessionId, "utf8").digest("hex")
}

export type ProjectContext = Readonly<{ directory: string; worktree: string }>

export type DebugSession = Readonly<{
  publicId: string
  trustedHash: string
  projectRoot: string
  directory: string
  paths: SessionPaths
  manifestStore: ManifestStore
  investigationStore: InvestigationStore
  secretStore: SecretStore
  secret: string
}>

type MutableSession = DebugSession & { leases: Map<"process" | "waiting", number> }

export type RegistryCleanup = (session: DebugSession, reason: "idle-expired") => Promise<void>

export class SessionRegistry {
  private readonly sessions = new Map<string, MutableSession>()
  private readonly timer: NodeJS.Timeout
  private closed = false

  constructor(
    private readonly tempBase: string,
    private readonly clock: Clock = systemClock,
    private readonly cleanup?: RegistryCleanup,
  ) {
    this.timer = setInterval(() => void this.sweep(), 30_000)
    this.timer.unref()
  }

  async start(
    trustedId: string,
    context: ProjectContext,
    options: { keepArtifacts?: boolean; retentionDestination?: string } = {},
  ): Promise<DebugSession> {
    this.assertOpen()
    if (Number(process.versions.node.split(".")[0]) < 20) {
      throw new DebugModeError("NODE_UNSUPPORTED", "Node.js 20 or newer is required")
    }
    if (options.keepArtifacts === true && options.retentionDestination === undefined) {
      throw new DebugModeError("DESTINATION_REQUIRED", "An explicit retention destination is required")
    }
    const hash = trustedSessionHash(trustedId)
    if (this.sessions.has(hash) || (await this.findPersisted(hash)) !== undefined) {
      throw new DebugModeError("SESSION_EXISTS", "A debug session already exists for this OpenCode session")
    }

    const projectRoot = await realpath(context.worktree)
    const directory = await realpath(context.directory)
    if (directory !== projectRoot && !isContained(projectRoot, directory)) {
      throw new DebugModeError("STORAGE_UNAVAILABLE", "The active directory is outside the worktree")
    }

    let paths: SessionPaths | undefined
    try {
      paths = await createSessionPaths(this.tempBase, projectRoot)
      const secretStore = new SecretStore(paths.secretFile)
      const secret = await secretStore.create()
      const publicId = `session_${randomBytes(16).toString("base64url")}`
      const manifestStore = new ManifestStore(paths.manifestFile)
      const investigationStore = new InvestigationStore(paths.stateFile, this.clock)
      const now = this.clock.now().toISOString()
      await manifestStore.create(
        createInitialManifest({
          sessionId: publicId,
          trustedSessionHash: hash,
          projectRoot,
          sessionDir: paths.sessionDir,
          now,
          keepArtifacts: options.keepArtifacts ?? false,
          ...(options.retentionDestination === undefined
            ? {}
            : { retentionDestination: path.resolve(options.retentionDestination) }),
        }),
      )
      await investigationStore.create(initialInvestigationState(now))
      const session: MutableSession = {
        publicId,
        trustedHash: hash,
        projectRoot,
        directory,
        paths,
        manifestStore,
        investigationStore,
        secretStore,
        secret,
        leases: new Map(),
      }
      this.sessions.set(hash, session)
      return session
    } catch (error) {
      if (paths !== undefined) await rm(paths.sessionDir, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof DebugModeError) throw error
      throw new DebugModeError("STORAGE_UNAVAILABLE", "The debug session could not be initialized")
    }
  }

  async requireOwned(trustedId: string): Promise<DebugSession> {
    this.assertOpen()
    const hash = trustedSessionHash(trustedId)
    const inMemory = this.sessions.get(hash)
    if (inMemory !== undefined) return inMemory
    const persisted = await this.findPersisted(hash)
    if (persisted === undefined) throw new DebugModeError("NO_ACTIVE_SESSION", "No active debug session exists")
    this.sessions.set(hash, persisted)
    return persisted
  }

  async hasTrusted(trustedId: string): Promise<boolean> {
    try {
      await this.requireOwned(trustedId)
      return true
    } catch (error) {
      if (error instanceof DebugModeError && error.code === "NO_ACTIVE_SESSION") return false
      throw error
    }
  }

  async touch(trustedId: string): Promise<void> {
    const session = (await this.requireOwned(trustedId)) as MutableSession
    await this.touchSession(session)
  }

  async touchSession(sessionValue: DebugSession): Promise<void> {
    const session = this.sessions.get(sessionValue.trustedHash)
    if (session === undefined || session.publicId !== sessionValue.publicId) {
      throw new DebugModeError("SESSION_OWNERSHIP_MISMATCH", "Session is not owned by this registry")
    }
    const now = this.clock.now()
    await session.manifestStore.modify((manifest) => ({
      ...manifest,
      lastActivityAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LIMITS.idleMs).toISOString(),
    }))
  }

  async acquireLease(trustedId: string, kind: "process" | "waiting"): Promise<() => void> {
    const session = (await this.requireOwned(trustedId)) as MutableSession
    return this.acquireLeaseForSession(session, kind)
  }

  acquireLeaseForSession(sessionValue: DebugSession, kind: "process" | "waiting"): () => void {
    const session = this.sessions.get(sessionValue.trustedHash)
    if (session === undefined || session.publicId !== sessionValue.publicId) {
      throw new DebugModeError("SESSION_OWNERSHIP_MISMATCH", "Session is not owned by this registry")
    }
    session.leases.set(kind, (session.leases.get(kind) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const next = Math.max(0, (session.leases.get(kind) ?? 1) - 1)
      if (next === 0) session.leases.delete(kind)
      else session.leases.set(kind, next)
    }
  }

  async sweep(): Promise<void> {
    if (this.closed) return
    const now = this.clock.now().getTime()
    for (const [hash, session] of this.sessions) {
      const manifest = await session.manifestStore.read().catch(() => undefined)
      if (
        manifest === undefined ||
        manifest.waitingForReproduction ||
        session.leases.size > 0 ||
        new Date(manifest.lastActivityAt).getTime() + LIMITS.idleMs > now
      ) {
        continue
      }
      if (this.cleanup !== undefined) await this.cleanup(session, "idle-expired")
      this.sessions.delete(hash)
    }
  }

  listActive(): DebugSession[] {
    return [...this.sessions.values()]
  }

  forgetTrusted(trustedId: string): void {
    this.sessions.delete(trustedSessionHash(trustedId))
  }

  async closeAll(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.sessions.clear()
  }

  private async findPersisted(hash: string): Promise<MutableSession | undefined> {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(this.tempBase, { withFileTypes: true, encoding: "utf8" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    const matches: MutableSession[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue
      const sessionDir = path.join(this.tempBase, entry.name)
      if ((await lstat(sessionDir)).isSymbolicLink()) continue
      try {
        const manifestStore = new ManifestStore(path.join(sessionDir, "manifest.json"))
        const manifest = await manifestStore.read()
        if (manifest.trustedSessionHash !== hash || manifest.status !== "active") continue
        if (!manifest.waitingForReproduction && new Date(manifest.expiresAt).getTime() < this.clock.now().getTime())
          continue
        const paths = this.pathsFromManifest(manifest)
        const secretStore = new SecretStore(paths.secretFile)
        const secret = await secretStore.read()
        const investigationStore = new InvestigationStore(paths.stateFile, this.clock)
        const recovery = await investigationStore.readRecovery()
        if (!recovery.ok) throw new DebugModeError(recovery.error.code, recovery.error.message)
        matches.push({
          publicId: manifest.sessionId,
          trustedHash: hash,
          projectRoot: manifest.projectRoot,
          directory: manifest.projectRoot,
          paths,
          manifestStore,
          investigationStore,
          secretStore,
          secret,
          leases: new Map(),
        })
      } catch {}
    }
    if (matches.length > 1) {
      throw new DebugModeError("SESSION_OWNERSHIP_MISMATCH", "Multiple session manifests match this trusted session")
    }
    return matches[0]
  }

  private pathsFromManifest(manifest: CleanupManifest): SessionPaths {
    return Object.freeze({
      baseDir: this.tempBase,
      sessionDir: manifest.sessionDir,
      projectRoot: manifest.projectRoot,
      manifestFile: path.join(manifest.sessionDir, "manifest.json"),
      secretFile: path.join(manifest.sessionDir, "secret.bin"),
      stateFile: path.join(manifest.sessionDir, "investigation-state.json"),
      evidenceFile: path.join(manifest.sessionDir, "evidence.ndjson"),
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new DebugModeError("NO_ACTIVE_SESSION", "The session registry is closed")
  }
}
