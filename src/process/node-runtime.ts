import { spawnSync } from "node:child_process"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { DebugModeError } from "../core/errors.js"
import { sanitizeExecutablePath } from "./executable-resolver.js"

type RuntimeVersions = Readonly<Record<string, string | undefined>>

export type NodeRuntimeResolutionOptions = Readonly<{
  execPath?: string
  releaseName?: string
  versions?: RuntimeVersions
  pathValue?: string
  platform?: NodeJS.Platform
  fallbackDirectories?: readonly string[]
  validateCandidate?: (candidate: string) => string | undefined
}>

const DEFAULT_POSIX_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] as const

function defaultValidateCandidate(candidate: string): string | undefined {
  try {
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    const canonical = realpathSync(candidate)
    if (!statSync(canonical).isFile()) return undefined
    const checked = spawnSync(canonical, ["--version"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
      },
    })
    if (checked.status !== 0 || checked.error !== undefined) return undefined
    const major = /^v(\d+)(?:\.|$)/u.exec(checked.stdout.trim())?.[1]
    return major !== undefined && Number(major) >= 20 ? canonical : undefined
  } catch {
    return undefined
  }
}

function genuineNodeRuntime(releaseName: string | undefined, versions: RuntimeVersions): boolean {
  return (
    releaseName === "node" &&
    versions.node !== undefined &&
    versions.bun === undefined &&
    versions.electron === undefined
  )
}

export function resolveNodeRuntime(options: NodeRuntimeResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const delimiter = platform === "win32" ? ";" : ":"
  const executableName = platform === "win32" ? "node.exe" : "node"
  const execPath = options.execPath ?? process.execPath
  const releaseName = options.releaseName ?? process.release?.name
  const versions = options.versions ?? process.versions
  const pathValue = options.pathValue ?? process.env.PATH ?? ""
  const fallbackDirectories =
    options.fallbackDirectories ?? (platform === "win32" ? ([] as const) : DEFAULT_POSIX_DIRECTORIES)
  const validateCandidate = options.validateCandidate ?? defaultValidateCandidate
  const candidates: string[] = []

  if (genuineNodeRuntime(releaseName, versions) && pathApi.isAbsolute(execPath)) candidates.push(execPath)
  for (const entry of [...pathValue.split(delimiter), ...fallbackDirectories]) {
    if (entry.length === 0 || !pathApi.isAbsolute(entry)) continue
    candidates.push(pathApi.join(entry, executableName))
  }

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = platform === "win32" ? pathApi.normalize(candidate).toLowerCase() : pathApi.normalize(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    const resolved = validateCandidate(candidate)
    if (resolved !== undefined) return resolved
  }

  throw new DebugModeError(
    "PROCESS_START_FAILED",
    "A compatible Node.js 20 or newer runtime is required to supervise project checks",
    false,
    { action: "Install Node.js 20+ and expose node through an absolute PATH entry before restarting OpenCode" },
  )
}

export function sanitizedSupervisorEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  const allowed =
    /^(?:CI|COLORTERM|COMSPEC|FORCE_COLOR|HOME|LANG|LANGUAGE|LC_[A-Z0-9_]+|LOGNAME|NO_COLOR|PATH|PATHEXT|SHELL|SYSTEMROOT|TEMP|TERM|TMP|TMPDIR|TZ|USER|USERPROFILE|WINDIR)$/iu
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || !allowed.test(name)) continue
    if (name.toUpperCase() === "PATH") {
      const pathValue = sanitizeExecutablePath(value)
      if (pathValue !== "") sanitized[name] = pathValue
    } else {
      sanitized[name] = value
    }
  }
  return sanitized
}
