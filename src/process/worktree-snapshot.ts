import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { constants, createReadStream, type Stats } from "node:fs"
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { DebugModeError } from "../core/errors.js"
import { resolveExecutablePath } from "./executable-resolver.js"

const execFileAsync = promisify(execFile)

const MAX_PATHS = 100_000
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const TRUSTED_POSIX_GIT_DIRECTORIES = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"])
const FALLBACK_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".opencode-debug-mode",
  ".pnpm-store",
  ".turbo",
  ".vite",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
])

type SnapshotEntry =
  | Readonly<{ kind: "missing"; relativePath: string }>
  | Readonly<{ kind: "symlink"; relativePath: string; target: string }>
  | Readonly<{
      kind: "file"
      relativePath: string
      snapshotPath: string
      sha256: string
      bytes: number
      mode: number
    }>

export type WorktreeReconciliation = Readonly<{
  changedPaths: string[]
  restored: boolean
  restorationFailures: number
  residuePaths: string[]
}>

type Discovery = Readonly<{ mode: "git" | "fallback"; paths: string[] }>

type CurrentEntry =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unsafe-parent" }>
  | Readonly<{ kind: "unstable" }>
  | Readonly<{ kind: "symlink"; target: string; dev: number; ino: number; mode: number }>
  | Readonly<{
      kind: "file"
      sha256: string
      bytes: number
      mode: number
      dev: number
      ino: number
      mtimeMs: number
      ctimeMs: number
    }>
  | Readonly<{ kind: "other"; dev: number; ino: number; mode: number }>

type WorktreeSnapshotOptions = Readonly<{
  beforeRestore?: (relativePath: string) => void | Promise<void>
  gitPathValue?: string
}>

class RestoreConflict extends Error {
  constructor(readonly residuePath?: string) {
    super("Protected path changed during restoration")
  }
}

function pathHasPrefix(relativePath: string, prefix: string): boolean {
  return relativePath === prefix || relativePath.startsWith(`${prefix}${path.sep}`)
}

function safeRelativePath(projectRoot: string, candidate: string): string | undefined {
  if (candidate.length === 0 || candidate.includes("\0") || path.isAbsolute(candidate)) return undefined
  const normalized = path.normalize(candidate)
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return undefined
  const absolute = path.resolve(projectRoot, normalized)
  const relative = path.relative(projectRoot, absolute)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined
  }
  return relative
}

function snapshotLimit(message: string): DebugModeError {
  return new DebugModeError("PROCESS_START_FAILED", message, false, {
    action: "Narrow the active worktree or run the check outside Debug Mode after reviewing its mutation behavior",
  })
}

function addWindowsTrustedDirectory(directories: Set<string>, root: string | undefined, ...segments: string[]): void {
  if (root === undefined || !path.win32.isAbsolute(root)) return
  directories.add(path.win32.normalize(path.win32.join(root, ...segments)).toLowerCase())
}

export function isTrustedGitDirectory(
  directory: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "win32") return TRUSTED_POSIX_GIT_DIRECTORIES.has(path.posix.normalize(directory))
  const normalized = path.win32.normalize(directory).toLowerCase()
  const trusted = new Set<string>()
  for (const systemRoot of [environment.SystemRoot, environment.SYSTEMROOT, environment.WINDIR, "C:\\Windows"]) {
    addWindowsTrustedDirectory(trusted, systemRoot, "System32")
  }
  for (const programFiles of [
    environment.ProgramFiles,
    environment.ProgramW6432,
    environment["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ]) {
    addWindowsTrustedDirectory(trusted, programFiles, "Git", "cmd")
    addWindowsTrustedDirectory(trusted, programFiles, "Git", "bin")
  }
  return trusted.has(normalized)
}

export function resolveTrustedGitExecutable(
  pathValue: string = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return resolveExecutablePath("git", {
    pathValue,
    platform,
    fallbackDirectories: platform === "win32" ? [] : [...TRUSTED_POSIX_GIT_DIRECTORIES],
    allowDirectory: (directory) => isTrustedGitDirectory(directory, platform),
  })
}

function gitInspectionEnvironment(gitExecutable: string): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null"
  const environment: NodeJS.ProcessEnv = {
    PATH: [path.dirname(gitExecutable), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(
      path.delimiter,
    ),
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_TERMINAL_PROMPT: "0",
  }
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

async function gitOutput(projectRoot: string, gitExecutable: string, args: string[]): Promise<string> {
  const result = await execFileAsync(gitExecutable, ["-c", "core.fsmonitor=false", "-C", projectRoot, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: gitInspectionEnvironment(gitExecutable),
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: 10_000,
    windowsHide: true,
  })
  return result.stdout
}

async function discoverWithGit(projectRoot: string, gitExecutable: string | undefined): Promise<string[] | undefined> {
  if (gitExecutable === undefined) return undefined
  try {
    const topLevel = (await gitOutput(projectRoot, gitExecutable, ["rev-parse", "--show-toplevel"])).trim()
    if ((await realpath(topLevel)) !== projectRoot) return undefined
    const output = await gitOutput(projectRoot, gitExecutable, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ])
    return output.split("\0").flatMap((candidate) => {
      const safe = safeRelativePath(projectRoot, candidate)
      return safe === undefined ? [] : [safe]
    })
  } catch {
    return undefined
  }
}

async function discoverFallback(projectRoot: string): Promise<string[]> {
  const discovered: string[] = []
  const pending = [""]
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()
    if (relativeDirectory === undefined) break
    const absoluteDirectory = path.join(projectRoot, relativeDirectory)
    const entries = await readdir(absoluteDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && FALLBACK_EXCLUDED_DIRECTORIES.has(entry.name)) continue
      const candidate = path.join(relativeDirectory, entry.name)
      const safe = safeRelativePath(projectRoot, candidate)
      if (safe === undefined) continue
      if (entry.isDirectory()) pending.push(safe)
      else discovered.push(safe)
      if (discovered.length + pending.length > MAX_PATHS) {
        throw snapshotLimit(`The supervised worktree exceeds the ${MAX_PATHS} path snapshot limit`)
      }
    }
  }
  return discovered
}

async function discover(
  projectRoot: string,
  preferredMode?: Discovery["mode"],
  gitExecutable?: string,
): Promise<Discovery> {
  if (preferredMode !== "fallback") {
    const gitPaths = await discoverWithGit(projectRoot, gitExecutable)
    if (gitPaths !== undefined) return { mode: "git", paths: [...new Set(gitPaths)].sort() }
    if (preferredMode === "git") {
      throw new DebugModeError("PROCESS_START_FAILED", "The protected Git worktree could not be inspected", true, {
        action: "Restore Git worktree access and repeat the supervised capture",
      })
    }
  }
  return { mode: "fallback", paths: [...new Set(await discoverFallback(projectRoot))].sort() }
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filename)
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolve)
  })
  return hash.digest("hex")
}

async function hasUnsafeParent(projectRoot: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split(path.sep).slice(0, -1)
  let current = projectRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const status = await lstat(current)
      if (!status.isDirectory() || status.isSymbolicLink()) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
      throw error
    }
  }
  return false
}

function sameStatus(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function currentEntry(projectRoot: string, relativePath: string): Promise<CurrentEntry> {
  if (await hasUnsafeParent(projectRoot, relativePath)) return { kind: "unsafe-parent" }
  const filename = path.join(projectRoot, relativePath)
  let before: Stats
  try {
    before = await lstat(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    throw error
  }
  if (before.isSymbolicLink()) {
    const target = await readlink(filename)
    const after = await lstat(filename).catch(() => undefined)
    if (after === undefined || !sameStatus(before, after)) return { kind: "unstable" }
    return { kind: "symlink", target, dev: before.dev, ino: before.ino, mode: before.mode }
  }
  if (before.isFile()) {
    const digest = await sha256(filename)
    const after = await lstat(filename).catch(() => undefined)
    if (after === undefined || !sameStatus(before, after)) return { kind: "unstable" }
    return {
      kind: "file",
      sha256: digest,
      bytes: before.size,
      mode: before.mode & 0o777,
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    }
  }
  return { kind: "other", dev: before.dev, ino: before.ino, mode: before.mode }
}

function matchesSnapshot(entry: SnapshotEntry, current: CurrentEntry): boolean {
  if (entry.kind === "missing") return current.kind === "missing"
  if (entry.kind === "symlink") return current.kind === "symlink" && current.target === entry.target
  return (
    current.kind === "file" &&
    current.bytes === entry.bytes &&
    current.mode === entry.mode &&
    current.sha256 === entry.sha256
  )
}

function sameCurrentEntry(left: CurrentEntry, right: CurrentEntry): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "missing" || left.kind === "unsafe-parent" || left.kind === "unstable") return true
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  }
  if (left.kind === "file" && right.kind === "file") {
    return (
      left.sha256 === right.sha256 &&
      left.bytes === right.bytes &&
      left.mode === right.mode &&
      left.dev === right.dev &&
      left.ino === right.ino
    )
  }
  return left.kind === "other" && right.kind === "other" && left.dev === right.dev && left.ino === right.ino
}

async function installSnapshotExclusive(entry: SnapshotEntry, destination: string): Promise<void> {
  if (entry.kind === "missing") return
  if (entry.kind === "symlink") {
    await symlink(entry.target, destination)
    return
  }
  let created = false
  try {
    await copyFile(entry.snapshotPath, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    created = true
    await chmod(destination, entry.mode)
  } catch (error) {
    if (created) await rm(destination, { force: true }).catch(() => undefined)
    throw error
  }
}

async function restoreQuarantine(quarantine: string, destination: string, observed: CurrentEntry): Promise<boolean> {
  try {
    if (observed.kind === "file") {
      await link(quarantine, destination)
    } else if (observed.kind === "symlink") {
      await symlink(observed.target, destination)
    } else {
      return false
    }
    await rm(quarantine, { force: true })
    return true
  } catch {
    return false
  }
}

async function restoreEntry(projectRoot: string, entry: SnapshotEntry, observed: CurrentEntry): Promise<void> {
  if (observed.kind === "unsafe-parent" || observed.kind === "unstable" || observed.kind === "other") {
    throw new RestoreConflict(entry.relativePath)
  }
  if (await hasUnsafeParent(projectRoot, entry.relativePath)) throw new RestoreConflict(entry.relativePath)
  const destination = path.join(projectRoot, entry.relativePath)
  if (observed.kind === "missing") {
    try {
      await installSnapshotExclusive(entry, destination)
      return
    } catch {
      throw new RestoreConflict(entry.relativePath)
    }
  }

  const quarantine = path.join(path.dirname(destination), `.opencode-debug-residue-${randomBytes(12).toString("hex")}`)
  const quarantineRelative = path.relative(projectRoot, quarantine)
  try {
    await rename(destination, quarantine)
  } catch {
    throw new RestoreConflict(entry.relativePath)
  }
  const quarantined = await currentEntry(projectRoot, quarantineRelative).catch(
    (): CurrentEntry => ({ kind: "unstable" }),
  )
  if (!sameCurrentEntry(observed, quarantined)) {
    if (await restoreQuarantine(quarantine, destination, quarantined)) {
      throw new RestoreConflict(entry.relativePath)
    }
    throw new RestoreConflict(quarantineRelative)
  }

  if (entry.kind === "missing") {
    await rm(quarantine, { force: true })
    if ((await currentEntry(projectRoot, entry.relativePath)).kind !== "missing") {
      throw new RestoreConflict(entry.relativePath)
    }
    return
  }

  try {
    await installSnapshotExclusive(entry, destination)
  } catch {
    if (await restoreQuarantine(quarantine, destination, quarantined)) {
      throw new RestoreConflict(entry.relativePath)
    }
    throw new RestoreConflict(quarantineRelative)
  }
  try {
    await rm(quarantine, { force: true })
  } catch {
    throw new RestoreConflict(quarantineRelative)
  }
}

export class WorktreeSnapshot {
  private reconciled = false

  private constructor(
    private readonly projectRoot: string,
    private readonly snapshotRoot: string,
    private readonly mode: Discovery["mode"],
    private readonly entries: SnapshotEntry[],
    private readonly initialPaths: Set<string>,
    private readonly excludedPrefixes: string[],
    private readonly gitExecutable: string | undefined,
    private readonly options: WorktreeSnapshotOptions,
  ) {}

  static async create(
    projectRootInput: string,
    storageRoot: string,
    options: WorktreeSnapshotOptions = {},
  ): Promise<WorktreeSnapshot> {
    const projectRoot = await realpath(projectRootInput)
    const gitExecutable = resolveTrustedGitExecutable(options.gitPathValue)
    const requestedStorage = await realpath(storageRoot).catch(() => path.resolve(storageRoot))
    const relativeStorage = path.relative(projectRoot, requestedStorage)
    const excludedPrefixes =
      relativeStorage !== "" &&
      relativeStorage !== ".." &&
      !relativeStorage.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeStorage)
        ? [relativeStorage]
        : []
    const temporaryRoot = await realpath(tmpdir())
    const relativeTemporaryRoot = path.relative(projectRoot, temporaryRoot)
    if (
      relativeTemporaryRoot === "" ||
      (!relativeTemporaryRoot.startsWith(`..${path.sep}`) &&
        relativeTemporaryRoot !== ".." &&
        !path.isAbsolute(relativeTemporaryRoot))
    ) {
      throw snapshotLimit("The protected snapshot directory must be outside the active project")
    }
    const snapshotRoot = await mkdtemp(path.join(temporaryRoot, "opencode-debug-capture-"))
    try {
      const discovered = await discover(projectRoot, undefined, gitExecutable)
      const discovery = {
        ...discovered,
        paths: discovered.paths.filter(
          (relativePath) => !excludedPrefixes.some((prefix) => pathHasPrefix(relativePath, prefix)),
        ),
      }
      if (discovery.paths.length > MAX_PATHS) {
        throw snapshotLimit(`The supervised worktree exceeds the ${MAX_PATHS} path snapshot limit`)
      }
      const entries: SnapshotEntry[] = []
      let totalBytes = 0
      for (let index = 0; index < discovery.paths.length; index += 1) {
        const relativePath = discovery.paths[index]
        if (relativePath === undefined) continue
        const source = path.join(projectRoot, relativePath)
        let status: Stats
        try {
          status = await lstat(source)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            entries.push({ kind: "missing", relativePath })
            continue
          }
          throw error
        }
        if (status.isSymbolicLink()) {
          entries.push({ kind: "symlink", relativePath, target: await readlink(source) })
          continue
        }
        if (!status.isFile()) continue
        totalBytes += status.size
        if (totalBytes > MAX_SNAPSHOT_BYTES) {
          throw snapshotLimit("The supervised worktree exceeds the 1 GiB protected-file snapshot limit")
        }
        const snapshotPath = path.join(snapshotRoot, String(index))
        await copyFile(source, snapshotPath, constants.COPYFILE_FICLONE)
        entries.push({
          kind: "file",
          relativePath,
          snapshotPath,
          sha256: await sha256(snapshotPath),
          bytes: status.size,
          mode: status.mode & 0o777,
        })
      }
      return new WorktreeSnapshot(
        projectRoot,
        snapshotRoot,
        discovery.mode,
        entries,
        new Set(discovery.paths),
        excludedPrefixes,
        gitExecutable,
        options,
      )
    } catch (error) {
      await rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof DebugModeError) throw error
      throw new DebugModeError("PROCESS_START_FAILED", "The protected worktree snapshot could not be created", true, {
        action: "Check project file permissions and repeat the supervised capture",
      })
    }
  }

  async reconcile(): Promise<WorktreeReconciliation> {
    if (this.reconciled) throw new Error("Worktree snapshot was already reconciled")
    this.reconciled = true
    const changed = new Set<string>()
    const failed = new Set<string>()
    const residues = new Set<string>()

    for (const entry of [...this.entries].sort((left, right) => left.relativePath.length - right.relativePath.length)) {
      try {
        const observed = await currentEntry(this.projectRoot, entry.relativePath)
        if (matchesSnapshot(entry, observed)) continue
        changed.add(entry.relativePath)
        await this.options.beforeRestore?.(entry.relativePath)
        await restoreEntry(this.projectRoot, entry, observed)
      } catch (error) {
        changed.add(entry.relativePath)
        failed.add(entry.relativePath)
        if (error instanceof RestoreConflict && error.residuePath !== undefined) {
          residues.add(error.residuePath)
        }
      }
    }

    try {
      const current = await discover(this.projectRoot, this.mode, this.gitExecutable)
      for (const relativePath of current.paths) {
        if (this.excludedPrefixes.some((prefix) => pathHasPrefix(relativePath, prefix))) continue
        if (this.initialPaths.has(relativePath)) continue
        if (path.basename(relativePath).startsWith(".opencode-debug-residue-")) continue
        changed.add(relativePath)
        try {
          const observed = await currentEntry(this.projectRoot, relativePath)
          if (observed.kind === "missing") continue
          await this.options.beforeRestore?.(relativePath)
          await restoreEntry(this.projectRoot, { kind: "missing", relativePath }, observed)
        } catch (error) {
          failed.add(relativePath)
          if (error instanceof RestoreConflict && error.residuePath !== undefined) {
            residues.add(error.residuePath)
          }
        }
      }
    } catch {
      failed.add("<worktree-discovery>")
    }

    for (const entry of this.entries) {
      try {
        if (!matchesSnapshot(entry, await currentEntry(this.projectRoot, entry.relativePath))) {
          failed.add(entry.relativePath)
        }
      } catch {
        failed.add(entry.relativePath)
      }
    }

    const result = {
      changedPaths: [...changed].sort(),
      restored: failed.size === 0,
      restorationFailures: failed.size,
      residuePaths: [...residues].sort(),
    }
    if (result.restored) await this.dispose()
    return result
  }

  async dispose(): Promise<void> {
    await rm(this.snapshotRoot, { recursive: true, force: true })
  }
}
