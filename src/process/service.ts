import { type ChildProcess, fork } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { z } from "zod"
import type { Clock } from "../core/clock.js"
import { systemClock } from "../core/clock.js"
import { EVENT_SCHEMA_VERSION } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import type { EvidenceStore } from "../evidence/store.js"
import { EventInputSchema } from "../evidence/types.js"
import type { ProbeRegistry } from "../probes/registry.js"
import type { RunService } from "../run/service.js"
import type { DebugSession } from "../session/registry.js"
import type { CleanupManifest, ProcessManifestSchema } from "../session/types.js"
import { type DecodedProcessRecord, ProcessLineDecoder, type ProcessStream } from "./line-decoder.js"
import { parseChildMessage } from "./protocol.js"

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

export class ProcessService {
  constructor(
    private readonly dependencies: {
      session: DebugSession
      runs: RunService
      evidence: EvidenceStore
      acquireLease: () => Promise<() => void>
      probes?: ProbeRegistry
      supervisorPath?: string
      clock?: Clock
    },
  ) {}

  async capture(input: ProcessCaptureInput): Promise<ProcessCaptureResult> {
    const run = await this.dependencies.runs.require(input.runId)
    const release = await this.dependencies.acquireLease()
    const clock = this.dependencies.clock ?? systemClock
    const startedAt = clock.monotonicMs()
    const decoder = new ProcessLineDecoder({ maxLineBytes: 8_192 })
    let stdoutEvents = 0
    let stderrEvents = 0
    let probeEvents = 0
    let writes: Promise<void> = Promise.resolve()
    let startedUpdate: Promise<void> = Promise.resolve()
    let child: ChildProcess | undefined
    const processId = generatedId("process_")
    const ownerNonce = randomBytes(32).toString("base64url")

    try {
      child = fork(this.dependencies.supervisorPath ?? defaultSupervisorPath(), [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
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

      const consume = (stream: ProcessStream, chunk: Buffer) => {
        for (const record of decoder.push(stream, chunk)) {
          writes = writes
            .then(() => this.persistRecord(record, input, run.label))
            .then((kind) => {
              if (kind === "probe") probeEvents += 1
              else if (kind === "stdout") stdoutEvents += 1
              else if (kind === "stderr") stderrEvents += 1
            })
        }
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
        executable: input.executable,
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
        for (const record of decoder.flush(stream)) {
          writes = writes
            .then(() => this.persistRecord(record, input, run.label))
            .then((kind) => {
              if (kind === "probe") probeEvents += 1
              else if (kind === "stdout") stdoutEvents += 1
              else if (kind === "stderr") stderrEvents += 1
            })
        }
      }
      await writes
      await startedUpdate
      await this.markCompleted(processId, result)
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
      }
    } finally {
      if (child?.connected) child.disconnect()
      release()
    }
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
      const cleanup = () => {
        clearTimeout(timeout)
        child.off("message", message)
        child.off("exit", exit)
      }
      child.on("message", message)
      child.once("exit", exit)
    })
  }
}
