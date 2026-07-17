import { readFile } from "node:fs/promises"

export type PackageDiagnostics = Readonly<{ packageVersion: string; promptSha256: string }>

let versionPromise: Promise<string> | undefined

export function readPackageVersion(): Promise<string> {
  versionPromise ??= (async () => {
    let text: string | undefined
    for (const candidate of [
      new URL("../package.json", import.meta.url),
      new URL("../../package.json", import.meta.url),
    ]) {
      try {
        text = await readFile(candidate, "utf8")
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    if (text === undefined) throw new Error("Package metadata is unavailable")
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null || !("version" in value)) {
      throw new Error("Package metadata has no version")
    }
    const version = (value as { version?: unknown }).version
    if (typeof version !== "string" || version.length === 0) throw new Error("Package version is invalid")
    return version
  })()
  return versionPromise
}
