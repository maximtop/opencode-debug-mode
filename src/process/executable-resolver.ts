import { accessSync, constants, realpathSync, statSync } from "node:fs"
import path from "node:path"

export type ExecutableResolverOptions = Readonly<{
  pathValue?: string
  platform?: NodeJS.Platform
  fallbackDirectories?: readonly string[]
  allowDirectory?: (directory: string) => boolean
  validateCandidate?: (candidate: string) => string | undefined
}>

function validateExecutable(candidate: string, platform: NodeJS.Platform): string | undefined {
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK)
    const canonical = realpathSync(candidate)
    return statSync(canonical).isFile() ? canonical : undefined
  } catch {
    return undefined
  }
}

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || /\.(?:bat|cmd|exe)$/iu.test(name)) return [name]
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
}

export function absolutePathEntries(pathValue: string, platform: NodeJS.Platform = process.platform): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const delimiter = platform === "win32" ? ";" : ":"
  const seen = new Set<string>()
  const entries: string[] = []
  for (const entry of pathValue.split(delimiter)) {
    if (entry.length === 0 || !pathApi.isAbsolute(entry)) continue
    const normalized = pathApi.normalize(entry)
    const key = platform === "win32" ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(normalized)
  }
  return entries
}

export function sanitizeExecutablePath(pathValue: string, platform: NodeJS.Platform = process.platform): string {
  return absolutePathEntries(pathValue, platform).join(platform === "win32" ? ";" : ":")
}

export function resolveExecutablePath(name: string, options: ExecutableResolverOptions = {}): string | undefined {
  if (name.length === 0 || name.includes("\0") || name.includes("/") || name.includes("\\")) return undefined
  const platform = options.platform ?? process.platform
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const directories = absolutePathEntries(
    [options.pathValue ?? process.env.PATH ?? "", ...(options.fallbackDirectories ?? [])].join(
      platform === "win32" ? ";" : ":",
    ),
    platform,
  )
  const validate = options.validateCandidate ?? ((candidate: string) => validateExecutable(candidate, platform))
  for (const directory of directories) {
    if (options.allowDirectory?.(directory) === false) continue
    for (const executable of executableNames(name, platform)) {
      const resolved = validate(pathApi.join(directory, executable))
      if (resolved !== undefined) return resolved
    }
  }
  return undefined
}
