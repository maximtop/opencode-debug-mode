import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { PACKAGE_ID } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import { sanitizeEvidenceData } from "../evidence/sanitize.js"
import { EvidenceEventSchema } from "../evidence/types.js"
import { InvestigationStateSchema } from "../investigation/schema.js"
import { isContained } from "../session/paths.js"
import { type CleanupResult, CleanupResultSchema, type FinalReportInput, FinalReportInputSchema } from "./types.js"

export type RetainedBundleInput = Readonly<{
  keepArtifacts: boolean
  destination?: string
  sessionDir: string
  evidenceFile: string
  stateFile: string
  token: string
  securityValues?: string[]
  finalReport: FinalReportInput
}>

export type StagedBundle = Readonly<{
  partialPath: string
  finalPath: string
  token: string
  securityValues: string[]
  report: FinalReportInput
  eventCount: number
}>

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function redactKnownSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => (secret.length === 0 ? text : text.replaceAll(secret, "[REDACTED]")), value)
  }
  if (Array.isArray(value)) return value.map((entry) => redactKnownSecrets(entry, secrets))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactKnownSecrets(entry, secrets)]))
  }
  return value
}

async function sanitizedEvidence(source: string, destination: string): Promise<number> {
  let count = 0
  await writeFile(destination, "", { mode: 0o600 })
  const lines = createInterface({ input: createReadStream(source), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (line.length === 0) continue
    const event = EvidenceEventSchema.parse(JSON.parse(line))
    const sanitized = sanitizeEvidenceData(event.data)
    await appendFile(
      destination,
      `${JSON.stringify({
        ...event,
        data: sanitized.value,
        sanitization: {
          flags: [...new Set([...event.sanitization.flags, ...sanitized.flags])].sort(),
          droppedKeys: event.sanitization.droppedKeys + sanitized.droppedKeys,
          storedBytes: sanitized.storedBytes,
          ...(sanitized.originalBytes === undefined ? {} : { originalBytes: sanitized.originalBytes }),
        },
      })}\n`,
      { mode: 0o600 },
    )
    count += 1
  }
  return count
}

function renderReport(report: FinalReportInput, cleanup: CleanupResult, retainedPath: string): string {
  const hypotheses = report.hypotheses.map((value) => `- ${value.id}: ${value.status} — ${value.statement}`).join("\n")
  return `# Debug investigation report

Outcome: ${report.outcome}

## Root cause

${report.rootCause}

## Deciding evidence

${report.decidingEvidence.map((value) => `- ${value}`).join("\n")}

## Hypotheses

${hypotheses}

## Fix

${report.fix}

Changed files: ${report.changedFiles.join(", ")}

## Verification

${report.verification.map((value) => `- ${value}`).join("\n")}

## Cleanup

Status: ${cleanup.status}

Retained artifact: ${retainedPath}
`
}

export async function stageRetainedBundle(input: RetainedBundleInput): Promise<StagedBundle> {
  if (!input.keepArtifacts || input.destination === undefined) {
    throw new DebugModeError("DESTINATION_REQUIRED", "Explicit retention is not enabled")
  }
  let partialPath: string | undefined
  try {
    const destination = await realpath(input.destination)
    const sessionDir = await realpath(input.sessionDir)
    if (destination === sessionDir || isContained(sessionDir, destination)) {
      throw new DebugModeError("EXPORT_FAILED", "Retention destination cannot be inside the ephemeral session")
    }
    const suffix = randomBytes(8).toString("hex")
    partialPath = path.join(destination, `.partial-${PACKAGE_ID}-${suffix}`)
    const finalPath = path.join(
      destination,
      `${PACKAGE_ID}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${suffix}`,
    )
    await mkdir(partialPath, { mode: 0o700 })
    const state = InvestigationStateSchema.parse(JSON.parse(await readFile(input.stateFile, "utf8")))
    const sanitizedState = InvestigationStateSchema.parse(
      sanitizeEvidenceData(redactKnownSecrets(state, [input.token, ...(input.securityValues ?? [])])).value,
    )
    await writeFile(
      path.join(partialPath, "investigation-state.json"),
      `${JSON.stringify(sanitizedState, null, 2)}\n`,
      {
        mode: 0o600,
      },
    )
    const eventCount = await sanitizedEvidence(input.evidenceFile, path.join(partialPath, "evidence.ndjson"))
    return {
      partialPath,
      finalPath,
      token: input.token,
      securityValues: input.securityValues ?? [],
      report: FinalReportInputSchema.parse(input.finalReport),
      eventCount,
    }
  } catch (error) {
    if (partialPath !== undefined) await rm(partialPath, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof DebugModeError) throw error
    throw new DebugModeError("EXPORT_FAILED", "Retained bundle could not be staged")
  }
}

export async function finalizeRetainedBundle(
  staged: StagedBundle,
  cleanupInput: CleanupResult,
): Promise<{ path: string }> {
  try {
    const cleanup = CleanupResultSchema.parse(cleanupInput)
    const report = renderReport(staged.report, cleanup, staged.finalPath)
    await writeFile(path.join(staged.partialPath, "report.md"), report, { mode: 0o600 })
    const publicFiles = ["evidence.ndjson", "investigation-state.json", "report.md"]
    const files: Record<string, { bytes: number; sha256: string }> = {}
    for (const name of publicFiles) {
      const value = await readFile(path.join(staged.partialPath, name))
      files[name] = { bytes: value.byteLength, sha256: sha256(value) }
    }
    const manifest = {
      package: PACKAGE_ID,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      eventCount: staged.eventCount,
      files,
    }
    await writeFile(path.join(staged.partialPath, "bundle-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    for (const name of await readdir(staged.partialPath)) {
      const text = await readFile(path.join(staged.partialPath, name), "utf8")
      if ([staged.token, ...staged.securityValues].some((secret) => secret.length > 0 && text.includes(secret))) {
        throw new DebugModeError("EXPORT_FAILED", "Retained bundle failed its secret scan")
      }
    }
    await rename(staged.partialPath, staged.finalPath)
    return { path: staged.finalPath }
  } catch (error) {
    await rm(staged.partialPath, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof DebugModeError) throw error
    throw new DebugModeError("EXPORT_FAILED", "Retained bundle could not be finalized")
  }
}
