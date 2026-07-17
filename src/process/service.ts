import { type ChildProcess, fork } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { z } from "zod"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { EVENT_SCHEMA_VERSION, LIMITS } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import type { EvidenceStore } from "../evidence/store.js"
import { EventInputSchema } from "../evidence/types.js"
import type { ProbeRegistry } from "../probes/registry.js"
import { evaluateOutcomePredicate, type OutcomePredicate } from "../run/outcome.js"
import type { RunService } from "../run/service.js"
import type { DebugSession } from "../session/registry.js"
import type { CleanupManifest, ProcessManifestSchema } from "../session/types.js"
import { resolveExecutablePath } from "./executable-resolver.js"
import { type DecodedProcessRecord, ProcessLineDecoder, type ProcessStream } from "./line-decoder.js"
import { resolveNodeRuntime, sanitizedSupervisorEnvironment } from "./node-runtime.js"
import { parseChildMessage } from "./protocol.js"
import { type WorktreeReconciliation, WorktreeSnapshot } from "./worktree-snapshot.js"

type OwnedProcess = z.infer<typeof ProcessManifestSchema>

export type ProcessCaptureInput = Readonly<{
  runId: string
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  probeIds?: string[]
  purpose?: "instrumentation-check" | "reproduction" | "verification"
  outcomePredicate?: OutcomePredicate
  signal?: AbortSignal
}>

export type ProcessCaptureResult = Readonly<{
  processId: string
  runId: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  stdoutEvents: number
  stderrEvents: number
  probeEvents: number
  probeIds: string[]
  matchingProbeEvents: number
  issueReproduced: boolean | null
  outcomePredicate: OutcomePredicate | null
  resultEvidenceId: string
}>

function generatedId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("base64url")}`
}

function defaultSupervisorPath(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(directory, "process-supervisor.js")
  if (existsSync(bundled)) return bundled
  return path.resolve(directory, "../../dist/process-supervisor.js")
}

function isBareNodeExecutable(executable: string): boolean {
  return /^(?:node|node\.exe)$/iu.test(executable)
}

function isBareExecutable(executable: string): boolean {
  return !executable.includes("/") && !executable.includes("\\")
}

export class ProcessService {
  constructor(
    private readonly dependencies: {
      session: DebugSession
      runs: RunService
      evidence: EvidenceStore
      acquireLease: () => Promise<() => void>
      probes?: ProbeRegistry
      supervisorPath?: string
      nodeExecutable?: string
      resolveExecutable?: (name: string) => string | undefined
      forkSupervisor?: typeof fork
      clock?: Clock
    },
  ) {}

  private resolvedNodeExecutable: string | undefined

  async capture(input: ProcessCaptureInput): Promise<ProcessCaptureResult> {
    const run = await this.dependencies.runs.require(input.runId)
    if (input.outcomePredicate !== undefined) {
      await this.dependencies.runs.bindOutcomePredicate(input.runId, input.outcomePredicate)
    }
    const release = await this.dependencies.acquireLease()
    const clock = this.dependencies.clock ?? systemClock
    const startedAt = clock.monotonicMs()
    const decoder = new ProcessLineDecoder({ maxLineBytes: 8_192 })
    let stdoutEvents = 0
    let stderrEvents = 0
    const probeIds = [...new Set(input.probeIds ?? [])]
    let priorMatchingProbeEventIds = new Set<string>()
    const records: DecodedProcessRecord[] = []
    let recordBytes = 0
    let startedUpdate: Promise<void> = Promise.resolve()
    let child: ChildProcess | undefined
    const processId = generatedId("process_")
    const ownerNonce = randomBytes(32).toString("base64url")
    let snapshot: WorktreeSnapshot | undefined
    let snapshotReconciled = false
    let processOwned = false

    const bufferRecord = (record: DecodedProcessRecord): void => {
      if (records.length >= LIMITS.events) return
      const bytes = Buffer.byteLength(JSON.stringify(record))
      if (recordBytes + bytes > LIMITS.evidenceBytes) return
      records.push(record)
      recordBytes += bytes
    }

    const reconcile = async (): Promise<void> => {
      if (snapshot === undefined || snapshotReconciled) return
      snapshotReconciled = true
      const reconciliation = await snapshot.reconcile()
      if (reconciliation.changedPaths.length === 0 && reconciliation.restored) return
      if (processOwned) await this.markRejected(processId)
      throw this.mutationError(reconciliation)
    }

    try {
      snapshot = await WorktreeSnapshot.create(
        this.dependencies.session.projectRoot,
        this.dependencies.session.paths.sessionDir,
      )
      priorMatchingProbeEventIds = new Set(await this.matchingProbeEventIds(input.runId, probeIds))
      const nodeExecutable = this.resolvedNodeExecutable ?? this.dependencies.nodeExecutable ?? resolveNodeRuntime()
      this.resolvedNodeExecutable = nodeExecutable
      let targetExecutable = input.executable
      if (isBareNodeExecutable(input.executable)) {
        targetExecutable = nodeExecutable
      } else if (isBareExecutable(input.executable)) {
        const resolveExecutable =
          this.dependencies.resolveExecutable ??
          ((name: string) => resolveExecutablePath(name, { pathValue: process.env.PATH ?? "" }))
        const resolved = resolveExecutable(input.executable)
        if (resolved === undefined) {
          throw new DebugModeError(
            "PROCESS_START_FAILED",
            `The supervised executable ${input.executable} could not be resolved to an absolute path`,
            false,
            { action: "Install the allowlisted check tool on an absolute PATH entry and retry" },
          )
        }
        targetExecutable = resolved
      }
      try {
        child = (this.dependencies.forkSupervisor ?? fork)(
          this.dependencies.supervisorPath ?? defaultSupervisorPath(),
          [],
          {
            execPath: nodeExecutable,
            execArgv: [],
            env: sanitizedSupervisorEnvironment(),
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        )
      } catch {
        throw new DebugModeError("PROCESS_START_FAILED", "Supervisor could not be launched with Node.js")
      }
      if (child.pid === undefined) throw new DebugModeError("PROCESS_START_FAILED", "Supervisor did not receive a PID")
      await this.waitForMessage(child, "ready", 2_000)
      await this.addOwnedProcess({
        id: processId,
        runId: input.runId,
        commandSummary: [path.basename(input.executable), ...input.args.map((value) => path.basename(value))]
          .join(" ")
          .slice(0, 8_192),
        supervisorPid: child.pid,
        ownerNonceHash: createHash("sha256").update(ownerNonce).digest("hex"),
        status: "starting",
        startedAt: clock.now().toISOString(),
      })
      processOwned = true

      const consume = (stream: ProcessStream, chunk: Buffer) => {
        for (const record of decoder.push(stream, chunk)) bufferRecord(record)
      }
      child.stdout?.on("data", (chunk: Buffer) => consume("stdout", chunk))
      child.stderr?.on("data", (chunk: Buffer) => consume("stderr", chunk))

      const resultPromise = new Promise<ReturnType<typeof parseChildMessage>>((resolve, reject) => {
        child?.on("message", (value: unknown) => {
          try {
            const message = parseChildMessage(value)
            if (message.type === "started") startedUpdate = this.markStarted(processId, message.targetPid)
            if (message.type === "failure") reject(new DebugModeError("PROCESS_START_FAILED", message.message))
            if (message.type === "result") resolve(message)
          } catch {
            reject(new DebugModeError("PROCESS_START_FAILED", "Supervisor returned an invalid message"))
          }
        })
        child?.once("error", () => reject(new DebugModeError("PROCESS_START_FAILED", "Supervisor failed to start")))
        child?.once("exit", (code) => {
          if (code !== 0) reject(new DebugModeError("PROCESS_START_FAILED", "Supervisor exited unexpectedly"))
        })
      })

      child.send({
        type: "start",
        executable: targetExecutable,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
        ownerNonce,
      })

      const abort = () => {
        if (child?.connected) child.send({ type: "terminate", reason: "abort" })
      }
      input.signal?.addEventListener("abort", abort, { once: true })
      if (input.signal?.aborted === true) abort()
      let result: ReturnType<typeof parseChildMessage>
      try {
        result = await resultPromise
      } finally {
        input.signal?.removeEventListener("abort", abort)
      }
      if (result.type !== "result") throw new DebugModeError("PROCESS_START_FAILED", "Supervisor returned no result")
      for (const stream of ["stdout", "stderr"] as const) {
        for (const record of decoder.flush(stream)) bufferRecord(record)
      }
      await startedUpdate
      await reconcile()
      for (const record of records) {
        const kind = await this.persistRecord(record, input, run.label)
        if (kind === "stdout") stdoutEvents += 1
        else if (kind === "stderr") stderrEvents += 1
      }
      await this.markCompleted(processId, result)
      const matchingProbeEventIds = (await this.matchingProbeEventIds(input.runId, probeIds)).filter(
        (eventId) => !priorMatchingProbeEventIds.has(eventId),
      )
      const probeEvents = matchingProbeEventIds.length
      const issueReproduced =
        input.outcomePredicate === undefined ? null : evaluateOutcomePredicate(input.outcomePredicate, result)
      const resultEvidence = await this.dependencies.evidence.append({
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: generatedId("event_"),
        timestamp: clock.now().toISOString(),
        sessionId: this.dependencies.session.publicId,
        runId: input.runId,
        runLabel: run.label,
        hypothesisId: "hyp_process",
        probeId: "probe_process",
        kind: "process.result",
        message: `${input.purpose ?? "reproduction"} process completed`,
        data: {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          purpose: input.purpose ?? "reproduction",
          processId,
          probeIds,
          probeEvents,
          matchingProbeEvents: matchingProbeEventIds.length,
          matchingProbeEventIds,
          outcomePredicate: input.outcomePredicate ?? null,
          issueReproduced,
        },
        source: { file: "process", line: 1 },
      })
      if (resultEvidence.status !== "accepted" || resultEvidence.event === undefined) {
        throw new DebugModeError("EVIDENCE_UNAVAILABLE", "The process result could not be persisted as evidence")
      }
      return {
        processId,
        runId: input.runId,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: clock.monotonicMs() - startedAt,
        stdoutEvents,
        stderrEvents,
        probeEvents,
        probeIds,
        matchingProbeEvents: matchingProbeEventIds.length,
        issueReproduced,
        outcomePredicate: input.outcomePredicate ?? null,
        resultEvidenceId: resultEvidence.event.eventId,
      }
    } catch (error) {
      if (!snapshotReconciled && child?.connected === true) {
        child.send({ type: "terminate", reason: "capture-failed" })
        await this.waitForExit(child, 2_500)
      }
      await reconcile()
      throw error
    } finally {
      if (child?.connected) child.disconnect()
      if (snapshot !== undefined && !snapshotReconciled) await snapshot.dispose().catch(() => undefined)
      release()
    }
  }

  private async matchingProbeEventIds(runId: string, probeIds: readonly string[]): Promise<string[]> {
    if (probeIds.length === 0) return []
    const selected = new Set(probeIds)
    const eventIds: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.dependencies.evidence.read({
        sessionId: this.dependencies.session.publicId,
        runId,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const event of page.events) {
        if (event.kind === "probe" && selected.has(event.probeId)) eventIds.push(event.eventId)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return eventIds
  }

  private mutationError(reconciliation: WorktreeReconciliation): DebugModeError {
    const preview = reconciliation.changedPaths.slice(0, 5).join(", ")
    const suffix = reconciliation.changedPaths.length > 5 ? ", ..." : ""
    const residuePreview = reconciliation.residuePaths.slice(0, 3).join(", ")
    return new DebugModeError(
      "INVALID_PHASE",
      reconciliation.restored
        ? `Supervised command changed protected project files; all changes were restored (${preview}${suffix})`
        : `Supervised command changed protected project files and ${reconciliation.restorationFailures} restoration step(s) failed${residuePreview.length === 0 ? "" : `; review residue at ${residuePreview}`}`,
      false,
      {
        action: reconciliation.restored
          ? "Review the checked-in test, build, or check script and repeat with a read-only command"
          : "Stop debugging and recover the affected worktree files before continuing",
        details: {
          changedFiles: reconciliation.changedPaths.length,
          restored: reconciliation.restored,
          restorationFailures: reconciliation.restorationFailures,
          residueFiles: reconciliation.residuePaths.length,
        },
      },
    )
  }

  private async persistRecord(
    record: DecodedProcessRecord,
    input: ProcessCaptureInput,
    runLabel: "pre-fix" | "post-fix",
  ): Promise<"stdout" | "stderr" | "probe" | "ignored"> {
    if (record.kind === "truncated") {
      const result = await this.dependencies.evidence.append({
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: generatedId("event_"),
        timestamp: new Date().toISOString(),
        sessionId: this.dependencies.session.publicId,
        runId: input.runId,
        runLabel,
        hypothesisId: "hyp_process",
        probeId: "probe_process",
        kind: `process.${record.stream}`,
        message: "[TRUNCATED OUTPUT LINE]",
        data: { maximumBytes: record.maximumBytes },
        source: { file: "process", line: 1 },
      })
      return result.status === "accepted" ? record.stream : "ignored"
    }
    if (record.kind === "output") {
      if (record.text.length === 0) return "ignored"
      const result = await this.dependencies.evidence.append({
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: generatedId("event_"),
        timestamp: new Date().toISOString(),
        sessionId: this.dependencies.session.publicId,
        runId: input.runId,
        runLabel,
        hypothesisId: "hyp_process",
        probeId: "probe_process",
        kind: `process.${record.stream}`,
        message: record.text,
        data: null,
        source: { file: "process", line: 1 },
      })
      return result.status === "accepted" ? record.stream : "ignored"
    }

    const parsed = EventInputSchema.safeParse(record.value)
    if (!parsed.success) return "ignored"
    const validated =
      this.dependencies.probes === undefined ? parsed.data : await this.dependencies.probes.validateEvent(parsed.data)
    const result = await this.dependencies.evidence.append({
      ...validated,
      eventId: generatedId("event_"),
      kind: "probe",
    })
    return result.status === "accepted" ? "probe" : "ignored"
  }

  private async addOwnedProcess(owned: OwnedProcess): Promise<void> {
    await this.updateManifest((manifest) => ({ ...manifest, processes: [...manifest.processes, owned] }))
  }

  private async markStarted(id: string, targetPid: number): Promise<void> {
    await this.updateManifest((manifest) => ({
      ...manifest,
      processes: manifest.processes.map((entry) =>
        entry.id === id ? { ...entry, targetPid, status: "running" as const } : entry,
      ),
    }))
  }

  private async markCompleted(
    id: string,
    result: Extract<ReturnType<typeof parseChildMessage>, { type: "result" }>,
  ): Promise<void> {
    await this.updateManifest((manifest) => ({
      ...manifest,
      processes: manifest.processes.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status: result.timedOut ? ("timed_out" as const) : ("exited" as const),
              completedAt: new Date().toISOString(),
              exitCode: result.exitCode,
              signal: result.signal,
            }
          : entry,
      ),
    }))
  }

  private async markRejected(id: string): Promise<void> {
    await this.updateManifest((manifest) => ({
      ...manifest,
      processes: manifest.processes.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status: "failed" as const,
              completedAt: new Date().toISOString(),
            }
          : entry,
      ),
    }))
  }

  private async updateManifest(mutate: (manifest: CleanupManifest) => CleanupManifest): Promise<void> {
    await this.dependencies.session.manifestStore.modify(mutate)
  }

  private waitForMessage(child: ChildProcess, type: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new DebugModeError("PROCESS_START_FAILED", `Supervisor did not become ${type}`))
      }, timeoutMs)
      const message = (value: unknown) => {
        try {
          if (parseChildMessage(value).type === type) {
            cleanup()
            resolve()
          }
        } catch {
          cleanup()
          reject(new DebugModeError("PROCESS_START_FAILED", "Supervisor returned an invalid message"))
        }
      }
      const exit = () => {
        cleanup()
        reject(new DebugModeError("PROCESS_START_FAILED", "Supervisor exited before becoming ready"))
      }
      const error = () => {
        cleanup()
        reject(new DebugModeError("PROCESS_START_FAILED", "Supervisor failed to start with Node.js"))
      }
      const cleanup = () => {
        clearTimeout(timeout)
        child.off("message", message)
        child.off("exit", exit)
        child.off("error", error)
      }
      child.on("message", message)
      child.once("exit", exit)
      child.once("error", error)
    })
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.off("exit", exited)
        resolve()
      }, timeoutMs)
      const exited = () => {
        clearTimeout(timeout)
        resolve()
      }
      child.once("exit", exited)
    })
  }
}
