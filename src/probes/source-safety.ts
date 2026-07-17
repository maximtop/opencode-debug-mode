import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { DebugModeError } from "../core/errors.js"
import { isContained } from "../session/paths.js"

type LexicalMode = "code" | "single" | "double" | "template" | "line-comment" | "block-comment" | "regex"

export type SourceCodeContext = Readonly<{
  inCode: boolean
  braceDepth: number
  innermostDelimiter?: "(" | "[" | "{"
}>

function unsafe(message: string): never {
  throw new DebugModeError("HELPER_PATH_UNSAFE", message)
}

function noFollowFlags(writable: boolean): number {
  return (writable ? constants.O_RDWR : constants.O_RDONLY) | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
}

function sameFile(
  left: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

type CanonicalLocation = Readonly<{ root: string; absolute: string }>

type CanonicalRootPin = Readonly<{
  requestedRoot: string
  root: string
  handle: FileHandle
  identity: Readonly<{ dev: number | bigint; ino: number | bigint }>
}>

export class ProjectFileRewriteRollbackError extends DebugModeError {
  readonly filename: string

  constructor(filename: string, residuePath?: string) {
    super("CLEANUP_PARTIAL", "Project file rewrite failed and the original file could not be restored safely", false, {
      action:
        residuePath === undefined
          ? `Inspect ${filename} before continuing`
          : `Restore ${filename} from the transaction residue at ${residuePath}`,
      details: { path: filename, ...(residuePath === undefined ? {} : { residuePath }) },
    })
    this.name = "ProjectFileRewriteRollbackError"
    this.filename = filename
  }
}

function directoryOpenFlags(): number {
  return constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_DIRECTORY | constants.O_NOFOLLOW)
}

async function pinCanonicalRoot(projectRoot: string): Promise<CanonicalRootPin> {
  const requestedRoot = path.resolve(projectRoot)
  const root = await realpath(projectRoot)
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(root)
  } catch {
    return unsafe("Canonical project root could not be inspected safely")
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    return unsafe("Canonical project root must be a symlink-free directory")
  }
  let handle: FileHandle
  try {
    handle = await open(root, directoryOpenFlags())
  } catch {
    return unsafe("Canonical project root could not be pinned safely")
  }
  try {
    const [opened, after, canonical] = await Promise.all([handle.stat(), lstat(root), realpath(root)])
    if (
      !opened.isDirectory() ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      canonical !== root ||
      !sameFile(before, opened) ||
      !sameFile(after, opened)
    ) {
      return unsafe("Canonical project root changed identity while it was being pinned")
    }
    return { requestedRoot, root, handle, identity: opened }
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (error instanceof DebugModeError) throw error
    return unsafe("Canonical project root changed while it was being pinned")
  }
}

async function rootPinHasCanonicalIdentity(pin: CanonicalRootPin): Promise<boolean> {
  const [opened, after, canonical] = await Promise.all([pin.handle.stat(), lstat(pin.root), realpath(pin.root)])
  return (
    opened.isDirectory() &&
    !after.isSymbolicLink() &&
    after.isDirectory() &&
    canonical === pin.root &&
    sameFile(pin.identity, opened) &&
    sameFile(after, opened)
  )
}

function pinnedLocation(pin: CanonicalRootPin, filename: string): CanonicalLocation {
  const requested = path.resolve(filename)
  const absolute = isContained(pin.requestedRoot, requested)
    ? path.resolve(pin.root, path.relative(pin.requestedRoot, requested))
    : requested
  if (!isContained(pin.root, absolute)) unsafe("Project file path must remain inside the canonical project root")
  return { root: pin.root, absolute }
}

async function canonicalLocation(projectRoot: string, filename: string): Promise<CanonicalLocation> {
  const requestedRoot = path.resolve(projectRoot)
  const root = await realpath(projectRoot)
  const requested = path.resolve(filename)
  const absolute = isContained(requestedRoot, requested)
    ? path.resolve(root, path.relative(requestedRoot, requested))
    : requested
  if (!isContained(root, absolute)) unsafe("Project file path must remain inside the canonical project root")
  return { root, absolute }
}

async function canonicalDirectoryChain(
  root: string,
  directory: string,
  createMissing: boolean,
): Promise<"ready" | "missing"> {
  const relative = path.relative(root, directory)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return unsafe("Project file parent must remain inside the canonical project root")
  }

  let rootInfo: Awaited<ReturnType<typeof lstat>>
  let canonicalRoot: string
  try {
    ;[rootInfo, canonicalRoot] = await Promise.all([lstat(root), realpath(root)])
  } catch {
    return unsafe("Canonical project root could not be revalidated safely")
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || canonicalRoot !== root) {
    return unsafe("Canonical project root changed identity")
  }
  if (relative === "") return "ready"

  let current = root
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return unsafe("Project file parent could not be inspected safely")
      }
      if (!createMissing) return "missing"
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          return unsafe("Project file parent could not be created safely")
        }
      }
      try {
        info = await lstat(current)
      } catch {
        return unsafe("Project file parent changed while it was being created")
      }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return unsafe("Project file parent components must be symlink-free directories")
    }
    let canonical: string
    try {
      canonical = await realpath(current)
    } catch {
      return unsafe("Project file parent could not be resolved safely")
    }
    if (canonical !== current || !isContained(root, canonical)) {
      return unsafe("Project file parent components must remain canonical and inside the project")
    }
  }
  return "ready"
}

async function checkedExistingLocation(projectRoot: string, filename: string): Promise<CanonicalLocation | undefined> {
  const location = await canonicalLocation(projectRoot, filename)
  if ((await canonicalDirectoryChain(location.root, path.dirname(location.absolute), false)) === "missing") {
    return undefined
  }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(location.absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return unsafe("Project file could not be inspected safely")
  }
  if (info.isSymbolicLink() || !info.isFile()) unsafe("Project file must be a regular symlink-free file")
  let canonical: string
  try {
    canonical = await realpath(location.absolute)
  } catch {
    return unsafe("Project file could not be resolved safely")
  }
  if (canonical !== location.absolute || !isContained(location.root, canonical)) {
    return unsafe("Project file path must remain canonical and inside the project")
  }
  return location
}

async function checkedHandle(projectRoot: string, filename: string, writable = false): Promise<FileHandle> {
  const location = await checkedExistingLocation(projectRoot, filename)
  if (location === undefined) return unsafe("Probe source is not a readable project file")
  const { root: canonicalRoot, absolute } = location

  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(absolute)
  } catch {
    return unsafe("Probe source is not a readable project file")
  }
  if (before.isSymbolicLink() || !before.isFile()) unsafe("Probe source must be a regular symlink-free file")

  let canonical: string
  try {
    canonical = await realpath(absolute)
  } catch {
    return unsafe("Probe source is not a readable project file")
  }
  if (canonical !== absolute || !isContained(canonicalRoot, canonical)) {
    unsafe("Probe source path must remain canonical and inside the project")
  }

  let handle: FileHandle
  try {
    handle = await open(absolute, noFollowFlags(writable))
  } catch {
    return unsafe("Probe source could not be opened without following links")
  }
  try {
    await canonicalDirectoryChain(canonicalRoot, path.dirname(absolute), false)
    const [opened, after, currentCanonical] = await Promise.all([handle.stat(), lstat(absolute), realpath(absolute)])
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      currentCanonical !== absolute ||
      currentCanonical !== canonical ||
      !isContained(canonicalRoot, currentCanonical) ||
      !sameFile(before, opened) ||
      !sameFile(after, opened)
    ) {
      unsafe("Probe source changed identity or escaped the project")
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (error instanceof DebugModeError) throw error
    return unsafe("Probe source changed while it was being checked")
  }
}

async function handleHasCanonicalIdentity(location: CanonicalLocation, handle: FileHandle): Promise<boolean> {
  try {
    await canonicalDirectoryChain(location.root, path.dirname(location.absolute), false)
    const [opened, after, canonical] = await Promise.all([
      handle.stat(),
      lstat(location.absolute),
      realpath(location.absolute),
    ])
    return (
      !after.isSymbolicLink() &&
      after.isFile() &&
      canonical === location.absolute &&
      isContained(location.root, canonical) &&
      sameFile(after, opened)
    )
  } catch {
    return false
  }
}

async function writeExactContents(handle: FileHandle, content: Buffer): Promise<void> {
  let offset = 0
  while (offset < content.byteLength) {
    const { bytesWritten } = await handle.write(content, offset, content.byteLength - offset, offset)
    if (bytesWritten <= 0) throw new Error("Project file write made no progress")
    offset += bytesWritten
  }
  await handle.truncate(content.byteLength)
}

async function handleHasExactContents(handle: FileHandle, expected: Buffer): Promise<boolean> {
  const info = await handle.stat()
  if (info.size !== expected.byteLength) return false
  const actual = Buffer.alloc(expected.byteLength)
  let offset = 0
  while (offset < actual.byteLength) {
    const { bytesRead } = await handle.read(actual, offset, actual.byteLength - offset, offset)
    if (bytesRead <= 0) return false
    offset += bytesRead
  }
  return actual.equals(expected)
}

function transactionPath(location: CanonicalLocation, operation: string): string {
  return path.join(path.dirname(location.absolute), `.opencode-debug-mode-${operation}-${process.pid}-${randomUUID()}`)
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(directory, directoryOpenFlags())
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function quarantineAndUnlinkHandle(
  location: CanonicalLocation,
  handle: FileHandle,
  operation: string,
): Promise<boolean> {
  if (!(await handleHasCanonicalIdentity(location, handle))) return false
  const quarantine = transactionPath(location, operation)
  try {
    await rename(location.absolute, quarantine)
  } catch {
    return false
  }
  let quarantined = true
  try {
    await canonicalDirectoryChain(location.root, path.dirname(quarantine), false)
    const [opened, moved, canonical] = await Promise.all([handle.stat(), lstat(quarantine), realpath(quarantine)])
    if (
      moved.isSymbolicLink() ||
      !moved.isFile() ||
      canonical !== quarantine ||
      !isContained(location.root, canonical) ||
      !sameFile(moved, opened)
    ) {
      if (!(await restoreQuarantinedFile(quarantine, location.absolute))) return false
      quarantined = false
      return false
    }
    await unlink(quarantine)
    quarantined = false
    await syncDirectory(path.dirname(location.absolute))
    return true
  } catch {
    if (quarantined) await restoreQuarantinedFile(quarantine, location.absolute)
    return false
  }
}

async function createExclusiveCanonicalFile(
  location: CanonicalLocation,
  content: Buffer,
  mode: number,
): Promise<FileHandle> {
  await canonicalDirectoryChain(location.root, path.dirname(location.absolute), false)
  const flags =
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  const handle = await open(location.absolute, flags, mode)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) unsafe("New project file is not a regular file")
    await handle.chmod(mode)
    await writeExactContents(handle, content)
    await handle.sync()
    if (!(await handleHasExactContents(handle, content)) || !(await handleHasCanonicalIdentity(location, handle))) {
      unsafe("New project file changed identity or contents while it was being staged")
    }
    return handle
  } catch (error) {
    if (!(await quarantineAndUnlinkHandle(location, handle, "failed-create"))) {
      await handle.close().catch(() => undefined)
      throw new DebugModeError(
        "CLEANUP_PARTIAL",
        "A newly created project file could not be removed after creation failed",
        false,
        {
          action: `Inspect and remove the transaction residue at ${location.absolute}`,
          details: { path: location.absolute },
        },
      )
    }
    await handle.close().catch(() => undefined)
    throw error
  }
}

/** Returns whether a regular file exists without accepting symlinked path components. */
export async function canonicalProjectFileExists(projectRoot: string, filename: string): Promise<boolean> {
  return (await checkedExistingLocation(projectRoot, filename)) !== undefined
}

/** Creates a new project file without recursive mkdir or link-following leaf opens. */
export async function createCanonicalProjectFile(
  projectRoot: string,
  filename: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const rootPin = await pinCanonicalRoot(projectRoot)
  let location: CanonicalLocation
  try {
    location = pinnedLocation(rootPin, filename)
  } catch (error) {
    await rootPin.handle.close().catch(() => undefined)
    throw error
  }
  let handle: FileHandle | undefined
  try {
    if (!(await rootPinHasCanonicalIdentity(rootPin))) unsafe("Canonical project root changed before file creation")
    await canonicalDirectoryChain(location.root, path.dirname(location.absolute), true)
    if (!(await rootPinHasCanonicalIdentity(rootPin))) unsafe("Canonical project root changed before file creation")
    handle = await createExclusiveCanonicalFile(location, Buffer.from(content), mode)
    await canonicalDirectoryChain(location.root, path.dirname(location.absolute), false)
    if (!(await rootPinHasCanonicalIdentity(rootPin)) || !(await handleHasCanonicalIdentity(location, handle))) {
      unsafe("New project file or project root changed identity")
    }
    await syncDirectory(path.dirname(location.absolute))
  } catch (error) {
    if (handle !== undefined) {
      if (!(await quarantineAndUnlinkHandle(location, handle, "failed-create"))) {
        throw new DebugModeError(
          "CLEANUP_PARTIAL",
          "A newly created project file could not be removed after creation failed",
          false,
          {
            action: `Inspect and remove the transaction residue at ${location.absolute}`,
            details: { path: location.absolute },
          },
        )
      }
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
    await rootPin.handle.close().catch(() => undefined)
  }
}

export type ExactProjectFileRemoval = "success" | "already-clean" | "content-mismatch"

async function restoreQuarantinedFile(quarantine: string, original: string): Promise<boolean> {
  try {
    // link() creates the destination only when it is still absent, unlike rename()
    // on POSIX which could overwrite a new entry installed by a concurrent writer.
    await link(quarantine, original)
    await unlink(quarantine)
    return true
  } catch {
    return false
  }
}

/** Removes a hash-owned file only while its full path and inode remain canonical. */
export async function removeExactCanonicalProjectFile(
  projectRoot: string,
  filename: string,
  expectedSha256: string,
  expectedBytes: number,
): Promise<ExactProjectFileRemoval> {
  const location = await checkedExistingLocation(projectRoot, filename)
  if (location === undefined) return "already-clean"
  const handle = await checkedHandle(location.root, location.absolute)
  try {
    const content = await handle.readFile()
    if (content.byteLength !== expectedBytes || createHash("sha256").update(content).digest("hex") !== expectedSha256) {
      return "content-mismatch"
    }
    if (!(await handleHasCanonicalIdentity(location, handle))) {
      return unsafe("Owned project file changed identity before removal")
    }

    const quarantine = path.join(
      path.dirname(location.absolute),
      `.opencode-debug-mode-delete-${process.pid}-${randomUUID()}`,
    )
    try {
      await rename(location.absolute, quarantine)
    } catch {
      return unsafe("Owned project file changed while it was being quarantined")
    }

    let quarantined = true
    try {
      await canonicalDirectoryChain(location.root, path.dirname(quarantine), false)
      const [opened, moved, canonical] = await Promise.all([handle.stat(), lstat(quarantine), realpath(quarantine)])
      if (
        moved.isSymbolicLink() ||
        !moved.isFile() ||
        canonical !== quarantine ||
        !isContained(location.root, canonical) ||
        !sameFile(moved, opened)
      ) {
        if (!(await restoreQuarantinedFile(quarantine, location.absolute))) {
          return unsafe("A replaced project file could not be restored after quarantine")
        }
        quarantined = false
        return unsafe("Owned project file changed identity while it was being quarantined")
      }
      await unlink(quarantine)
      quarantined = false
      return "success"
    } catch (error) {
      if (quarantined && !(await restoreQuarantinedFile(quarantine, location.absolute))) {
        return unsafe("Owned project file could not be restored after a failed removal")
      }
      throw error
    }
  } finally {
    await handle.close()
  }
}

export async function canonicalProjectFile(projectRoot: string, filename: string): Promise<string> {
  const location = await canonicalLocation(projectRoot, filename)
  const handle = await checkedHandle(location.root, location.absolute)
  try {
    return location.absolute
  } finally {
    await handle.close()
  }
}

export async function readCanonicalProjectFile(projectRoot: string, filename: string): Promise<string> {
  const handle = await checkedHandle(projectRoot, filename)
  try {
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

class StaleProjectRewrite extends Error {}

async function rollbackCommittedRewrite(input: {
  location: CanonicalLocation
  originalHandle: FileHandle
  original: Buffer
  backupLocation: CanonicalLocation
  stagedHandle: FileHandle
  stageLocation: CanonicalLocation
  stagePathPresent: boolean
  replacement: Buffer
}): Promise<boolean> {
  if (
    !(await handleHasCanonicalIdentity(input.location, input.stagedHandle)) ||
    !(await handleHasExactContents(input.stagedHandle, input.replacement))
  ) {
    return false
  }

  const failedLocation = {
    root: input.location.root,
    absolute: transactionPath(input.location, "rewrite-failed"),
  }
  try {
    await rename(input.location.absolute, failedLocation.absolute)
  } catch {
    return false
  }
  if (!(await handleHasCanonicalIdentity(failedLocation, input.stagedHandle))) {
    await restoreQuarantinedFile(failedLocation.absolute, input.location.absolute)
    return false
  }

  try {
    // Hard-link restore is no-replace: it never overwrites a concurrent writer.
    await link(input.backupLocation.absolute, input.location.absolute)
  } catch {
    await restoreQuarantinedFile(failedLocation.absolute, input.location.absolute)
    return false
  }
  if (
    !(await handleHasCanonicalIdentity(input.location, input.originalHandle)) ||
    !(await handleHasExactContents(input.originalHandle, input.original))
  ) {
    return false
  }

  const cleanupResults = await Promise.all([
    quarantineAndUnlinkHandle(input.backupLocation, input.originalHandle, "rewrite-rollback-backup"),
    quarantineAndUnlinkHandle(failedLocation, input.stagedHandle, "rewrite-rollback-stage"),
    ...(input.stagePathPresent
      ? [quarantineAndUnlinkHandle(input.stageLocation, input.stagedHandle, "rewrite-rollback-staged-link")]
      : []),
  ])
  if (cleanupResults.some((removed) => !removed)) return false
  await syncDirectory(path.dirname(input.location.absolute))
  return true
}

export async function rewriteCanonicalProjectFile(
  projectRoot: string,
  filename: string,
  expected: string,
  replacement: string,
): Promise<boolean> {
  const rootPin = await pinCanonicalRoot(projectRoot)
  let location: CanonicalLocation
  let handle: FileHandle
  try {
    location = pinnedLocation(rootPin, filename)
    handle = await checkedHandle(location.root, location.absolute)
  } catch (error) {
    await rootPin.handle.close().catch(() => undefined)
    throw error
  }
  let stagedHandle: FileHandle | undefined
  let stageLocation: CanonicalLocation | undefined
  let backupLocation: CanonicalLocation | undefined
  let stagePathPresent = false
  let originalQuarantined = false
  let committed = false
  try {
    const current = await handle.readFile("utf8")
    if (current !== expected) return false
    const original = Buffer.from(current)
    const next = Buffer.from(replacement)
    const originalInfo = await handle.stat()
    const mode = originalInfo.mode & 0o7777
    stageLocation = { root: location.root, absolute: transactionPath(location, "rewrite-next") }
    stagedHandle = await createExclusiveCanonicalFile(stageLocation, next, mode)
    stagePathPresent = true

    try {
      if (
        !(await rootPinHasCanonicalIdentity(rootPin)) ||
        !(await handleHasCanonicalIdentity(location, handle)) ||
        !(await handleHasExactContents(handle, original))
      ) {
        throw new StaleProjectRewrite()
      }

      backupLocation = { root: location.root, absolute: transactionPath(location, "rewrite-backup") }
      await rename(location.absolute, backupLocation.absolute)
      originalQuarantined = true
      if (
        !(await rootPinHasCanonicalIdentity(rootPin)) ||
        !(await handleHasCanonicalIdentity(backupLocation, handle)) ||
        !(await handleHasExactContents(handle, original))
      ) {
        throw new StaleProjectRewrite()
      }
      await syncDirectory(path.dirname(location.absolute))

      // Destination is absent after the verified quarantine. link() is a no-replace
      // commit, so a concurrent writer is preserved instead of being overwritten.
      await link(stageLocation.absolute, location.absolute)
      committed = true
      if (
        !(await rootPinHasCanonicalIdentity(rootPin)) ||
        !(await handleHasCanonicalIdentity(location, stagedHandle)) ||
        !(await handleHasExactContents(stagedHandle, next))
      ) {
        unsafe("Project file changed identity or contents during atomic rewrite")
      }
      await syncDirectory(path.dirname(location.absolute))

      if (!(await quarantineAndUnlinkHandle(stageLocation, stagedHandle, "rewrite-installed-stage"))) {
        throw new ProjectFileRewriteRollbackError(location.absolute, stageLocation.absolute)
      }
      stagePathPresent = false
      if (!(await quarantineAndUnlinkHandle(backupLocation, handle, "rewrite-backup"))) {
        throw new ProjectFileRewriteRollbackError(location.absolute, backupLocation.absolute)
      }
      originalQuarantined = false
      await syncDirectory(path.dirname(location.absolute))
      return true
    } catch (error) {
      if (
        committed &&
        originalQuarantined &&
        backupLocation !== undefined &&
        stageLocation !== undefined &&
        stagedHandle !== undefined
      ) {
        const rolledBack = await rollbackCommittedRewrite({
          location,
          originalHandle: handle,
          original,
          backupLocation,
          stagedHandle,
          stageLocation,
          stagePathPresent,
          replacement: next,
        }).catch(() => false)
        if (!rolledBack) {
          throw new ProjectFileRewriteRollbackError(location.absolute, backupLocation.absolute)
        }
        originalQuarantined = false
        stagePathPresent = false
      } else {
        let cleanupComplete = true
        if (originalQuarantined) {
          cleanupComplete =
            backupLocation !== undefined && (await restoreQuarantinedFile(backupLocation.absolute, location.absolute))
          if (cleanupComplete) originalQuarantined = false
        }
        if (stagePathPresent && stageLocation !== undefined && stagedHandle !== undefined) {
          cleanupComplete =
            (await quarantineAndUnlinkHandle(stageLocation, stagedHandle, "rewrite-abort-stage")) && cleanupComplete
          if (cleanupComplete) stagePathPresent = false
        }
        if (!cleanupComplete) {
          throw new ProjectFileRewriteRollbackError(
            location.absolute,
            originalQuarantined ? backupLocation?.absolute : stageLocation?.absolute,
          )
        }
      }
      if (error instanceof StaleProjectRewrite) return false
      throw error
    }
  } finally {
    await handle.close()
    await stagedHandle?.close().catch(() => undefined)
    await rootPin.handle.close().catch(() => undefined)
  }
}

function identifierStart(value: string): boolean {
  return /[A-Za-z_$]/u.test(value)
}

function identifierPart(value: string): boolean {
  return /[\w$]/u.test(value)
}

function regexPrefixKeyword(value: string): boolean {
  return new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]).has(value)
}

/**
 * Returns the JavaScript/TypeScript lexical context immediately before an offset.
 * The scanner is deliberately conservative: it recognizes strings, comments,
 * regular expressions, and nested template expressions so ownership markers
 * cannot be registered as executable probes while they are actually data.
 */
export function sourceCodeContextAt(source: string, offset: number): SourceCodeContext {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return { inCode: false, braceDepth: 0 }
  let mode: LexicalMode = "code"
  let braceDepth = 0
  const delimiters: Array<"(" | "[" | "{"> = []
  let canStartRegex = true
  let escaped = false
  let regexClass = false
  const templateExpressions: number[] = []

  for (let index = 0; index < offset; index += 1) {
    const character = source[index] ?? ""
    const next = source[index + 1] ?? ""

    if (mode === "line-comment") {
      if (character === "\n" || character === "\r") mode = "code"
      continue
    }
    if (mode === "block-comment") {
      if (character === "*" && next === "/") {
        mode = "code"
        index += 1
      }
      continue
    }
    if (mode === "single" || mode === "double") {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\") {
        escaped = true
        continue
      }
      if ((mode === "single" && character === "'") || (mode === "double" && character === '"')) {
        mode = "code"
        canStartRegex = false
      }
      continue
    }
    if (mode === "regex") {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\") {
        escaped = true
        continue
      }
      if (character === "[") regexClass = true
      else if (character === "]") regexClass = false
      else if (character === "/" && !regexClass) {
        mode = "code"
        canStartRegex = false
        while (/[A-Za-z]/u.test(source[index + 1] ?? "")) index += 1
      }
      continue
    }
    if (mode === "template") {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\") {
        escaped = true
        continue
      }
      if (character === "`") {
        mode = "code"
        canStartRegex = false
        continue
      }
      if (character === "$" && next === "{") {
        templateExpressions.push(0)
        mode = "code"
        canStartRegex = true
        index += 1
      }
      continue
    }

    if (character === "/" && next === "/") {
      mode = "line-comment"
      index += 1
      continue
    }
    if (character === "/" && next === "*") {
      mode = "block-comment"
      index += 1
      continue
    }
    if (character === "/" && canStartRegex) {
      mode = "regex"
      regexClass = false
      escaped = false
      continue
    }
    if (character === "'") {
      mode = "single"
      escaped = false
      continue
    }
    if (character === '"') {
      mode = "double"
      escaped = false
      continue
    }
    if (character === "`") {
      mode = "template"
      escaped = false
      continue
    }
    if (/\s/u.test(character)) continue

    if (identifierStart(character)) {
      let end = index + 1
      while (identifierPart(source[end] ?? "")) end += 1
      const identifier = source.slice(index, end)
      canStartRegex = regexPrefixKeyword(identifier)
      index = end - 1
      continue
    }
    if (/[0-9]/u.test(character)) {
      let end = index + 1
      while (/[\w.]/u.test(source[end] ?? "")) end += 1
      canStartRegex = false
      index = end - 1
      continue
    }
    if (character === "{") {
      braceDepth += 1
      delimiters.push("{")
      if (templateExpressions.length > 0) {
        const last = templateExpressions.length - 1
        templateExpressions[last] = (templateExpressions[last] ?? 0) + 1
      }
      canStartRegex = true
      continue
    }
    if (character === "}") {
      const last = templateExpressions.length - 1
      if (last >= 0 && templateExpressions[last] === 0) {
        templateExpressions.pop()
        mode = "template"
      } else {
        braceDepth = Math.max(0, braceDepth - 1)
        if (delimiters.at(-1) === "{") delimiters.pop()
        if (last >= 0) templateExpressions[last] = Math.max(0, (templateExpressions[last] ?? 0) - 1)
      }
      canStartRegex = false
      continue
    }
    if (character === "(" || character === "[") {
      delimiters.push(character)
      canStartRegex = true
      continue
    }
    if (character === ")" || character === "]") {
      const opening = character === ")" ? "(" : "["
      if (delimiters.at(-1) === opening) delimiters.pop()
      canStartRegex = false
      continue
    }
    canStartRegex = ![")", "]"].includes(character)
  }

  const innermostDelimiter = delimiters.at(-1)
  return {
    inCode: mode === "code",
    braceDepth,
    ...(innermostDelimiter === undefined ? {} : { innermostDelimiter }),
  }
}
