import { type ChildProcess, spawn } from "node:child_process"
import { type ChildMessage, type ParentMessage, parseChildMessage, parseParentMessage } from "./protocol.js"
import { type TerminationResult, terminateTree } from "./tree.js"

let target: ChildProcess | undefined
let started = false
let finishing = false
let timedOut = false
let timeout: NodeJS.Timeout | undefined
let targetResult: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> | undefined

function safeSend(message: ChildMessage): void {
  const parsed = parseChildMessage(message)
  if (process.connected && process.send !== undefined) process.send(parsed)
}

function fail(code: string, message: string): void {
  safeSend({ type: "failure", code: code.slice(0, 128), message: message.slice(0, 512) })
}

async function finish(termination?: TerminationResult): Promise<void> {
  if (finishing) return
  finishing = true
  if (timeout !== undefined) clearTimeout(timeout)
  if (target === undefined || target.pid === undefined || targetResult === undefined) {
    process.exitCode = 1
    return
  }
  const result = await targetResult
  safeSend({
    type: "result",
    targetPid: target.pid,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    ...(termination === undefined ? {} : { termination }),
  })
  process.exit(0)
}

async function terminate(reason: string): Promise<void> {
  if (finishing) return
  if (target === undefined || target.pid === undefined) {
    fail("NO_TARGET", reason)
    process.exit(1)
  }
  const result = await terminateTree(target.pid)
  await finish(result)
}

function startTarget(message: Extract<ParentMessage, { type: "start" }>): void {
  if (started) {
    fail("SECOND_START", "The supervisor accepts exactly one start message")
    void terminate("second-start")
    return
  }
  started = true
  try {
    const child = spawn(message.executable, message.args, {
      cwd: message.cwd,
      env: { ...process.env, ...message.env },
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    target = child
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk))
    targetResult = new Promise((resolve) => {
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }))
    })
    child.once("error", () => {
      fail("TARGET_ERROR", "Target process emitted an error")
      void terminate("target-error")
    })
    if (child.pid === undefined) {
      fail("SPAWN_FAILED", "Target process did not receive a PID")
      process.exit(1)
    }
    safeSend({ type: "started", targetPid: child.pid })
  } catch {
    fail("SPAWN_FAILED", "Target process could not be started")
    process.exit(1)
  }
  timeout = setTimeout(() => {
    timedOut = true
    void terminate("timeout")
  }, message.timeoutMs)
  timeout.unref()
  void targetResult.then(() => finish())
}

if (process.send === undefined) {
  process.exitCode = 1
} else {
  safeSend({ type: "ready" })
  const startDeadline = setTimeout(() => {
    fail("START_TIMEOUT", "No start message arrived within two seconds")
    process.exit(1)
  }, 2_000)
  startDeadline.unref()

  process.on("message", (value: unknown) => {
    try {
      const message = parseParentMessage(value)
      if (message.type === "start") {
        clearTimeout(startDeadline)
        startTarget(message)
      } else {
        void terminate(message.reason)
      }
    } catch {
      fail("INVALID_MESSAGE", "Supervisor message was invalid")
      void terminate("invalid-message")
    }
  })
  process.once("disconnect", () => void terminate("parent-disconnect"))
  process.once("SIGTERM", () => void terminate("supervisor-sigterm"))
  process.once("uncaughtException", () => void terminate("uncaught-exception"))
  process.once("unhandledRejection", () => void terminate("unhandled-rejection"))
}
