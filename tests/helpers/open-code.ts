import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type { Config, Plugin } from "@opencode-ai/plugin"

const execute = promisify(execFile)

export async function installPackedPluginAndReadConfig(version: string): Promise<{
  agent: { debug: { mode: string } }
  command: { debug: { agent: string; template: string } }
}> {
  const packed = await execute("npm", ["pack", "--silent"], { cwd: process.cwd() })
  const tarballName = packed.stdout.trim().split(/\r?\n/u).at(-1)
  if (tarballName === undefined) throw new Error("npm pack returned no tarball")
  const tarball = path.resolve(tarballName)
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-debug-install-"))
  try {
    await writeFile(path.join(directory, "package.json"), '{"private":true,"type":"module"}\n')
    await execute("npm", ["install", tarball, `opencode-ai@${version}`], {
      cwd: directory,
      timeout: 120_000,
    })
    const installedEntry = path.join(directory, "node_modules", "opencode-debug-mode", "dist", "index.js")
    await writeFile(
      path.join(directory, "opencode.json"),
      `${JSON.stringify({ plugin: [pathToFileURL(installedEntry).href] }, null, 2)}\n`,
    )
    const executable = path.join(
      directory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "opencode.cmd" : "opencode",
    )
    const listed = await execute(executable, ["agent", "list"], { cwd: directory, timeout: 120_000 })
    if (!/(^|\s)debug(\s|$)/mu.test(listed.stdout)) {
      throw new Error(`OpenCode did not load the debug agent: ${listed.stdout.slice(0, 1_000)}`)
    }
    const module = (await import(pathToFileURL(installedEntry).href)) as { DebugModePlugin: Plugin }
    const hooks = await module.DebugModePlugin({
      client: { app: { log: async () => ({}) } },
      project: {} as never,
      directory,
      worktree: directory,
      experimental_workspace: { register: () => undefined },
      serverUrl: new URL("http://127.0.0.1"),
      $: {} as never,
    } as never)
    const config: Config = {}
    await hooks.config?.(config)
    await hooks.dispose?.()
    const agent = config.agent?.debug
    const command = config.command?.debug
    if (agent === undefined || command === undefined) throw new Error("Debug definitions were not registered")
    return {
      agent: { debug: { mode: String(agent.mode) } },
      command: { debug: { agent: String(command.agent), template: String(command.template) } },
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(tarball, { force: true })
  }
}
