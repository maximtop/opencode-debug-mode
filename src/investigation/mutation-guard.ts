import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"
import type { Clock } from "../core/clock.js"
import { DebugModeError } from "../core/errors.js"
import type { EvidenceStore } from "../evidence/store.js"
import { probeMarkerEditHash } from "../probes/registry.js"
import { canonicalProjectFile } from "../probes/source-safety.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import { validateFixAuthorization } from "./gates.js"

const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "patch"])
const BYPASS_TOOLS = new Set(["bash", "task", "sdd-command"])

function reject(message: string, action: string): never {
  throw new DebugModeError("INVALID_PHASE", message, false, { action })
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (typeof value !== "object" || value === null) return []
  return Object.values(value).flatMap(stringValues)
}

function mutationPaths(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return []
  const input = args as Record<string, unknown>
  const direct: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, entry] of Object.entries(value)) {
      if (["filePath", "file_path", "path", "file"].includes(key) && typeof entry === "string") {
        direct.push(entry)
      } else if (typeof entry === "object" && entry !== null) {
        visit(entry)
      }
    }
  }
  visit(input)
  const patches = stringValues(input.patch ?? input.patchText ?? input.diff)
    .flatMap((value) => [...value.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu)])
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
  const moves = stringValues(input.patch ?? input.patchText ?? input.diff)
    .flatMap((value) => [...value.matchAll(/^\*\*\* Move to: (.+)$/gmu)])
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
  return [...new Set([...direct, ...patches, ...moves])]
}

function normalizeFile(projectRoot: string, filename: string): string {
  const absolute = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(projectRoot, filename)
  let canonical: string
  try {
    canonical = realpathSync(absolute)
  } catch {
    try {
      canonical = path.join(realpathSync(path.dirname(absolute)), path.basename(absolute))
    } catch {
      canonical = absolute
    }
  }
  return path.relative(projectRoot, canonical)
}

function isOutsideProject(filename: string): boolean {
  return filename === "" || filename === ".." || filename.startsWith(`..${path.sep}`) || path.isAbsolute(filename)
}

type InsertedEditSegment = Readonly<{
  oldString: string
  newString: string
  start: number
  end: number
}>

type EditStringPair = Readonly<{
  oldString: string
  newString: string
}>

function editStringPair(args: unknown): EditStringPair | undefined {
  if (typeof args !== "object" || args === null) return undefined
  const root = args as Record<string, unknown>
  const nested = Array.isArray(root.edits)
    ? root.edits.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : []
  const candidates = [root, ...nested].filter((input) => {
    const oldString = input.oldString ?? input.old_string
    const newString = input.newString ?? input.new_string
    return typeof oldString === "string" && typeof newString === "string"
  })
  if (candidates.length !== 1 || candidates[0] === undefined) return undefined
  const input = candidates[0]
  const oldString = input.oldString ?? input.old_string
  const newString = input.newString ?? input.new_string
  if (typeof oldString !== "string" || typeof newString !== "string") return undefined
  return { oldString, newString }
}

function insertedEditSegment(args: unknown): InsertedEditSegment | undefined {
  const pair = editStringPair(args)
  if (pair === undefined) return undefined
  const { oldString, newString } = pair
  if (newString.length <= oldString.length) return undefined
  let prefix = 0
  while (prefix < oldString.length && oldString[prefix] === newString[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldString.length - prefix &&
    oldString[oldString.length - 1 - suffix] === newString[newString.length - 1 - suffix]
  ) {
    suffix += 1
  }
  if (prefix + suffix !== oldString.length) return undefined
  return {
    oldString,
    newString,
    start: prefix,
    end: newString.length - suffix,
  }
}

type OwnedProbeInsertion = {
  probeId: string
  field: "expectedBlock" | "helperImportBlock"
  hashField: "expectedHash" | "helperImportHash"
  exactField: "expectedBlockIsExactInsertion" | "helperImportBlockIsExactInsertion"
  originalBlock: string
  ownedBlock: string
}

type DistortedOwnedProbeInsertion = Readonly<{
  probeId: string
  field: "markerBlock" | "helperImportBlock"
}>

async function mismatchedCanonicalMarkerEdit(
  session: DebugSession,
  args: unknown,
): Promise<Readonly<{ probeId: string }> | undefined> {
  const manifest = await session.manifestStore.read()
  const requested = mutationPaths(args)
  const pair = editStringPair(args)
  if (requested.length !== 1 || requested[0] === undefined || pair === undefined) return undefined
  let requestedFile: string
  try {
    requestedFile = await canonicalProjectFile(
      session.projectRoot,
      path.isAbsolute(requested[0]) ? path.resolve(requested[0]) : path.resolve(session.directory, requested[0]),
    )
  } catch {
    return undefined
  }
  const requestedHash = probeMarkerEditHash(pair)
  for (const probe of manifest.probes) {
    if (
      probe.status !== "planned" ||
      probe.sourceFile !== requestedFile ||
      probe.expectedBlock === undefined ||
      probe.markerEditHash === undefined ||
      pair.oldString.includes(probe.expectedBlock)
    ) {
      continue
    }
    const start = pair.newString.indexOf(probe.expectedBlock)
    if (start < 0 || pair.newString.indexOf(probe.expectedBlock, start + probe.expectedBlock.length) >= 0) continue
    if (requestedHash !== probe.markerEditHash) return { probeId: probe.id }
  }
  return undefined
}

async function exactOwnedProbeWithSurroundingChanges(
  session: DebugSession,
  args: unknown,
): Promise<DistortedOwnedProbeInsertion | undefined> {
  const manifest = await session.manifestStore.read()
  const requested = mutationPaths(args)
  const pair = editStringPair(args)
  if (requested.length !== 1 || requested[0] === undefined || pair === undefined) return undefined
  let requestedFile: string
  try {
    requestedFile = await canonicalProjectFile(
      session.projectRoot,
      path.isAbsolute(requested[0]) ? path.resolve(requested[0]) : path.resolve(session.directory, requested[0]),
    )
  } catch {
    return undefined
  }
  for (const probe of manifest.probes) {
    if (probe.status !== "planned") continue
    const candidates = [
      ...(probe.expectedBlock === undefined
        ? []
        : [{ sourceFile: probe.sourceFile, field: "markerBlock" as const, block: probe.expectedBlock }]),
      ...(probe.helperSourceFile === undefined || probe.helperImportBlock === undefined
        ? []
        : [
            {
              sourceFile: probe.helperSourceFile,
              field: "helperImportBlock" as const,
              block: probe.helperImportBlock,
            },
          ]),
    ]
    for (const candidate of candidates) {
      if (candidate.sourceFile !== requestedFile || pair.oldString.includes(candidate.block)) continue
      const start = pair.newString.indexOf(candidate.block)
      if (start < 0 || pair.newString.indexOf(candidate.block, start + candidate.block.length) >= 0) continue
      const withoutBlock = `${pair.newString.slice(0, start)}${pair.newString.slice(start + candidate.block.length)}`
      if (withoutBlock !== pair.oldString && withoutBlock.replace(/\s/gu, "") === pair.oldString.replace(/\s/gu, "")) {
        return { probeId: probe.id, field: candidate.field }
      }
    }
  }
  return undefined
}

async function ownedProbeInsertions(session: DebugSession, args: unknown): Promise<OwnedProbeInsertion[]> {
  const manifest = await session.manifestStore.read()
  const requested = mutationPaths(args)
  const edit = insertedEditSegment(args)
  if (requested.length !== 1 || requested[0] === undefined || edit === undefined) return []
  let requestedFile: string
  try {
    requestedFile = await canonicalProjectFile(
      session.projectRoot,
      path.isAbsolute(requested[0]) ? path.resolve(requested[0]) : path.resolve(session.directory, requested[0]),
    )
  } catch {
    return []
  }
  const matches: Array<OwnedProbeInsertion & { start: number; end: number }> = []
  for (const probe of manifest.probes) {
    if (probe.status !== "planned" || probe.expectedBlock === undefined) continue
    const insertions = [
      { sourceFile: probe.sourceFile, field: "expectedBlock" as const, block: probe.expectedBlock },
      ...(probe.helperSourceFile === undefined || probe.helperImportBlock === undefined
        ? []
        : [
            {
              sourceFile: probe.helperSourceFile,
              field: "helperImportBlock" as const,
              block: probe.helperImportBlock,
            },
          ]),
    ]
    for (const insertion of insertions) {
      if (requestedFile !== insertion.sourceFile) continue
      const start = edit.newString.indexOf(insertion.block)
      if (start < 0) continue
      if (edit.oldString.includes(insertion.block)) continue
      if (edit.newString.indexOf(insertion.block, start + insertion.block.length) >= 0) return []
      const end = start + insertion.block.length
      const overlapStart = Math.max(start, edit.start)
      const overlapEnd = Math.min(end, edit.end)
      if (
        overlapStart >= overlapEnd ||
        !/^\s*$/u.test(edit.newString.slice(start, overlapStart)) ||
        !/^\s*$/u.test(edit.newString.slice(overlapEnd, end))
      ) {
        continue
      }
      matches.push({
        probeId: probe.id,
        field: insertion.field,
        hashField: insertion.field === "expectedBlock" ? "expectedHash" : "helperImportHash",
        exactField:
          insertion.field === "expectedBlock" ? "expectedBlockIsExactInsertion" : "helperImportBlockIsExactInsertion",
        originalBlock: insertion.block,
        ownedBlock: insertion.block,
        start,
        end,
      })
    }
  }
  if (matches.length === 0) return []
  matches.sort((left, right) => left.start - right.start)
  let cursor = edit.start
  for (const match of matches) {
    const coveredStart = Math.max(match.start, edit.start)
    const coveredEnd = Math.min(match.end, edit.end)
    if (coveredStart < cursor || !/^\s*$/u.test(edit.newString.slice(cursor, coveredStart))) return []
    cursor = coveredEnd
  }
  if (!/^\s*$/u.test(edit.newString.slice(cursor, edit.end))) return []
  return matches.map((match, index) => ({
    probeId: match.probeId,
    field: match.field,
    hashField: match.hashField,
    exactField: match.exactField,
    originalBlock: match.originalBlock,
    ownedBlock: edit.newString.slice(
      index === 0 ? edit.start : Math.max(edit.start, match.start),
      Math.min(edit.end, matches[index + 1]?.start ?? edit.end),
    ),
  }))
}

async function distortedOwnedProbeInsertion(
  session: DebugSession,
  args: unknown,
): Promise<DistortedOwnedProbeInsertion | undefined> {
  const manifest = await session.manifestStore.read()
  const requested = mutationPaths(args)
  const edit = insertedEditSegment(args)
  if (requested.length !== 1 || requested[0] === undefined || edit === undefined) return undefined
  let requestedFile: string
  try {
    requestedFile = await canonicalProjectFile(
      session.projectRoot,
      path.isAbsolute(requested[0]) ? path.resolve(requested[0]) : path.resolve(session.directory, requested[0]),
    )
  } catch {
    return undefined
  }
  const inserted = edit.newString.slice(edit.start, edit.end)
  for (const probe of manifest.probes) {
    if (probe.status !== "planned") continue
    const candidates = [
      ...(probe.expectedBlock === undefined
        ? []
        : [{ sourceFile: probe.sourceFile, field: "markerBlock" as const, block: probe.expectedBlock }]),
      ...(probe.helperSourceFile === undefined || probe.helperImportBlock === undefined
        ? []
        : [
            {
              sourceFile: probe.helperSourceFile,
              field: "helperImportBlock" as const,
              block: probe.helperImportBlock,
            },
          ]),
    ]
    for (const candidate of candidates) {
      if (candidate.sourceFile !== requestedFile || inserted.includes(candidate.block)) continue
      const ownershipLines = candidate.block
        .split(/\r?\n/u)
        .filter((line) => line.includes("opencode-debug-mode") && /DEBUG-(?:START|END)/u.test(line))
        .map((line) => line.trim())
      if (
        ownershipLines.length >= 2 &&
        ownershipLines.every((line) => inserted.includes(line) && !edit.oldString.includes(line))
      ) {
        return { probeId: probe.id, field: candidate.field }
      }
    }
  }
  return undefined
}

async function recordOwnedProbeInsertions(session: DebugSession, args: unknown): Promise<void> {
  const insertions = await ownedProbeInsertions(session, args)
  if (insertions.length === 0) return
  await session.manifestStore.modify((manifest) => ({
    ...manifest,
    probes: manifest.probes.map((probe) => {
      let updated = probe
      for (const insertion of insertions) {
        if (
          updated.id === insertion.probeId &&
          updated.status === "planned" &&
          updated[insertion.field] === insertion.originalBlock
        ) {
          updated = {
            ...updated,
            [insertion.field]: insertion.ownedBlock,
            [insertion.hashField]: createHash("sha256").update(insertion.ownedBlock).digest("hex"),
            [insertion.exactField]: true,
          }
        }
      }
      return updated
    }),
  }))
}

export async function enforceDebugMutationGate(input: {
  registry: SessionRegistry
  evidenceFor(session: DebugSession): EvidenceStore
  sessionID: string
  tool: string
  args: unknown
}): Promise<void> {
  const tool = input.tool.toLowerCase()
  if (BYPASS_TOOLS.has(tool)) {
    reject(
      `Debug Mode blocks ${tool} because it can bypass lifecycle and file-scope gates`,
      "Use read-only workspace tools, debug_process_capture for supervised checks, and the normal edit tool for authorized changes",
    )
  }
  if (!MUTATION_TOOLS.has(tool)) return
  let session: DebugSession
  try {
    session = await input.registry.requireOwned(input.sessionID)
  } catch {
    reject(
      "Debug Mode blocked a file mutation before its managed session was started",
      "Call debug_session_start, checkpoint the scope and visible hypotheses, then capture a pre-fix baseline",
    )
  }
  const state = await session.investigationStore.read()
  if (state.phase === "instrumenting") {
    const mismatchedMarkerEdit = await mismatchedCanonicalMarkerEdit(session, input.args)
    if (mismatchedMarkerEdit !== undefined) {
      throw new DebugModeError(
        "MARKER_MISMATCH",
        "Debug Mode blocked a marker edit that does not match its prepared insertion boundary",
        false,
        {
          action:
            "The edit was blocked before writing. Invoke the markerEdit returned by debug_probe_prepare verbatim with the normal edit tool: keep its filePath, oldString, and newString byte-for-byte. markerEdit already places the marker before sourceLineText with the source file's native line endings and indentation; never append it after the selected line or move it to a neighboring blank line.",
          details: {
            probeId: mismatchedMarkerEdit.probeId,
            blockField: "markerEdit",
            canonicalEditRequired: true,
          },
        },
      )
    }
  }
  const instrumentationInsertions =
    state.phase === "instrumenting" ? await ownedProbeInsertions(session, input.args) : []
  if (state.phase === "instrumenting" && instrumentationInsertions.length > 0) return
  if (state.phase === "instrumenting") {
    const surroundingChange = await exactOwnedProbeWithSurroundingChanges(session, input.args)
    if (surroundingChange !== undefined) {
      const returnedField = surroundingChange.field === "markerBlock" ? "markerBlock" : "helperImportBlock"
      throw new DebugModeError(
        "MARKER_MISMATCH",
        `Debug Mode blocked a prepared ${returnedField} edit that changed surrounding whitespace`,
        true,
        {
          action: `The edit was blocked before writing. Read the target again, preserve oldString byte-for-byte, and create newString by inserting only the exact ${returnedField} returned by debug_probe_prepare at its boundary. Do not remove, add, reindent, or format any adjacent whitespace or code. If the boundary changed, call debug_probe_remove with probeId ${surroundingChange.probeId}, then prepare the probe again.`,
          details: {
            probeId: surroundingChange.probeId,
            blockField: returnedField,
            surroundingBytesChanged: true,
          },
        },
      )
    }
    const distorted = await distortedOwnedProbeInsertion(session, input.args)
    if (distorted !== undefined) {
      const returnedField = distorted.field === "markerBlock" ? "markerBlock" : "helperImportBlock"
      throw new DebugModeError("MARKER_MISMATCH", `Debug Mode blocked a modified prepared ${returnedField}`, false, {
        action: `The edit was blocked before writing. Retry with the exact ${returnedField} returned by debug_probe_prepare byte-for-byte, including its existing indentation and line breaks; never retype, reindent, format, or reconstruct it. If that exact output is unavailable or the intended boundary changed, call debug_probe_remove with probeId ${distorted.probeId}, then prepare the probe again.`,
        details: { probeId: distorted.probeId, blockField: returnedField },
      })
    }
  }
  if (state.phase !== "fixing") {
    reject(
      `Debug Mode blocked a behavioral mutation during phase ${state.phase}`,
      "For instrumentation, checkpoint phase instrumenting and insert only a debug_probe_prepare marker; otherwise finish the reproduced pre-fix run, read evidence, and checkpoint phase fixing",
    )
  }
  await validateFixAuthorization(session, input.evidenceFor(session), state)
  const requested = mutationPaths(input.args)
  if (requested.length === 0) {
    reject(
      "Debug Mode could not determine the file scope of this mutation",
      "Use the edit tool with an explicit filePath listed in the checkpoint fixedFiles array",
    )
  }
  const normalizedRequested = requested.map((filename) => normalizeFile(session.directory, filename))
  const requestedFromProjectRoot = normalizedRequested.map((filename) =>
    normalizeFile(session.projectRoot, path.resolve(session.directory, filename)),
  )
  if (requestedFromProjectRoot.some(isOutsideProject)) {
    reject(
      "Debug Mode blocked a mutation outside the owned project",
      "Keep the evidence-backed fix and fixedFiles scope inside the active worktree",
    )
  }
  const allowed = new Set(
    state.fixedFiles
      .map((filename) => normalizeFile(session.projectRoot, filename))
      .filter((filename) => !isOutsideProject(filename)),
  )
  const outsideScope = requestedFromProjectRoot.filter((filename) => !allowed.has(filename))
  if (outsideScope.length > 0) {
    reject(
      `Debug Mode blocked files outside the evidence-backed fix scope: ${outsideScope.join(", ")}`,
      "Checkpoint the evidence-backed decision and complete fixedFiles scope before editing",
    )
  }
}

export async function recordBehavioralMutation(input: {
  registry: SessionRegistry
  sessionID: string
  tool: string
  args: unknown
  clock: Clock
}): Promise<void> {
  if (!MUTATION_TOOLS.has(input.tool.toLowerCase())) return
  const session = await input.registry.requireOwned(input.sessionID)
  const state = await session.investigationStore.read()
  if (state.phase === "instrumenting") {
    await recordOwnedProbeInsertions(session, input.args)
    return
  }
  if (state.phase !== "fixing") return
  const paths = mutationPaths(input.args).map((filename) =>
    normalizeFile(session.projectRoot, path.resolve(session.directory, filename)),
  )
  const now = input.clock.now().toISOString()
  await session.manifestStore.modify((manifest) => ({
    ...manifest,
    fixStartedAt: manifest.fixStartedAt ?? now,
    lastBehavioralMutationAt: now,
    behavioralRevision: (manifest.behavioralRevision ?? 0) + 1,
    behavioralMutations: [
      ...(manifest.behavioralMutations ?? []),
      {
        revision: (manifest.behavioralRevision ?? 0) + 1,
        tool: input.tool.toLowerCase(),
        paths,
        completedAt: now,
      },
    ],
  }))
}
