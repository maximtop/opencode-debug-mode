import { randomBytes } from "node:crypto"
import { readFile, unlink, writeFile } from "node:fs/promises"

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export class SecretStore {
  constructor(private readonly filename: string) {}

  async create(): Promise<string> {
    const value = randomBytes(32).toString("base64url")
    await writeFile(this.filename, value, { flag: "wx", mode: 0o600 })
    return value
  }

  async read(): Promise<string> {
    const value = await readFile(this.filename, "utf8")
    if (!TOKEN_PATTERN.test(value) || Buffer.from(value, "base64url").byteLength !== 32) {
      throw new Error("Stored collector credential is invalid")
    }
    return value
  }

  async remove(): Promise<"success" | "already-clean"> {
    let length: number
    try {
      length = (await readFile(this.filename)).byteLength
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already-clean"
      throw error
    }

    try {
      await writeFile(this.filename, randomBytes(length), { flag: "r+" })
    } catch {
      // Deletion is still attempted if best-effort overwrite is unavailable.
    }
    try {
      await unlink(this.filename)
      return "success"
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already-clean"
      throw error
    }
  }
}
