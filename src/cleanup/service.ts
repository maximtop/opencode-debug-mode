import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import type { z } from "zod"
import type { CollectorServer } from "../collector/server.js"
import { DebugModeError } from "../core/errors.js"
import { removeLoopbackPermission } from "../probes/extension-permissions.js"
import { removeOwnedProbe } from "../probes/remove.js"
import { terminateTree } from "../process/tree.js"
import type { DebugSession } from "../session/registry.js"
import type { OwnedFileManifestSchema, ProcessManifestSchema } from "../session/types.js"
import { finalizeRetainedBundle, type StagedBundle, stageRetainedBundle } from "./export.js"
import { type CleanupResult, type FinalReportInput, FinalReportInputSchema } from "./types.js"

type OwnedFile = z.infer<typeof OwnedFileManifestSchema>
type OwnedProcess = z.infer<typeof ProcessManifestSchema>
type ResourceResult = CleanupResult["resources"]["collector"]

export class CleanupService {
  private running: Promise<CleanupResult> | undefined
  private completed: CleanupResult | undefined

  constructor(
    private readonly session: DebugSession,
    private readonly dependencies: {
      collector?: Pick<CollectorServer, "close">
      terminateProcess?: (process: OwnedProcess) => Promise<ResourceResult>
      removeSecret?: () => Promise<"success" | "already-clean">
      securityValues?: string[]
    } = {},
  ) {}

  async run(input: {
    reason: string
    finalReport: FinalReportInput
    cleanCheck?: { executable: string; args: string[]; cwd: string; timeoutMs: number }
  }): Promise<CleanupResult> {
    if (this.completed !== undefined) return this.completed
    this.running ??= this.execute(input)
    this.completed = await this.running
    return this.completed
  }

  private async execute(input: {
    reason: string
    finalReport: FinalReportInput
    cleanCheck?: { executable: string; args: string[]; cwd: string; timeoutMs: number }
  }): Promise<CleanupResult> {
    const started = performance.now()
    const finalReport = FinalReportInputSchema.parse(input.finalReport)
    const manifest = await this.session.manifestStore.read()
    await this.session.manifestStore
      .update(manifest.revision, (value) => ({
        ...value,
        status: "cleaning",
        cleanup: { status: "running", completedResources: [] },
      }))
      .catch(() => undefined)
    const state = await this.session.investigationStore.read().catch(() => undefined)
    if (state !== undefined) {
      await this.session.investigationStore
        .checkpoint(state.revision, {
          ...state,
          phase: "cleaning",
          cleanup: { status: "running", completedResources: state.cleanup.completedResources },
        })
        .catch(() => undefined)
    }

    let collector: ResourceResult = { status: "skipped", reason: "not-running" }
    if (manifest.collector !== null) {
      if (this.dependencies.collector === undefined)
        collector = { status: "failed", reason: "collector-runtime-unavailable" }
      else {
        try {
          await this.dependencies.collector.close()
          collector = { status: "success" }
        } catch {
          collector = { status: "failed", reason: "collector-close-failed" }
        }
      }
    }

    const processes: ResourceResult[] = []
    for (const owned of manifest.processes) {
      try {
        if (this.dependencies.terminateProcess !== undefined)
          processes.push(await this.dependencies.terminateProcess(owned))
        else if (owned.targetPid !== undefined) {
          const result = await terminateTree(owned.targetPid)
          processes.push(result.remaining ? { status: "failed", reason: "process-remains" } : { status: "success" })
        } else processes.push({ status: "already-clean" })
      } catch {
        processes.push({ status: "failed", reason: "process-termination-failed" })
      }
    }

    const probes: ResourceResult[] = []
    for (const probe of manifest.probes) {
      const result = await removeOwnedProbe(probe)
      probes.push({
        status: result.status === "already-clean" ? "already-clean" : result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        location: probe.sourceFile,
      })
    }

    const permissions: ResourceResult[] = []
    for (const change of manifest.permissionChanges) {
      const result = await removeLoopbackPermission(change.manifestPath, change)
      permissions.push({
        status: result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        location: change.manifestPath,
      })
    }

    const files: ResourceResult[] = []
    for (const owned of manifest.ownedFiles) files.push(await this.removeOwnedFile(owned))

    const cleanCheck = input.cleanCheck === undefined ? undefined : await this.runCleanCheck(input.cleanCheck)
    let staged: StagedBundle | undefined
    if (manifest.keepArtifacts && manifest.retentionDestination !== undefined) {
      try {
        staged = await stageRetainedBundle({
          keepArtifacts: true,
          destination: manifest.retentionDestination,
          sessionDir: manifest.sessionDir,
          evidenceFile: this.session.paths.evidenceFile,
          stateFile: this.session.paths.stateFile,
          token: this.session.secret,
          securityValues: this.dependencies.securityValues ?? [],
          finalReport,
        })
      } catch {
        files.push({ status: "failed", reason: "retention-export-failed" })
      }
    }

    let secret: ResourceResult
    try {
      const status = await (this.dependencies.removeSecret?.() ?? this.session.secretStore.remove())
      secret = { status }
    } catch {
      secret = { status: "failed", reason: "secret-removal-failed" }
    }

    let sessionDirectory: ResourceResult
    try {
      await rm(this.session.paths.sessionDir, { recursive: true, force: true })
      sessionDirectory = { status: "success" }
    } catch {
      sessionDirectory = { status: "failed", reason: "session-directory-removal-failed" }
    }

    const resources = { collector, processes, probes, permissions, files, secret, sessionDirectory }
    const failures = [collector, ...processes, ...probes, ...permissions, ...files, secret, sessionDirectory].filter(
      (result) => result.status === "failed",
    )
    const remainingArtifacts = failures.flatMap((result) => (result.location === undefined ? [] : [result.location]))
    const result: CleanupResult = {
      status: failures.length === 0 ? "complete" : "partial",
      reason: input.reason.slice(0, 256),
      resources,
      remainingArtifacts,
      durationMs: performance.now() - started,
      ...(cleanCheck === undefined ? {} : { cleanCheck }),
    }
    if (staged !== undefined) {
      try {
        const retained = await finalizeRetainedBundle(staged, result)
        result.retainedArtifactLocation = retained.path
      } catch (error) {
        result.status = "partial"
        result.resources.files.push({
          status: "failed",
          reason:
            error instanceof DebugModeError
              ? `retention-finalize-failed:${error.code}:${error.message}`.slice(0, 8_192)
              : "retention-finalize-failed",
        })
      }
    }
    return result
  }

  private async removeOwnedFile(owned: OwnedFile): Promise<ResourceResult> {
    try {
      const content = await readFile(owned.path)
      if (createHash("sha256").update(content).digest("hex") !== owned.sha256 || content.byteLength !== owned.bytes) {
        return { status: "failed", reason: "owned-file-hash-mismatch", location: owned.path }
      }
      await rm(owned.path)
      return { status: "success", location: owned.path }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "already-clean", location: owned.path }
      return { status: "failed", reason: "owned-file-removal-failed", location: owned.path }
    }
  }

  private runCleanCheck(input: { executable: string; args: string[]; cwd: string; timeoutMs: number }) {
    const started = performance.now()
    return new Promise<NonNullable<CleanupResult["cleanCheck"]>>((resolve) => {
      const child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      })
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, input.timeoutMs)
      child.once("exit", (exitCode) => {
        clearTimeout(timeout)
        resolve({
          command: [input.executable, ...input.args].join(" ").slice(0, 8_192),
          exitCode,
          timedOut,
          durationMs: performance.now() - started,
        })
      })
      child.once("error", () => {
        clearTimeout(timeout)
        resolve({
          command: input.executable.slice(0, 8_192),
          exitCode: null,
          timedOut,
          durationMs: performance.now() - started,
        })
      })
    })
  }
}
