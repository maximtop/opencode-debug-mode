import { createHash } from "node:crypto"
import path from "node:path"
import type { ManifestProbe } from "../session/types.js"
import {
  canonicalProjectFileExists,
  ProjectFileRewriteRollbackError,
  readCanonicalProjectFile,
  rewriteCanonicalProjectFile,
} from "./source-safety.js"

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

function helperImportMarkers(block: string): { start: string; end: string } | undefined {
  const lines = block.split(/\r?\n/u).map((line) => line.trim())
  const starts = lines.filter(
    (line) =>
      line.startsWith("/* DEBUG-START opencode-debug-mode ") &&
      line.includes(" resource=transport-import ") &&
      line.endsWith(" */"),
  )
  const ends = lines.filter(
    (line) =>
      line.startsWith("/* DEBUG-END opencode-debug-mode ") &&
      line.includes(" resource=transport-import ") &&
      line.endsWith(" */"),
  )
  if (starts.length !== 1 || ends.length !== 1 || starts[0] === undefined || ends[0] === undefined) return undefined
  return { start: starts[0], end: ends[0] }
}

function containsRelatedHelperMarker(source: string, probeId: string): boolean {
  return source
    .split(/\r?\n/u)
    .some(
      (line) =>
        line.includes("opencode-debug-mode") &&
        line.includes(`probe=${probeId}`) &&
        line.includes("resource=transport-import") &&
        (line.includes("DEBUG-START") || line.includes("DEBUG-END")),
    )
}

function withoutExactBlock(source: string, block: string | undefined): string {
  if (block === undefined || occurrences(source, block) !== 1) return source
  const index = source.indexOf(block)
  return source.slice(0, index) + source.slice(index + block.length)
}

function helperImportIdentity(block: string | undefined): { emitter?: string; specifier?: string } {
  if (block === undefined) return {}
  const emitter = /\b__opencodeDebugEmit\s+as\s+([$A-Z_a-z][$\w]*)/u.exec(block)?.[1]
  const specifier = /\bfrom\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/u.exec(block)?.[1]
  return {
    ...(emitter === undefined ? {} : { emitter }),
    ...(specifier === undefined ? {} : { specifier }),
  }
}

function probeRemnantIndex(source: string, probe: ManifestProbe): number {
  const withoutOwnedImport =
    probe.helperSourceFile === probe.sourceFile ? withoutExactBlock(source, probe.helperImportBlock) : source
  const probeIdIndex = withoutOwnedImport.indexOf(JSON.stringify(probe.id))
  if (probeIdIndex >= 0) return probeIdIndex
  const { emitter } = helperImportIdentity(probe.helperImportBlock)
  return emitter === undefined ? -1 : withoutOwnedImport.indexOf(emitter)
}

function helperImportRemnantIndex(source: string, probe: ManifestProbe): number {
  const withoutOwnedProbe =
    probe.helperSourceFile === probe.sourceFile ? withoutExactBlock(source, probe.expectedBlock) : source
  const { emitter, specifier } = helperImportIdentity(probe.helperImportBlock)
  const emitterIndex = emitter === undefined ? -1 : withoutOwnedProbe.indexOf(emitter)
  if (emitterIndex >= 0) return emitterIndex
  return specifier === undefined ? -1 : withoutOwnedProbe.indexOf(specifier)
}

type SourceSnapshot =
  | { status: "content"; file: string; source: string }
  | { status: "missing"; file: string }
  | { status: "unsafe"; file: string }

type RemovalPreflight =
  | { status: "ready"; file: string; source: string; block: string; kind: "marker" | "helper" }
  | ProbeRemovalResult

async function sourceSnapshot(
  projectRoot: string,
  filename: string,
  cache: Map<string, Promise<SourceSnapshot>>,
): Promise<SourceSnapshot> {
  const file = path.resolve(filename)
  const cached = cache.get(file)
  if (cached !== undefined) return cached
  const pending = (async (): Promise<SourceSnapshot> => {
    try {
      return { status: "content", file, source: await readCanonicalProjectFile(projectRoot, file) }
    } catch {
      try {
        return (await canonicalProjectFileExists(projectRoot, file))
          ? { status: "unsafe", file }
          : { status: "missing", file }
      } catch {
        return { status: "unsafe", file }
      }
    }
  })()
  cache.set(file, pending)
  return pending
}

async function preflightOwnedMarker(
  probe: ManifestProbe,
  projectRoot: string,
  cache: Map<string, Promise<SourceSnapshot>>,
): Promise<RemovalPreflight> {
  const snapshot = await sourceSnapshot(projectRoot, probe.sourceFile, cache)
  if (snapshot.status === "missing") return { status: "already-clean", file: snapshot.file }
  if (snapshot.status === "unsafe") {
    return { status: "failed", file: snapshot.file, reason: "source-path-unsafe" }
  }
  const { source } = snapshot
  const starts = occurrences(source, probe.markerStart)
  const ends = occurrences(source, probe.markerEnd)
  if (starts === 0 && ends === 0) {
    const remnantIndex = probeRemnantIndex(source, probe)
    if (remnantIndex >= 0) {
      return {
        status: "failed",
        file: snapshot.file,
        reason: "marker-content-mismatch",
        line: lineAt(source, remnantIndex),
      }
    }
    return { status: "already-clean", file: snapshot.file }
  }
  const startIndex = source.indexOf(probe.markerStart)
  if (starts !== 1 || ends !== 1 || startIndex < 0) {
    return {
      status: "failed",
      file: snapshot.file,
      reason: "marker-ambiguous",
      ...(startIndex < 0 ? {} : { line: lineAt(source, startIndex) }),
    }
  }
  if (probe.expectedBlock === undefined || probe.expectedHash === undefined) {
    return {
      status: "failed",
      file: snapshot.file,
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
      file: snapshot.file,
      reason: "marker-content-mismatch",
      line: lineAt(source, startIndex),
    }
  }
  return { status: "ready", file: snapshot.file, source, block: probe.expectedBlock, kind: "marker" }
}

async function preflightOwnedHelperImport(
  probe: ManifestProbe,
  projectRoot: string,
  cache: Map<string, Promise<SourceSnapshot>>,
): Promise<RemovalPreflight> {
  if (probe.helperSourceFile === undefined || probe.helperImportBlock === undefined) {
    if (
      probe.transport !== "process" ||
      probe.helperSourceFile !== undefined ||
      probe.helperImportBlock !== undefined ||
      probe.helperImportHash !== undefined
    ) {
      return {
        status: "failed",
        file: probe.helperSourceFile ?? probe.sourceFile,
        reason: "helper-import-ownership-incomplete",
      }
    }
    return { status: "already-clean", file: probe.sourceFile }
  }
  const markers = helperImportMarkers(probe.helperImportBlock)
  if (markers === undefined) {
    return { status: "failed", file: probe.helperSourceFile, reason: "helper-import-ownership-incomplete" }
  }
  const snapshot = await sourceSnapshot(projectRoot, probe.helperSourceFile, cache)
  if (snapshot.status === "missing") return { status: "already-clean", file: snapshot.file }
  if (snapshot.status === "unsafe") {
    return { status: "failed", file: snapshot.file, reason: "helper-import-path-unsafe" }
  }
  const { source } = snapshot
  const count = occurrences(source, probe.helperImportBlock)
  const starts = occurrences(source, markers.start)
  const ends = occurrences(source, markers.end)
  if (count === 0 && starts === 0 && ends === 0 && !containsRelatedHelperMarker(source, probe.id)) {
    const remnantIndex = helperImportRemnantIndex(source, probe)
    if (remnantIndex >= 0) {
      return {
        status: "failed",
        file: snapshot.file,
        reason: "helper-import-content-mismatch",
        line: lineAt(source, remnantIndex),
      }
    }
    return { status: "already-clean", file: snapshot.file }
  }
  if (
    count !== 1 ||
    starts !== 1 ||
    ends !== 1 ||
    probe.helperImportHash === undefined ||
    createHash("sha256").update(probe.helperImportBlock).digest("hex") !== probe.helperImportHash
  ) {
    const markerIndex = source.indexOf(markers.start)
    return {
      status: "failed",
      file: snapshot.file,
      reason: "helper-import-content-mismatch",
      ...(markerIndex < 0 ? {} : { line: lineAt(source, markerIndex) }),
    }
  }
  return { status: "ready", file: snapshot.file, source, block: probe.helperImportBlock, kind: "helper" }
}

type FileRewrite = Readonly<{
  file: string
  source: string
  replacement: string
  kinds: ReadonlySet<"marker" | "helper">
}>

function fileRewrites(plans: Array<Extract<RemovalPreflight, { status: "ready" }>>): FileRewrite[] {
  const grouped = new Map<string, Array<Extract<RemovalPreflight, { status: "ready" }>>>()
  for (const plan of plans) grouped.set(plan.file, [...(grouped.get(plan.file) ?? []), plan])
  return [...grouped.entries()].map(([file, group]) => {
    const source = group[0]?.source ?? ""
    const indexed = group
      .map((plan) => ({ ...plan, index: source.indexOf(plan.block) }))
      .sort((left, right) => right.index - left.index)
    let replacement = source
    for (const plan of indexed) {
      replacement = replacement.slice(0, plan.index) + replacement.slice(plan.index + plan.block.length)
    }
    return { file, source, replacement, kinds: new Set(group.map((plan) => plan.kind)) }
  })
}

async function rollbackRewrites(projectRoot: string, rewrites: FileRewrite[]): Promise<boolean> {
  let complete = true
  for (const rewrite of [...rewrites].reverse()) {
    try {
      if (!(await rewriteCanonicalProjectFile(projectRoot, rewrite.file, rewrite.replacement, rewrite.source))) {
        complete = false
      }
    } catch {
      complete = false
    }
  }
  return complete
}

async function applyRewrites(projectRoot: string, rewrites: FileRewrite[]): Promise<ProbeRemovalResult | undefined> {
  const applied: FileRewrite[] = []
  for (const rewrite of rewrites) {
    let currentRollbackFailed = false
    try {
      if (await rewriteCanonicalProjectFile(projectRoot, rewrite.file, rewrite.source, rewrite.replacement)) {
        applied.push(rewrite)
        continue
      }
    } catch (error) {
      currentRollbackFailed = error instanceof ProjectFileRewriteRollbackError
      // The preflight snapshot no longer has a safe canonical identity.
    }
    const rolledBack = await rollbackRewrites(projectRoot, applied)
    return {
      status: "failed",
      file: rewrite.file,
      reason:
        rolledBack && !currentRollbackFailed
          ? rewrite.kinds.has("marker")
            ? "concurrent-source-change"
            : "concurrent-helper-import-change"
          : "atomic-removal-rollback-failed",
    }
  }
  return undefined
}

export async function removeOwnedProbe(
  probe: ManifestProbe,
  projectRoot = path.dirname(probe.sourceFile),
): Promise<ProbeRemovalResult> {
  const cache = new Map<string, Promise<SourceSnapshot>>()
  const [marker, helperImport] = await Promise.all([
    preflightOwnedMarker(probe, projectRoot, cache),
    preflightOwnedHelperImport(probe, projectRoot, cache),
  ])
  if (marker.status === "failed") return marker
  if (helperImport.status === "failed") return helperImport
  const ready = [marker, helperImport].filter(
    (plan): plan is Extract<RemovalPreflight, { status: "ready" }> => plan.status === "ready",
  )
  if (ready.length === 0) return { status: "already-clean", file: probe.sourceFile }
  const failure = await applyRewrites(projectRoot, fileRewrites(ready))
  if (failure !== undefined) return failure
  const markerRewrite = ready.find((plan) => plan.kind === "marker")
  const helperRewrite = ready.find((plan) => plan.kind === "helper")
  if (markerRewrite !== undefined || helperRewrite !== undefined) {
    return { status: "success", file: markerRewrite?.file ?? helperRewrite?.file ?? probe.sourceFile }
  }
  return { status: "already-clean", file: probe.sourceFile }
}
