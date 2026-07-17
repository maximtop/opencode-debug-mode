import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { DebugModeError } from "../core/errors.js"
import type { EventInput } from "../evidence/types.js"
import type { ManifestStore } from "../session/manifest-store.js"
import { isContained } from "../session/paths.js"
import type { CleanupManifest, ManifestProbe } from "../session/types.js"
import { removeOwnedProbe } from "./remove.js"
import { canonicalProjectFile, readCanonicalProjectFile, sourceCodeContextAt } from "./source-safety.js"
import { assertProbeStatementBoundary } from "./statement-boundary.js"
import { createProbeTemplate } from "./template.js"
import { type ProbeMarkerEdit, type ProbePlanInput, SAFE_CAPTURE } from "./types.js"

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"])
const SOURCE_CONTEXT_RADIUS = 8
const SOURCE_CONTEXT_LINE_LIMIT = 512

function probeId(): string {
  return `probe_${randomBytes(16).toString("base64url")}`
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function probeMarkerEditHash(edit: Pick<ProbeMarkerEdit, "oldString" | "newString">): string {
  return sha256(JSON.stringify({ oldString: edit.oldString, newString: edit.newString }))
}

function markerLines(sessionId: string, input: ProbePlanInput, id: string) {
  const ownership = `opencode-debug-mode session=${sessionId} run=${input.runId} hypothesis=${input.hypothesisId} probe=${id}`
  return { start: `/* DEBUG-START ${ownership} */`, end: `/* DEBUG-END ${ownership} */` }
}

function importSpecifier(fromFile: string, targetFile: string): string {
  const relative = path.relative(path.dirname(fromFile), targetFile).split(path.sep).join("/")
  return relative.startsWith(".") ? relative : `./${relative}`
}

function emitterIdentifier(id: string): string {
  return `__opencodeDebugEmit_${sha256(id).slice(0, 12)}`
}

function helperImportBlock(
  sessionId: string,
  input: ProbePlanInput,
  id: string,
  specifier: string,
  emitter: string,
): string {
  const ownership = `opencode-debug-mode session=${sessionId} run=${input.runId} hypothesis=${input.hypothesisId} probe=${id} resource=transport-import`
  return `/* DEBUG-START ${ownership} */\nimport { __opencodeDebugEmit as ${emitter} } from ${JSON.stringify(specifier)}\n/* DEBUG-END ${ownership} */`
}

function occurrences(value: string, needle: string): number {
  return needle.length === 0 ? 0 : value.split(needle).length - 1
}

function lineStartOffset(source: string, line: number): number | undefined {
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const ending = /\r\n|\r|\n/u.exec(source.slice(offset))
    if (ending === null) return undefined
    offset += ending.index + ending[0].length
  }
  return offset
}

type SourceLineRecord = Readonly<{
  start: number
  end: number
  text: string
}>

function sourceLineRecords(source: string): SourceLineRecord[] {
  const records: SourceLineRecord[] = []
  let start = 0
  for (const ending of source.matchAll(/\r\n|\r|\n/gu)) {
    records.push({ start, end: ending.index + ending[0].length, text: source.slice(start, ending.index) })
    start = ending.index + ending[0].length
  }
  records.push({ start, end: source.length, text: source.slice(start) })
  return records
}

function nativeLineEnding(source: string): string {
  return /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n"
}

function normalizeLineEndings(value: string, lineEnding: string): string {
  return value.replace(/\r\n|\r|\n/gu, lineEnding)
}

function isUniqueSubstring(source: string, value: string): boolean {
  if (value.length === 0) return false
  const first = source.indexOf(value)
  return first >= 0 && source.indexOf(value, first + 1) < 0
}

function canonicalMarkerEdit(input: {
  source: string
  records: SourceLineRecord[]
  sourceLineIndex: number
  insertionOffset: number
  markerBlock: string
  lineEnding: string
  filePath: string
}): ProbeMarkerEdit {
  const { source, records, sourceLineIndex, insertionOffset, markerBlock, lineEnding, filePath } = input
  let selected: Readonly<{ start: number; end: number; oldString: string }> | undefined

  for (let extraLines = 0; extraLines < records.length && selected === undefined; extraLines += 1) {
    const candidates: Array<Readonly<{ start: number; end: number; oldString: string }>> = []
    for (let linesBefore = 0; linesBefore <= extraLines; linesBefore += 1) {
      const linesAfter = extraLines - linesBefore
      const startLine = sourceLineIndex - linesBefore
      const endLine = sourceLineIndex + linesAfter
      if (startLine < 0 || endLine >= records.length) continue
      const start = records[startLine]?.start
      const end = records[endLine]?.end
      if (start === undefined || end === undefined || start > insertionOffset || insertionOffset > end) continue
      const oldString = source.slice(start, end)
      if (isUniqueSubstring(source, oldString)) candidates.push({ start, end, oldString })
    }
    selected = candidates.sort(
      (left, right) => left.oldString.length - right.oldString.length || left.start - right.start,
    )[0]
  }

  if (selected === undefined) {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      "A unique source context could not be prepared for the probe marker edit",
      false,
      {
        action: "Choose a non-empty executable source line with stable surrounding context and prepare the probe again",
      },
    )
  }
  const relativeOffset = insertionOffset - selected.start
  return {
    filePath,
    oldString: selected.oldString,
    newString:
      selected.oldString.slice(0, relativeOffset) + markerBlock + lineEnding + selected.oldString.slice(relativeOffset),
  }
}

function boundedSourceLine(value: string): string {
  return value.length <= SOURCE_CONTEXT_LINE_LIMIT ? value : `${value.slice(0, SOURCE_CONTEXT_LINE_LIMIT - 1)}…`
}

function sourceContext(lines: string[], sourceLine: number): Array<Readonly<{ line: number; text: string }>> {
  const start = Math.max(0, sourceLine - 1 - SOURCE_CONTEXT_RADIUS)
  const end = Math.min(lines.length, sourceLine + SOURCE_CONTEXT_RADIUS)
  return lines.slice(start, end).map((text, index) => ({
    line: start + index + 1,
    text: boundedSourceLine(text),
  }))
}

function assertExecutableStatementBoundary(source: string, offset: number): void {
  const context = sourceCodeContextAt(source, offset)
  if (!context.inCode) {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      "Probe marker must be placed in executable code, not string or comment content",
      false,
      { action: "Choose a non-empty executable statement boundary and prepare the probe again" },
    )
  }
  if (context.innermostDelimiter === "(" || context.innermostDelimiter === "[") {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      `Probe marker cannot be inserted while an expression delimiter ${context.innermostDelimiter} is still open`,
      false,
      {
        action:
          "Choose the first non-empty executable line after the containing call, argument list, or array expression; a callback block nested inside the call remains a valid boundary",
      },
    )
  }
}

function sourceWithoutOwnedBlock(source: string, blockOffset: number, block: string): string {
  const end = withoutFollowingLineBreak(source, blockOffset + block.length, block)
  return source.slice(0, blockOffset) + source.slice(end)
}

function sourceLocationAtOffset(source: string, offset: number): Readonly<{ line: number; column: number }> {
  const boundedOffset = Math.max(0, Math.min(offset, source.length))
  let line = 1
  let lineOffset = 0
  const endings = /\r\n|\r|\n/gu
  for (const ending of source.matchAll(endings)) {
    if (ending.index + ending[0].length > boundedOffset) break
    line += 1
    lineOffset = ending.index + ending[0].length
  }
  return { line, column: boundedOffset - lineOffset + 1 }
}

type OwnedInsertion = Readonly<{
  block: string
  sourceFile: string
  probeId: string
  kind: "probe" | "helper"
  exact: boolean
}>

function ownedInsertions(manifest: CleanupManifest, sourceFile: string): OwnedInsertion[] {
  return manifest.probes.flatMap((probe): OwnedInsertion[] => [
    ...(probe.sourceFile === sourceFile && probe.expectedBlock !== undefined
      ? [
          {
            block: probe.expectedBlock,
            sourceFile: probe.sourceFile,
            probeId: probe.id,
            kind: "probe" as const,
            exact: probe.expectedBlockIsExactInsertion === true,
          },
        ]
      : []),
    ...(probe.helperSourceFile === sourceFile && probe.helperImportBlock !== undefined
      ? [
          {
            block: probe.helperImportBlock,
            sourceFile: probe.helperSourceFile,
            probeId: probe.id,
            kind: "helper" as const,
            exact: probe.helperImportBlockIsExactInsertion === true,
          },
        ]
      : []),
  ])
}

function withoutFollowingLineBreak(value: string, offset: number, block: string): number {
  if (block.endsWith("\n") || block.endsWith("\r")) return offset
  if (value.startsWith("\r\n", offset)) return offset + 2
  return value[offset] === "\n" || value[offset] === "\r" ? offset + 1 : offset
}

function stripOwnedInsertions(source: string, insertions: OwnedInsertion[]): string {
  let normalized = source
  for (const insertion of insertions) {
    const count = occurrences(normalized, insertion.block)
    if (count > 1) {
      throw new DebugModeError("MARKER_MISMATCH", "An owned instrumentation block is not unique")
    }
    if (count === 0) continue
    const start = normalized.indexOf(insertion.block)
    const blockEnd = start + insertion.block.length
    const end = insertion.exact ? blockEnd : withoutFollowingLineBreak(normalized, blockEnd, insertion.block)
    normalized = normalized.slice(0, start) + normalized.slice(end)
  }
  return normalized
}

function assertInsertionAnchor(input: {
  manifest: CleanupManifest
  probe: ManifestProbe
  source: string
  blockOffset: number
}): void {
  const { insertionAnchor, expectedBlock } = input.probe
  if (insertionAnchor === undefined || expectedBlock === undefined) {
    throw new DebugModeError("MARKER_MISMATCH", "Probe insertion location ownership is incomplete")
  }
  const otherInsertions = ownedInsertions(input.manifest, input.probe.sourceFile).filter(
    (insertion) => !(insertion.probeId === input.probe.id && insertion.kind === "probe"),
  )
  const normalizedSource = stripOwnedInsertions(input.source, ownedInsertions(input.manifest, input.probe.sourceFile))
  const prefix = stripOwnedInsertions(input.source.slice(0, input.blockOffset), otherInsertions)
  const sourceMatches = sha256(normalizedSource) === insertionAnchor.sourceSha256
  if (!sourceMatches || ![insertionAnchor.sourceOffset, insertionAnchor.indentedSourceOffset].includes(prefix.length)) {
    const actualLocation = sourceLocationAtOffset(normalizedSource, prefix.length)
    throw new DebugModeError(
      "MARKER_MISMATCH",
      `Owned probe marker is not at its declared source location (line ${input.probe.sourceLine}; expected offset ${insertionAnchor.sourceOffset} or ${insertionAnchor.indentedSourceOffset}, found ${prefix.length}; source match ${sourceMatches})`,
      false,
      {
        action: sourceMatches
          ? `Call debug_probe_remove with probeId ${input.probe.id}; it removes the marker and companion helper import. Re-read the source, choose the intended non-empty executable boundary, prepare a replacement, and invoke its returned markerEdit verbatim. Do not infer a replacement sourceLine from the misplaced marker. Never edit or revert either owned block manually.`
          : `Call debug_probe_remove with probeId ${input.probe.id}; it removes the marker and companion helper import. Re-read the changed source, choose the intended non-empty executable boundary, prepare a replacement, and invoke its returned markerEdit verbatim. Never edit or revert either owned block manually.`,
        details: {
          actualOffset: prefix.length,
          actualSourceLine: actualLocation.line,
          actualSourceColumn: actualLocation.column,
          sourceOffset: insertionAnchor.sourceOffset,
          indentedSourceOffset: insertionAnchor.indentedSourceOffset,
          sourceMatches,
        },
      },
    )
  }
}

function indentOwnedBlock(block: string, indentation: string): string {
  return indentation.length === 0
    ? block
    : block
        .split("\n")
        .map((line) => `${indentation}${line}`)
        .join("\n")
}

function retryableStale(error: unknown, attempt: number): boolean {
  return error instanceof DebugModeError && error.code === "STALE_REVISION" && attempt < 2
}

function assertOwnedBlock(input: {
  source: string
  block: string | undefined
  hash: string | undefined
  markerStart: string
  markerEnd: string
  kind: "probe" | "helper"
}): number {
  if (input.block === undefined || input.hash === undefined || sha256(input.block) !== input.hash) {
    throw new DebugModeError("MARKER_MISMATCH", `Owned ${input.kind} content or hash is incomplete`)
  }
  const count = occurrences(input.source, input.block)
  if (count === 0) throw new DebugModeError("MARKER_MISSING", `Owned ${input.kind} marker is missing`)
  if (count !== 1) throw new DebugModeError("MARKER_MISMATCH", `Owned ${input.kind} marker is not unique`)
  const markerOffset = input.block.indexOf(input.markerStart)
  if (
    markerOffset < 0 ||
    occurrences(input.block, input.markerStart) !== 1 ||
    occurrences(input.block, input.markerEnd) !== 1 ||
    input.block.indexOf(input.markerEnd) <= markerOffset
  ) {
    throw new DebugModeError("MARKER_MISMATCH", `Owned ${input.kind} marker boundaries are invalid`)
  }
  const blockOffset = input.source.indexOf(input.block)
  const context = sourceCodeContextAt(input.source, blockOffset + markerOffset)
  if (!context.inCode || (input.kind === "helper" && context.braceDepth !== 0)) {
    throw new DebugModeError(
      "MARKER_MISMATCH",
      input.kind === "helper"
        ? "Owned transport import must be executable at module scope"
        : "Owned probe marker must be at an executable statement boundary, not inside an expression, string, or comment",
    )
  }
  return blockOffset
}

export class ProbeRegistry {
  constructor(
    private readonly store: ManifestStore,
    private readonly projectRoot: string,
    private readonly hypothesisFingerprint: (id: string) => Promise<string | undefined>,
  ) {}

  async plan(
    input: ProbePlanInput,
    staleAttempt = 0,
  ): Promise<
    ManifestProbe & {
      markerBlock: string
      markerEdit: ProbeMarkerEdit
      sourceLineText: string
      sourceContext: Array<Readonly<{ line: number; text: string }>>
    }
  > {
    const manifest = await this.store.read()
    if (!manifest.runs.some((run) => run.id === input.runId))
      throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    const hypothesisSha256 = await this.hypothesisFingerprint(input.hypothesisId)
    if (hypothesisSha256 === undefined) {
      throw new DebugModeError("STATE_INVALID", "Hypothesis was not found in the checkpoint")
    }
    if (!Number.isInteger(input.sourceLine) || input.sourceLine < 1) {
      throw new DebugModeError("MARKER_MISMATCH", "Source line must be one-based")
    }
    if (input.message.length < 1 || Buffer.byteLength(input.message) > 8_192) {
      throw new DebugModeError("MARKER_MISMATCH", "Probe message is invalid")
    }
    if (input.captures.length > 20 || input.captures.some((capture) => !SAFE_CAPTURE.test(capture.path))) {
      throw new DebugModeError("UNSAFE_CAPTURE", "Probe capture path is unsafe")
    }

    const absoluteSource = path.resolve(this.projectRoot, input.sourceFile)
    if (!isContained(this.projectRoot, absoluteSource)) {
      throw new DebugModeError("HELPER_PATH_UNSAFE", "Probe source is outside the project")
    }
    if (!SUPPORTED_EXTENSIONS.has(path.extname(absoluteSource).toLowerCase())) {
      throw new DebugModeError("UNSUPPORTED_LANGUAGE", "Only JavaScript and TypeScript probes are supported")
    }
    const canonicalSource = await canonicalProjectFile(this.projectRoot, absoluteSource)
    if (!isContained(this.projectRoot, canonicalSource)) {
      throw new DebugModeError("HELPER_PATH_UNSAFE", "Probe source resolves outside the project")
    }
    const sourceAtPlan = await readCanonicalProjectFile(this.projectRoot, canonicalSource)
    const lineEnding = nativeLineEnding(sourceAtPlan)
    const records = sourceLineRecords(sourceAtPlan)
    const sourceLines = records.map((record) => record.text)
    const sourceLine = sourceLines[input.sourceLine - 1]
    const insertionOffset = lineStartOffset(sourceAtPlan, input.sourceLine)
    if (sourceLine === undefined || insertionOffset === undefined) {
      throw new DebugModeError("MARKER_MISMATCH", "Source line is beyond the end of the probe file")
    }
    const explicitEof = insertionOffset === sourceAtPlan.length && input.sourceLine === records.length
    if (sourceLine.trim().length === 0 && (!explicitEof || sourceAtPlan.length === 0)) {
      throw new DebugModeError(
        "MARKER_MISMATCH",
        "Source line must be a non-empty executable boundary; only the explicit end-of-file boundary may be empty",
        false,
        { action: "Choose the next non-empty executable line that should run after the probe" },
      )
    }
    assertExecutableStatementBoundary(sourceAtPlan, insertionOffset)
    assertProbeStatementBoundary({
      source: sourceAtPlan,
      offset: insertionOffset,
      sourceFile: canonicalSource,
      captures: input.captures,
    })
    const existingInsertions = ownedInsertions(manifest, canonicalSource)
    if (
      existingInsertions.some((insertion) => {
        const start = sourceAtPlan.indexOf(insertion.block)
        return start >= 0 && start <= insertionOffset && insertionOffset < start + insertion.block.length
      })
    ) {
      throw new DebugModeError("MARKER_MISMATCH", "A probe cannot be planned inside owned instrumentation")
    }
    const anchorPrefix = stripOwnedInsertions(sourceAtPlan.slice(0, insertionOffset), existingInsertions)
    const anchorSuffix = stripOwnedInsertions(sourceAtPlan.slice(insertionOffset), existingInsertions)
    const indentation = /^[\t ]*/u.exec(sourceLine)?.[0] ?? ""

    const id = probeId()
    const emitter = emitterIdentifier(id)
    let canonicalHelperSource: string | undefined
    let ownedHelperImportBlock: string | undefined
    if (input.transport === "process") {
      if (input.helperSourceFile !== undefined) {
        throw new DebugModeError("STATE_INVALID", "Process probes do not use a browser transport helper")
      }
    } else {
      if (input.transport === "extension-content" && input.helperSourceFile === undefined) {
        throw new DebugModeError(
          "STATE_INVALID",
          "Extension content probes require the background module that loads the transport helper",
        )
      }
      const helpers = manifest.ownedFiles.filter((owned) => owned.kind === "transport-helper")
      if (helpers.length !== 1 || helpers[0] === undefined) {
        throw new DebugModeError(
          "COLLECTOR_REQUIRED",
          "A non-process probe requires exactly one active owned transport helper",
        )
      }
      if (input.transport !== "extension-content" && input.helperSourceFile !== undefined) {
        throw new DebugModeError(
          "STATE_INVALID",
          "Background and web probes import the transport helper in their own source module",
          false,
          {
            action:
              "Retry without helperSourceFile; use helperSourceFile only for an extension-content probe's loaded background listener module",
          },
        )
      }
      const requestedHelperSource = path.resolve(
        this.projectRoot,
        input.transport === "extension-content" ? (input.helperSourceFile as string) : input.sourceFile,
      )
      if (!isContained(this.projectRoot, requestedHelperSource)) {
        throw new DebugModeError("HELPER_PATH_UNSAFE", "Transport import source is outside the project")
      }
      canonicalHelperSource = await canonicalProjectFile(this.projectRoot, requestedHelperSource)
      const canonicalHelper = await canonicalProjectFile(this.projectRoot, helpers[0].path)
      if (!isContained(this.projectRoot, canonicalHelperSource) || !isContained(this.projectRoot, canonicalHelper)) {
        throw new DebugModeError("HELPER_PATH_UNSAFE", "Transport helper paths must resolve inside the project")
      }
      if (!SUPPORTED_EXTENSIONS.has(path.extname(canonicalHelperSource).toLowerCase())) {
        throw new DebugModeError("UNSUPPORTED_LANGUAGE", "Transport import source must be JavaScript or TypeScript")
      }
      if (path.extname(canonicalHelperSource).toLowerCase() === ".cjs") {
        throw new DebugModeError(
          "UNSUPPORTED_LANGUAGE",
          "Browser transport probes require an ES module source; static helper imports cannot be inserted into .cjs",
        )
      }
      ownedHelperImportBlock = helperImportBlock(
        manifest.sessionId,
        input,
        id,
        importSpecifier(canonicalHelperSource, canonicalHelper),
        emitter,
      )
    }

    const markers = markerLines(manifest.sessionId, input, id)
    const run = manifest.runs.find((candidate) => candidate.id === input.runId)
    if (run === undefined) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    const markerBlock = normalizeLineEndings(
      input.markerBlock ??
        indentOwnedBlock(
          createProbeTemplate({
            sessionId: manifest.sessionId,
            runId: input.runId,
            runLabel: run.label,
            hypothesisId: input.hypothesisId,
            probeId: id,
            sourceFile: path.relative(this.projectRoot, canonicalSource),
            sourceLine: input.sourceLine,
            message: input.message,
            captures: input.captures,
            transport: input.transport,
            sampling: input.sampling,
            emitterIdentifier: emitter,
          }).markerBlock,
          indentation,
        ),
      lineEnding,
    )
    const markerEdit = canonicalMarkerEdit({
      source: sourceAtPlan,
      records,
      sourceLineIndex: input.sourceLine - 1,
      insertionOffset,
      markerBlock,
      lineEnding,
      filePath: canonicalSource,
    })
    const probe: ManifestProbe = {
      id,
      runId: input.runId,
      hypothesisId: input.hypothesisId,
      hypothesisSha256,
      sourceFile: canonicalSource,
      sourceLine: input.sourceLine,
      ...(input.sourceColumn === undefined ? {} : { sourceColumn: input.sourceColumn }),
      message: input.message,
      transport: input.transport,
      captures: input.captures,
      sampling: input.sampling,
      status: "planned",
      validationStatus: "pending",
      markerStart: markers.start,
      markerEnd: markers.end,
      expectedBlock: markerBlock,
      expectedHash: sha256(markerBlock),
      markerEditHash: probeMarkerEditHash(markerEdit),
      insertionAnchor: {
        sourceOffset: anchorPrefix.length,
        indentedSourceOffset: anchorPrefix.length + indentation.length,
        sourceSha256: sha256(anchorPrefix + anchorSuffix),
      },
      ...(canonicalHelperSource === undefined ? {} : { helperSourceFile: canonicalHelperSource }),
      ...(ownedHelperImportBlock === undefined ? {} : { helperImportBlock: ownedHelperImportBlock }),
      ...(ownedHelperImportBlock === undefined ? {} : { helperImportHash: sha256(ownedHelperImportBlock) }),
    }
    try {
      await this.update(manifest, (value) => ({ ...value, probes: [...value.probes, probe] }))
    } catch (error) {
      if (retryableStale(error, staleAttempt)) return this.plan(input, staleAttempt + 1)
      throw error
    }
    return {
      ...probe,
      markerBlock,
      markerEdit,
      sourceLineText: boundedSourceLine(sourceLine),
      sourceContext: sourceContext(sourceLines, input.sourceLine),
    }
  }

  async register(id: string, staleAttempt = 0): Promise<ManifestProbe> {
    const manifest = await this.store.read()
    const probe = manifest.probes.find((candidate) => candidate.id === id)
    if (probe === undefined) throw new DebugModeError("MARKER_MISSING", "Probe was not planned")
    if (probe.expectedBlock === undefined)
      throw new DebugModeError("MARKER_MISMATCH", "Probe marker content is unavailable")
    if (
      probe.hypothesisSha256 === undefined ||
      (await this.hypothesisFingerprint(probe.hypothesisId)) !== probe.hypothesisSha256
    ) {
      throw new DebugModeError("STATE_INVALID", "The hypothesis changed after this probe was prepared")
    }
    const source = await readCanonicalProjectFile(this.projectRoot, probe.sourceFile)
    const blockOffset = assertOwnedBlock({
      source,
      block: probe.expectedBlock,
      hash: probe.expectedHash,
      markerStart: probe.markerStart,
      markerEnd: probe.markerEnd,
      kind: "probe",
    })
    assertProbeStatementBoundary({
      source: sourceWithoutOwnedBlock(source, blockOffset, probe.expectedBlock),
      offset: blockOffset,
      sourceFile: probe.sourceFile,
      captures: probe.captures,
    })
    assertInsertionAnchor({ manifest, probe, source, blockOffset })
    if (
      probe.helperImportBlock !== undefined ||
      probe.helperSourceFile !== undefined ||
      probe.helperImportHash !== undefined
    ) {
      if (probe.helperSourceFile === undefined || probe.helperImportBlock === undefined) {
        throw new DebugModeError("MARKER_MISMATCH", "Transport helper import ownership is incomplete")
      }
      const helperSource = await readCanonicalProjectFile(this.projectRoot, probe.helperSourceFile)
      const helperStart = probe.helperImportBlock.match(/\/\* DEBUG-START [^\r\n]*resource=transport-import \*\//u)?.[0]
      const helperEnd = probe.helperImportBlock.match(/\/\* DEBUG-END [^\r\n]*resource=transport-import \*\//u)?.[0]
      if (helperStart === undefined || helperEnd === undefined) {
        throw new DebugModeError("MARKER_MISMATCH", "Transport helper import ownership marker is incomplete")
      }
      assertOwnedBlock({
        source: helperSource,
        block: probe.helperImportBlock,
        hash: probe.helperImportHash,
        markerStart: helperStart,
        markerEnd: helperEnd,
        kind: "helper",
      })
    }
    const updated: ManifestProbe = {
      ...probe,
      status: "registered",
      validationStatus: "pending",
    }
    try {
      await this.update(manifest, (value) => ({
        ...value,
        probes: value.probes.map((candidate) => (candidate.id === id ? updated : candidate)),
      }))
    } catch (error) {
      if (retryableStale(error, staleAttempt)) return this.register(id, staleAttempt + 1)
      throw error
    }
    return updated
  }

  async validate(probeIds: string[], staleAttempt = 0): Promise<void> {
    const manifest = await this.store.read()
    const selected = probeIds.map((id) => manifest.probes.find((probe) => probe.id === id))
    if (
      probeIds.length === 0 ||
      selected.some((probe) => probe === undefined || !["registered", "validated"].includes(probe.status))
    ) {
      throw new DebugModeError("MARKER_MISMATCH", "Only registered probes can be validated")
    }
    for (const probe of selected) {
      if (probe === undefined || probe.expectedBlock === undefined) {
        throw new DebugModeError("MARKER_MISMATCH", "Probe marker ownership is incomplete")
      }
      const source = await readCanonicalProjectFile(this.projectRoot, probe.sourceFile)
      const blockOffset = assertOwnedBlock({
        source,
        block: probe.expectedBlock,
        hash: probe.expectedHash,
        markerStart: probe.markerStart,
        markerEnd: probe.markerEnd,
        kind: "probe",
      })
      assertProbeStatementBoundary({
        source: sourceWithoutOwnedBlock(source, blockOffset, probe.expectedBlock),
        offset: blockOffset,
        sourceFile: probe.sourceFile,
        captures: probe.captures,
      })
      assertInsertionAnchor({ manifest, probe, source, blockOffset })
      if (probe.helperImportBlock !== undefined && probe.helperSourceFile !== undefined) {
        const helperSource = await readCanonicalProjectFile(this.projectRoot, probe.helperSourceFile)
        const helperStart = probe.helperImportBlock.match(
          /\/\* DEBUG-START [^\r\n]*resource=transport-import \*\//u,
        )?.[0]
        const helperEnd = probe.helperImportBlock.match(/\/\* DEBUG-END [^\r\n]*resource=transport-import \*\//u)?.[0]
        if (helperStart === undefined || helperEnd === undefined) {
          throw new DebugModeError("MARKER_MISMATCH", "Transport helper import ownership marker is incomplete")
        }
        assertOwnedBlock({
          source: helperSource,
          block: probe.helperImportBlock,
          hash: probe.helperImportHash,
          markerStart: helperStart,
          markerEnd: helperEnd,
          kind: "helper",
        })
      } else if (probe.helperImportBlock !== undefined || probe.helperSourceFile !== undefined) {
        throw new DebugModeError("MARKER_MISMATCH", "Transport helper import ownership is incomplete")
      }
    }
    try {
      await this.update(manifest, (value) => ({
        ...value,
        probes: value.probes.map((probe) =>
          probeIds.includes(probe.id)
            ? { ...probe, status: "validated" as const, validationStatus: "validated" as const }
            : probe,
        ),
      }))
    } catch (error) {
      if (retryableStale(error, staleAttempt)) return this.validate(probeIds, staleAttempt + 1)
      throw error
    }
  }

  async remove(id: string, staleAttempt = 0): Promise<ManifestProbe> {
    const manifest = await this.store.read()
    const probe = manifest.probes.find((candidate) => candidate.id === id)
    if (probe === undefined) throw new DebugModeError("MARKER_MISSING", "Probe was not planned")
    if (probe.status === "removed") return probe
    const result = await removeOwnedProbe(probe, this.projectRoot)
    if (result.status === "failed") {
      throw new DebugModeError("MARKER_MISMATCH", `Owned probe could not be removed safely: ${result.reason}`, false, {
        details: {
          file: result.file,
          ...(result.line === undefined ? {} : { line: result.line }),
        },
      })
    }
    const updated: ManifestProbe = {
      ...probe,
      status: "removed",
    }
    try {
      await this.update(manifest, (value) => ({
        ...value,
        probes: value.probes.map((candidate) => (candidate.id === id ? updated : candidate)),
      }))
    } catch (error) {
      if (retryableStale(error, staleAttempt)) return this.remove(id, staleAttempt + 1)
      throw error
    }
    return updated
  }

  async requireValidatedForRun(runId: string): Promise<void> {
    const manifest = await this.store.read()
    if (
      manifest.probes.some(
        (probe) => probe.runId === runId && probe.status !== "removed" && probe.validationStatus !== "validated",
      )
    ) {
      throw new DebugModeError("PROBE_NOT_VALIDATED", "Every active probe must pass an instrumentation check")
    }
  }

  async validateEvent(input: EventInput): Promise<EventInput> {
    const manifest = await this.store.read()
    const probe = manifest.probes.find((candidate) => candidate.id === input.probeId)
    const run = manifest.runs.find((candidate) => candidate.id === input.runId)
    if (
      probe === undefined ||
      run === undefined ||
      probe.validationStatus !== "validated" ||
      !["validated", "active"].includes(probe.status) ||
      !["running", "waiting"].includes(run.status) ||
      input.sessionId !== manifest.sessionId ||
      probe.runId !== input.runId ||
      probe.hypothesisId !== input.hypothesisId ||
      run.label !== input.runLabel
    ) {
      throw new DebugModeError("MARKER_MISMATCH", "Runtime event ownership does not match the registered probe")
    }
    if (
      probe.hypothesisSha256 === undefined ||
      (await this.hypothesisFingerprint(probe.hypothesisId)) !== probe.hypothesisSha256
    ) {
      throw new DebugModeError("STATE_INVALID", "Runtime evidence refers to a hypothesis that changed after planning")
    }
    return {
      ...input,
      source: {
        file: path.relative(this.projectRoot, probe.sourceFile),
        line: probe.sourceLine,
        ...(probe.sourceColumn === undefined ? {} : { column: probe.sourceColumn }),
      },
    }
  }

  private async update(
    manifest: CleanupManifest,
    mutate: (value: CleanupManifest) => CleanupManifest,
  ): Promise<CleanupManifest> {
    return this.store.update(manifest.revision, mutate)
  }
}
