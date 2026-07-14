import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSessionPaths, type SessionPaths } from "../../src/session/paths.js"

export type TempProject = Readonly<{
  root: string
  tempBase: string
  paths: SessionPaths
}>

export async function withTempProject<T>(callback: (project: TempProject) => Promise<T>): Promise<T> {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-mode-test-"))
  const root = path.join(container, "project")
  const tempBase = path.join(container, "opencode-debug-mode-v1")
  await mkdir(root, { recursive: true })
  const paths = await createSessionPaths(tempBase, root)
  try {
    return await callback({ root, tempBase, paths })
  } finally {
    await rm(container, { recursive: true, force: true })
  }
}
