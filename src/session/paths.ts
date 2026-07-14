import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises"
import path from "node:path"

export type SessionPaths = Readonly<{
  baseDir: string
  sessionDir: string
  projectRoot: string
  manifestFile: string
  secretFile: string
  stateFile: string
  evidenceFile: string
}>

export function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

export async function createSessionPaths(tempBase: string, projectRoot: string): Promise<SessionPaths> {
  const absoluteBase = path.resolve(tempBase)
  try {
    const existing = await lstat(absoluteBase)
    if (existing.isSymbolicLink()) throw new Error("Temporary base must not be a symbolic link")
    if (!existing.isDirectory()) throw new Error("Temporary base must be a directory")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(absoluteBase, { recursive: true, mode: 0o700 })
  }

  await realpath(absoluteBase)
  const canonicalProject = await realpath(projectRoot)
  const sessionDir = await mkdtemp(path.join(absoluteBase, "session-"))
  if (!isContained(absoluteBase, sessionDir)) throw new Error("Created session directory escaped the temporary base")

  return Object.freeze({
    baseDir: absoluteBase,
    sessionDir,
    projectRoot: canonicalProject,
    manifestFile: path.join(sessionDir, "manifest.json"),
    secretFile: path.join(sessionDir, "secret.bin"),
    stateFile: path.join(sessionDir, "investigation-state.json"),
    evidenceFile: path.join(sessionDir, "evidence.ndjson"),
  })
}
