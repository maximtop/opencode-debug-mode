import { createHash } from "node:crypto"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { DebugModeError } from "../core/errors.js"
import { isContained } from "../session/paths.js"

export type TransportHelperResult = Readonly<{
  relativePath: string
  requiredImport: string
  sha256: string
  bytes: number
}>

function helperSource(options: { endpoint: string; token: string; extensionBackground: boolean }): string {
  const listener = options.extensionBackground
    ? `
const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime
runtime?.onMessage?.addListener((message) => {
  if (message?.type === "opencode-debug-event") __opencodeDebugEmit(message.event)
})
`
    : ""
  return `const endpoint = ${JSON.stringify(options.endpoint)}
const authorization = ${JSON.stringify(`Bearer ${options.token}`)}
const queue = []
let sending = false
let dropped = 0

function bound(value, depth = 0) {
  if (depth > 6) return "[TRUNCATED]"
  if (typeof value === "string") return value.slice(0, 8192)
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => bound(item, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().slice(0, 50).map((key) => [key, bound(value[key], depth + 1)]))
  }
  return value
}

export function __opencodeDebugEmit(event) {
  if (queue.length >= 100) { dropped += 1; return }
  queue.push(bound(event))
  void flush()
}

async function flush() {
  if (sending) return
  sending = true
  try {
    while (queue.length > 0) {
      const events = queue.splice(0, 100)
      if (dropped > 0) { events.push({ ...events[0], message: "dropped events", data: { dropped } }); dropped = 0 }
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "omit",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      })
      if (!response.ok) break
    }
  } catch {
    // Runtime evidence transport is best effort and never affects target behavior.
  } finally {
    sending = false
  }
}
${listener}`
}

export class TransportHelper {
  constructor(
    private readonly projectRoot: string,
    private readonly recordOwnedFile?: (value: { path: string; sha256: string; bytes: number }) => void | Promise<void>,
  ) {}

  async create(options: {
    targetPath: string
    host: "127.0.0.1" | "::1"
    port: number
    token: string
    runtime: "web" | "extension-background"
  }): Promise<TransportHelperResult> {
    const canonicalRoot = await realpath(this.projectRoot)
    const absoluteTarget = path.resolve(canonicalRoot, options.targetPath)
    if (!isContained(canonicalRoot, absoluteTarget)) {
      throw new DebugModeError("HELPER_PATH_UNSAFE", "Transport helper must remain inside the project")
    }
    const parent = path.dirname(absoluteTarget)
    await mkdir(parent, { recursive: true })
    if ((await realpath(parent)) !== parent) {
      throw new DebugModeError("HELPER_PATH_UNSAFE", "Transport helper parent is not canonical")
    }
    const endpointHost = options.host === "::1" ? "[::1]" : options.host
    const source = helperSource({
      endpoint: `http://${endpointHost}:${options.port}/v1/events`,
      token: options.token,
      extensionBackground: options.runtime === "extension-background",
    })
    await writeFile(absoluteTarget, source, { flag: "wx", mode: 0o600 })
    const bytes = Buffer.byteLength(source)
    const sha256 = createHash("sha256").update(source).digest("hex")
    await this.recordOwnedFile?.({ path: absoluteTarget, sha256, bytes })
    const relativePath = `./${path.relative(canonicalRoot, absoluteTarget).split(path.sep).join("/")}`
    return {
      relativePath,
      requiredImport: `import { __opencodeDebugEmit } from ${JSON.stringify(relativePath)}`,
      sha256,
      bytes,
    }
  }
}
