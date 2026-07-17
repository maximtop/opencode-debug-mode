import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "data")

export async function isBetaEnabled(accountId) {
  const fileName = `${encodeURI(accountId)}.json`
  const filePath = join(dataDirectory, fileName)

  try {
    const raw = await readFile(filePath, "utf8")
    const record = JSON.parse(raw)
    return record.beta === true
  } catch (error) {
    const errorCode = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN"
    if (errorCode !== "ENOENT") throw error
    return false
  }
}
