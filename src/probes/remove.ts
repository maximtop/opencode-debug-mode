import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import type { ManifestProbe } from "../session/types.js"

export type ProbeRemovalResult =
  | { status: "success"; file: string; reason?: never }
  | { status: "already-clean"; file: string; reason?: never }
  | { status: "failed"; file: string; reason: string; line?: number }

function occurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0
  return value.split(needle).length - 1
}

function lineAt(value: string, index: number): number {
  return value.slice(0, index).split(/\r?\n/u).length
}

export async function removeOwnedProbe(probe: ManifestProbe): Promise<ProbeRemovalResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let source: string
    try {
      source = await readFile(probe.sourceFile, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "already-clean", file: probe.sourceFile }
      return { status: "failed", file: probe.sourceFile, reason: "source-read-failed" }
    }
    const starts = occurrences(source, probe.markerStart)
    const ends = occurrences(source, probe.markerEnd)
    if (starts === 0 && ends === 0) return { status: "already-clean", file: probe.sourceFile }
    const startIndex = source.indexOf(probe.markerStart)
    if (starts !== 1 || ends !== 1 || startIndex < 0) {
      return {
        status: "failed",
        file: probe.sourceFile,
        reason: "marker-ambiguous",
        ...(startIndex < 0 ? {} : { line: lineAt(source, startIndex) }),
      }
    }
    if (probe.expectedBlock === undefined || probe.expectedHash === undefined) {
      return {
        status: "failed",
        file: probe.sourceFile,
        reason: "marker-ownership-incomplete",
        line: lineAt(source, startIndex),
      }
    }
    if (
      occurrences(source, probe.expectedBlock) !== 1 ||
      createHash("sha256").update(probe.expectedBlock).digest("hex") !== probe.expectedHash
    ) {
      return {
        status: "failed",
        file: probe.sourceFile,
        reason: "marker-content-mismatch",
        line: lineAt(source, startIndex),
      }
    }
    const current = await readFile(probe.sourceFile, "utf8")
    if (current !== source) continue
    const blockIndex = source.indexOf(probe.expectedBlock)
    const next = source.slice(0, blockIndex) + source.slice(blockIndex + probe.expectedBlock.length)
    await writeFile(probe.sourceFile, next, "utf8")
    return { status: "success", file: probe.sourceFile }
  }
  return { status: "failed", file: probe.sourceFile, reason: "concurrent-source-change" }
}
