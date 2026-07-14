import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const OPENCODE_INSTALL_TIMEOUT_MS = 300_000

function npmCommand(args: string[]): [string, string[]] {
  const npmEntry = process.env.npm_execpath
  if (npmEntry !== undefined && npmEntry.length > 0) return [process.execPath, [npmEntry, ...args]]
  return [process.platform === "win32" ? "npm.cmd" : "npm", args]
}

export async function installPackedPluginAndReadConfig(version: string): Promise<{
  agent: { debug: { mode: string } }
  command: { debug: { agent: string; template: string } }
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-debug-install-"))
  try {
    const [packExecutable, packArgs] = npmCommand(["pack", "--silent", "--pack-destination", directory])
    const packed = await execute(packExecutable, packArgs, { cwd: process.cwd() })
    const tarballName = packed.stdout.trim().split(/\r?\n/u).at(-1)
    if (tarballName === undefined) throw new Error("npm pack returned no tarball")
    const tarball = path.resolve(directory, tarballName)
    await writeFile(path.join(directory, "package.json"), '{"private":true,"type":"module"}\n')
    const [installExecutable, installArgs] = npmCommand(["install", tarball, `opencode-ai@${version}`])
    await execute(installExecutable, installArgs, {
      cwd: directory,
      timeout: OPENCODE_INSTALL_TIMEOUT_MS,
    })
    const installedEntry = path.join(directory, "node_modules", "@maximtop", "opencode-debug-mode", "dist", "index.js")
    await writeFile(
      path.join(directory, "opencode.json"),
      `${JSON.stringify({ plugin: [pathToFileURL(installedEntry).href] }, null, 2)}\n`,
    )
    const executable = path.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe")
    const home = path.join(directory, "home")
    const configHome = path.join(home, ".config")
    await mkdir(configHome, { recursive: true })
    const resolved = await execute(executable, ["debug", "config"], {
      cwd: directory,
      timeout: OPENCODE_INSTALL_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        OPENCODE_CONFIG_DIR: path.join(configHome, "opencode"),
      },
    })
    let config: {
      agent?: { debug?: { mode?: unknown } }
      command?: { debug?: { agent?: unknown; template?: unknown } }
    }
    try {
      config = JSON.parse(resolved.stdout) as typeof config
    } catch {
      throw new Error(`OpenCode returned invalid resolved config: ${resolved.stdout.slice(0, 1_000)}`)
    }
    const agent = config.agent?.debug
    const command = config.command?.debug
    if (agent === undefined || command === undefined) {
      throw new Error(
        `OpenCode did not register debug definitions. stderr: ${resolved.stderr.slice(0, 2_000)} stdout: ${resolved.stdout.slice(0, 2_000)}`,
      )
    }
    return {
      agent: { debug: { mode: String(agent.mode) } },
      command: { debug: { agent: String(command.agent), template: String(command.template) } },
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
