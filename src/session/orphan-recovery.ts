import type { Dirent } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { CleanupService } from "../cleanup/service.js"
import type { FinalReportInput } from "../cleanup/types.js"
import { InvestigationStore } from "../investigation/store.js"
import { ManifestStore } from "./manifest-store.js"
import { isContained } from "./paths.js"
import type { DebugSession } from "./registry.js"
import { SecretStore } from "./secret-store.js"
import type { CleanupManifest } from "./types.js"

export type OrphanRecoveryOptions = Readonly<{
  tempBase: string
  now?: Date
  activeSessionDirs?: Set<string>
  cleanup?: (session: DebugSession, manifest: CleanupManifest) => Promise<void>
}>

async function assertContainedReference(target: string, roots: string[]): Promise<void> {
  const absolute = path.resolve(target)
  if (!roots.some((root) => absolute === root || isContained(root, absolute))) {
    throw new Error("Manifest path escapes its owned roots")
  }
  try {
    const canonical = await realpath(absolute)
    if (!roots.some((root) => canonical === root || isContained(root, canonical))) {
      throw new Error("Manifest path resolves outside its owned roots")
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export async function recoverOrphans(options: OrphanRecoveryOptions): Promise<{
  cleaned: string[]
  ignored: string[]
  errors: Array<{ directory: string; reason: string }>
}> {
  const cleaned: string[] = []
  const ignored: string[] = []
  const errors: Array<{ directory: string; reason: string }> = []
  let entries: Dirent<string>[]
  try {
    entries = await readdir(options.tempBase, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cleaned, ignored, errors }
    throw error
  }
  const now = (options.now ?? new Date()).getTime()
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) {
      ignored.push(entry.name)
      continue
    }
    const sessionDir = path.join(options.tempBase, entry.name)
    try {
      if ((await lstat(sessionDir)).isSymbolicLink()) {
        ignored.push(entry.name)
        continue
      }
      const canonicalSessionDir = await realpath(sessionDir)
      if (options.activeSessionDirs?.has(canonicalSessionDir) === true) {
        ignored.push(entry.name)
        continue
      }
      const manifestStore = new ManifestStore(path.join(sessionDir, "manifest.json"))
      const manifest = await manifestStore.read()
      const canonicalProjectRoot = await realpath(manifest.projectRoot)
      if (
        (await realpath(manifest.sessionDir)) !== canonicalSessionDir ||
        new Date(manifest.expiresAt).getTime() >= now
      ) {
        ignored.push(entry.name)
        continue
      }
      for (const probe of manifest.probes) {
        await assertContainedReference(probe.sourceFile, [canonicalProjectRoot])
      }
      for (const permission of manifest.permissionChanges) {
        await assertContainedReference(permission.manifestPath, [canonicalProjectRoot])
      }
      for (const owned of manifest.ownedFiles) {
        await assertContainedReference(owned.path, [canonicalProjectRoot, canonicalSessionDir])
      }
      const paths = Object.freeze({
        baseDir: options.tempBase,
        sessionDir: manifest.sessionDir,
        projectRoot: canonicalProjectRoot,
        manifestFile: path.join(manifest.sessionDir, "manifest.json"),
        secretFile: path.join(manifest.sessionDir, "secret.bin"),
        stateFile: path.join(manifest.sessionDir, "investigation-state.json"),
        evidenceFile: path.join(manifest.sessionDir, "evidence.ndjson"),
      })
      const secretStore = new SecretStore(paths.secretFile)
      const secret = await secretStore.read().catch(() => "")
      const session: DebugSession = {
        publicId: manifest.sessionId,
        trustedHash: manifest.trustedSessionHash,
        projectRoot: canonicalProjectRoot,
        directory: canonicalProjectRoot,
        paths,
        manifestStore,
        investigationStore: new InvestigationStore(paths.stateFile),
        secretStore,
        secret,
      }
      if (options.cleanup !== undefined) await options.cleanup(session, manifest)
      else {
        const report: FinalReportInput = {
          outcome: "abandoned",
          rootCause: "Investigation ended after its orphaned session expired",
          decidingEvidence: [],
          hypotheses: [],
          fix: "No recovery-time fix was applied",
          changedFiles: [],
          verification: ["Verified package-owned cleanup during startup recovery"],
        }
        await new CleanupService(session).run({ reason: "orphan-recovery", finalReport: report })
      }
      cleaned.push(manifest.sessionId)
    } catch (error) {
      errors.push({
        directory: entry.name,
        reason: error instanceof Error ? error.name.slice(0, 128) : "recovery-failed",
      })
    }
  }
  return { cleaned, ignored, errors }
}
