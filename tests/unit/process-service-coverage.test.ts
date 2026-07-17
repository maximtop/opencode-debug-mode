import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import type { EvidenceStore } from "../../src/evidence/store.js"
import type { DecodedProcessRecord } from "../../src/process/line-decoder.js"
import type { ProcessCaptureInput, ProcessService } from "../../src/process/service.js"
import type { WorktreeReconciliation } from "../../src/process/worktree-snapshot.js"
import { createProcessServiceFixture } from "../helpers/factories.js"

type ProcessServiceInternals = {
  dependencies: {
    evidence: EvidenceStore
    probes?: { validateEvent: (input: unknown) => Promise<unknown> }
    supervisorPath?: string
  }
  mutationError: (reconciliation: WorktreeReconciliation) => Error & {
    code: string
    action?: string
    details?: Record<string, unknown>
  }
  persistRecord: (
    record: DecodedProcessRecord,
    input: ProcessCaptureInput,
    runLabel: "pre-fix" | "post-fix",
  ) => Promise<"stdout" | "stderr" | "probe" | "ignored">
  waitForMessage: (child: ChildProcess, type: string, timeoutMs: number) => Promise<void>
  waitForExit: (child: ChildProcess, timeoutMs: number) => Promise<void>
}

function internals(service: ProcessService): ProcessServiceInternals {
  return service as unknown as ProcessServiceInternals
}

class ChildStub extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid: number | undefined = 42_424
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly sent: unknown[] = []
  readonly disconnect = vi.fn(() => {
    this.connected = false
  })

  constructor(private readonly onStart?: (child: ChildStub) => void) {
    super()
  }

  becomeReady(): void {
    queueMicrotask(() => this.emit("message", { type: "ready" }))
  }

  send(message: unknown): boolean {
    this.sent.push(message)
    const type = (message as { type?: string }).type
    if (type === "start") queueMicrotask(() => this.onStart?.(this))
    if (type === "terminate" && (message as { reason?: string }).reason === "capture-failed") {
      queueMicrotask(() => {
        this.exitCode = 0
        this.emit("exit", 0, null)
      })
    }
    return true
  }
}

function forkStub(child: ChildStub): typeof import("node:child_process").fork {
  return vi.fn(() => {
    child.becomeReady()
    return child as unknown as ChildProcess
  }) as unknown as typeof import("node:child_process").fork
}

describe("process service edge coverage", () => {
  it.each([
    "node",
    "node.exe",
  ])("resolves the bare %s target through the trusted Node runtime without changing its summary", async (executable) => {
    const child = new ChildStub((current) => {
      current.emit("message", { type: "started", targetPid: 77 })
      current.emit("message", {
        type: "result",
        targetPid: 77,
        exitCode: 0,
        signal: null,
        timedOut: false,
      })
    })
    const nodeExecutable = "/trusted/runtime/node"
    const fixture = await createProcessServiceFixture({
      nodeExecutable,
      forkSupervisor: forkStub(child),
    })

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable,
        args: ["--version"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ exitCode: 0 })

    expect(child.sent).toContainEqual(
      expect.objectContaining({ type: "start", executable: nodeExecutable, args: ["--version"] }),
    )
    const processEntry = (await fixture.session.manifestStore.read()).processes.at(-1)
    expect(processEntry?.commandSummary).toBe(`${executable} --version`)
  })

  it("resolves a bare non-Node target to an absolute executable after snapshot creation", async () => {
    const child = new ChildStub((current) => {
      current.emit("message", { type: "started", targetPid: 78 })
      current.emit("message", {
        type: "result",
        targetPid: 78,
        exitCode: 0,
        signal: null,
        timedOut: false,
      })
    })
    const resolveExecutable = vi.fn((name: string) => (name === "npm" ? "/trusted/runtime/npm" : undefined))
    const fixture = await createProcessServiceFixture({
      nodeExecutable: "/trusted/runtime/node",
      resolveExecutable,
      forkSupervisor: forkStub(child),
    })

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable: "npm",
        args: ["test"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ exitCode: 0 })

    expect(resolveExecutable).toHaveBeenCalledWith("npm")
    expect(child.sent).toContainEqual(
      expect.objectContaining({ type: "start", executable: "/trusted/runtime/npm", args: ["test"] }),
    )
  })

  it("covers ready-wait success, protocol failures, exit, error, and timeout", async () => {
    const fixture = await createProcessServiceFixture()
    const service = internals(fixture.service)

    const ready = new ChildStub()
    const readyPromise = service.waitForMessage(ready as unknown as ChildProcess, "ready", 100)
    ready.emit("message", { type: "started", targetPid: 7 })
    ready.emit("message", { type: "ready" })
    await expect(readyPromise).resolves.toBeUndefined()

    const invalid = new ChildStub()
    const invalidPromise = service.waitForMessage(invalid as unknown as ChildProcess, "ready", 100)
    invalid.emit("message", { invalid: true })
    await expect(invalidPromise).rejects.toThrow("invalid message")

    const exited = new ChildStub()
    const exitPromise = service.waitForMessage(exited as unknown as ChildProcess, "ready", 100)
    exited.emit("exit", 1, null)
    await expect(exitPromise).rejects.toThrow("exited before becoming ready")

    const errored = new ChildStub()
    const errorPromise = service.waitForMessage(errored as unknown as ChildProcess, "ready", 100)
    errored.emit("error", new Error("spawn failed"))
    await expect(errorPromise).rejects.toThrow("failed to start with Node.js")

    const timedOut = new ChildStub()
    await expect(service.waitForMessage(timedOut as unknown as ChildProcess, "ready", 1)).rejects.toThrow(
      "did not become ready",
    )
  })

  it("covers immediate, event-driven, and timed exit waits", async () => {
    const fixture = await createProcessServiceFixture()
    const service = internals(fixture.service)

    const alreadyExited = new ChildStub()
    alreadyExited.exitCode = 0
    await expect(service.waitForExit(alreadyExited as unknown as ChildProcess, 100)).resolves.toBeUndefined()

    const exits = new ChildStub()
    const exitPromise = service.waitForExit(exits as unknown as ChildProcess, 100)
    queueMicrotask(() => exits.emit("exit", 0, null))
    await expect(exitPromise).resolves.toBeUndefined()

    const timedOut = new ChildStub()
    await expect(service.waitForExit(timedOut as unknown as ChildProcess, 1)).resolves.toBeUndefined()
  })

  it("formats restored and failed mutation diagnostics without leaking excess paths", async () => {
    const fixture = await createProcessServiceFixture()
    const service = internals(fixture.service)
    const restored = service.mutationError({
      changedPaths: ["a", "b", "c", "d", "e", "f"],
      restored: true,
      restorationFailures: 0,
      residuePaths: [],
    })
    expect(restored).toMatchObject({
      code: "INVALID_PHASE",
      action: expect.stringContaining("repeat with a read-only command"),
      details: { changedFiles: 6, restored: true, restorationFailures: 0, residueFiles: 0 },
    })
    expect(restored.message).toContain("a, b, c, d, e, ...")

    const failed = service.mutationError({
      changedPaths: ["src/a.ts"],
      restored: false,
      restorationFailures: 1,
      residuePaths: ["src/residue.ts"],
    })
    expect(failed).toMatchObject({
      code: "INVALID_PHASE",
      action: expect.stringContaining("recover the affected worktree"),
      details: { changedFiles: 1, restored: false, restorationFailures: 1, residueFiles: 1 },
    })
    expect(failed.message).toContain("review residue at src/residue.ts")

    expect(
      service.mutationError({
        changedPaths: ["src/a.ts"],
        restored: false,
        restorationFailures: 1,
        residuePaths: [],
      }).message,
    ).not.toContain("review residue")
  })

  it("handles accepted, rejected, empty, malformed, and registry-validated process records", async () => {
    const fixture = await createProcessServiceFixture()
    const service = internals(fixture.service)
    const append = vi.spyOn(service.dependencies.evidence, "append")
    const input: ProcessCaptureInput = {
      runId: fixture.runId,
      executable: process.execPath,
      args: [],
      cwd: fixture.projectRoot,
      env: {},
      timeoutMs: 100,
    }

    append.mockResolvedValue({ status: "rejected" })
    await expect(
      service.persistRecord({ kind: "truncated", stream: "stdout", maximumBytes: 8_192 }, input, "pre-fix"),
    ).resolves.toBe("ignored")
    await expect(
      service.persistRecord({ kind: "output", stream: "stderr", text: "visible" }, input, "pre-fix"),
    ).resolves.toBe("ignored")
    await expect(service.persistRecord({ kind: "output", stream: "stdout", text: "" }, input, "pre-fix")).resolves.toBe(
      "ignored",
    )
    await expect(
      service.persistRecord({ kind: "probe-candidate", stream: "stderr", value: { invalid: true } }, input, "pre-fix"),
    ).resolves.toBe("ignored")

    append.mockResolvedValue({ status: "accepted" })
    await expect(
      service.persistRecord({ kind: "truncated", stream: "stderr", maximumBytes: 8_192 }, input, "post-fix"),
    ).resolves.toBe("stderr")
    await expect(
      service.persistRecord({ kind: "output", stream: "stdout", text: "visible" }, input, "post-fix"),
    ).resolves.toBe("stdout")

    const validateEvent = vi.fn(async (value: unknown) => value)
    service.dependencies.probes = { validateEvent }
    const candidate = {
      schemaVersion: 1,
      sessionId: fixture.session.publicId,
      runId: fixture.runId,
      runLabel: "pre-fix",
      hypothesisId: "hyp_A",
      probeId: "probe_A",
      timestamp: "2026-07-13T00:00:00.000Z",
      message: "probe evidence",
      source: { file: "fixture.ts", line: 1 },
      data: { value: 42 },
    }
    await expect(
      service.persistRecord({ kind: "probe-candidate", stream: "stderr", value: candidate }, input, "pre-fix"),
    ).resolves.toBe("probe")
    expect(validateEvent).toHaveBeenCalledWith(candidate)

    append.mockResolvedValue({ status: "dropped" })
    await expect(
      service.persistRecord({ kind: "probe-candidate", stream: "stderr", value: candidate }, input, "pre-fix"),
    ).resolves.toBe("ignored")
  })

  it.each([
    {
      name: "reported failure",
      start: (child: ChildStub) => child.emit("message", { type: "failure", code: "FAILED", message: "reported" }),
      message: "reported",
    },
    {
      name: "invalid result message",
      start: (child: ChildStub) => child.emit("message", { invalid: true }),
      message: "invalid message",
    },
    {
      name: "supervisor error",
      start: (child: ChildStub) => child.emit("error", new Error("failed")),
      message: "failed to start",
    },
    {
      name: "unexpected nonzero exit",
      start: (child: ChildStub) => {
        child.exitCode = 1
        child.emit("exit", 1, null)
      },
      message: "exited unexpectedly",
    },
  ])("terminates and rejects a supervisor $name", async ({ start, message }) => {
    const child = new ChildStub(start)
    const fixture = await createProcessServiceFixture({ forkSupervisor: forkStub(child) })

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable: process.execPath,
        args: ["--version"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow(message)
    expect(child.sent).toContainEqual({ type: "terminate", reason: "capture-failed" })
  })

  it("sends an abort request for an already-aborted capture", async () => {
    const child = new ChildStub()
    const originalSend = child.send.bind(child)
    child.send = ((message: unknown) => {
      const result = originalSend(message)
      if ((message as { type?: string; reason?: string }).reason === "abort") {
        queueMicrotask(() =>
          child.emit("message", {
            type: "result",
            targetPid: 77,
            exitCode: null,
            signal: "SIGTERM",
            timedOut: false,
          }),
        )
      }
      return result
    }) as ChildStub["send"]
    const fixture = await createProcessServiceFixture({ forkSupervisor: forkStub(child) })
    const controller = new AbortController()
    controller.abort()

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable: process.execPath,
        args: ["--version"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 100,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ signal: "SIGTERM" })
    expect(child.sent).toContainEqual({ type: "terminate", reason: "abort" })
  })

  it("rejects a supervisor without a PID before waiting for readiness", async () => {
    const child = new ChildStub()
    child.pid = undefined
    child.connected = false
    const fixture = await createProcessServiceFixture({ forkSupervisor: forkStub(child) })

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable: process.execPath,
        args: ["--version"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 100,
      }),
    ).rejects.toThrow("did not receive a PID")
  })

  it("uses the default supervisor path and rejects unavailable result evidence", async () => {
    const fixture = await createProcessServiceFixture()
    const service = internals(fixture.service)
    delete service.dependencies.supervisorPath
    vi.spyOn(service.dependencies.evidence, "append").mockResolvedValue({ status: "rejected" })

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable: process.execPath,
        args: ["--version"],
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" })
  })
})
