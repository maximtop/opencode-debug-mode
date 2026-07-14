import { type ChildProcess, fork } from "node:child_process"
import path from "node:path"
import { onTestFinished } from "vitest"

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === type) {
        cleanup()
        resolve(message as Record<string, unknown>)
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`Supervisor exited before ${type}`))
    }
    const cleanup = () => {
      child.off("message", onMessage)
      child.off("exit", onExit)
    }
    child.on("message", onMessage)
    child.once("exit", onExit)
  })
}

export async function launchSupervisorHarness(_options: { fixture: "long-running-tree" }) {
  const child = fork(path.resolve("dist/process-supervisor.js"), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  await waitForMessage(child, "ready")
  const started = waitForMessage(child, "started")
  child.send({
    type: "start",
    executable: process.execPath,
    args: [
      "-e",
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)",
    ],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 30_000,
    ownerNonce: "a".repeat(43),
  })
  const startedMessage = await started
  const pid = Number(startedMessage.targetPid)
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  onTestFinished(async () => {
    if (child.connected) child.disconnect()
    if (!child.killed) child.kill("SIGKILL")
    await waitForPidExit(pid, 1_000)
  })
  return {
    targetPid: async () => pid,
    disconnect: () => child.disconnect(),
    exitCode: () => exit,
  }
}
