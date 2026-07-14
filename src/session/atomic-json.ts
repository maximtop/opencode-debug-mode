import { randomBytes } from "node:crypto"
import { open, rename, rm } from "node:fs/promises"
import path from "node:path"

export async function atomicWriteJson(filename: string, value: unknown, maximumBytes: number): Promise<number> {
  const serialized = `${JSON.stringify(value)}\n`
  const bytes = Buffer.byteLength(serialized)
  if (bytes > maximumBytes) throw new RangeError(`Serialized JSON exceeds ${maximumBytes} bytes`)

  const temporary = path.join(
    path.dirname(filename),
    `${path.basename(filename)}.next-${randomBytes(8).toString("hex")}`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(serialized, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filename)
    return bytes
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
