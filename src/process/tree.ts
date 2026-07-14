import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import { LIMITS } from "../core/constants.js"

export type Execute = (executable: string, args: string[]) => Promise<{ exitCode: number | null }>

export type TerminationResult = Readonly<{
  graceful: boolean
  forced: boolean
  remaining: boolean
  durationMs: number
  errors: string[]
}>

const defaultExecute: Execute = (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (exitCode) => resolve({ exitCode }))
  })

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function waitForExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = performance.now() + milliseconds
  while (performance.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  return !isAlive(pid)
}

function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === "string" ? code.slice(0, 64) : "termination-failed"
}

export async function terminateTree(
  targetPid: number,
  options: {
    platform?: NodeJS.Platform
    execute?: Execute
    gracefulMs?: number
    forceMs?: number
  } = {},
): Promise<TerminationResult> {
  const started = performance.now()
  const errors: string[] = []
  let graceful = false
  let forced = false
  const platform = options.platform ?? process.platform
  const gracefulMs = options.gracefulMs ?? LIMITS.gracefulKillMs
  const forceMs = options.forceMs ?? LIMITS.forcedKillMs

  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    return {
      graceful: false,
      forced: false,
      remaining: false,
      durationMs: performance.now() - started,
      errors: ["invalid-pid"],
    }
  }

  if (platform === "win32") {
    const execute = options.execute ?? defaultExecute
    try {
      const result = await execute("taskkill", ["/PID", String(targetPid), "/T"])
      graceful = result.exitCode === 0
    } catch (error) {
      errors.push(safeError(error))
    }
    await waitForExit(targetPid, gracefulMs)
    try {
      const result = await execute("taskkill", ["/PID", String(targetPid), "/T", "/F"])
      forced = result.exitCode === 0
    } catch (error) {
      errors.push(safeError(error))
    }
    await waitForExit(targetPid, forceMs)
  } else {
    try {
      process.kill(-targetPid, "SIGTERM")
      graceful = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { graceful: false, forced: false, remaining: false, durationMs: performance.now() - started, errors }
      }
      errors.push(safeError(error))
    }
    if (!(await waitForExit(targetPid, gracefulMs))) {
      try {
        process.kill(-targetPid, "SIGKILL")
        forced = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(safeError(error))
      }
      await waitForExit(targetPid, forceMs)
    }
  }

  return {
    graceful,
    forced,
    remaining: isAlive(targetPid),
    durationMs: performance.now() - started,
    errors,
  }
}
