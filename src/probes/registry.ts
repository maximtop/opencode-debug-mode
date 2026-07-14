import { createHash, randomBytes } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { DebugModeError } from "../core/errors.js"
import type { EventInput } from "../evidence/types.js"
import type { ManifestStore } from "../session/manifest-store.js"
import { isContained } from "../session/paths.js"
import type { CleanupManifest, ManifestProbe } from "../session/types.js"
import { createProbeTemplate } from "./template.js"
import { type ProbePlanInput, SAFE_CAPTURE } from "./types.js"

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"])

function probeId(): string {
  return `probe_${randomBytes(16).toString("base64url")}`
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function markerLines(sessionId: string, input: ProbePlanInput, id: string) {
  const ownership = `opencode-debug-mode session=${sessionId} run=${input.runId} hypothesis=${input.hypothesisId} probe=${id}`
  return { start: `/* DEBUG-START ${ownership} */`, end: `/* DEBUG-END ${ownership} */` }
}

export class ProbeRegistry {
  constructor(
    private readonly store: ManifestStore,
    private readonly projectRoot: string,
    private readonly hasHypothesis: (id: string) => Promise<boolean>,
  ) {}

  async plan(input: ProbePlanInput): Promise<ManifestProbe & { markerBlock: string }> {
    const manifest = await this.store.read()
    if (!manifest.runs.some((run) => run.id === input.runId))
      throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    if (!(await this.hasHypothesis(input.hypothesisId))) {
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
    const canonicalSource = await realpath(absoluteSource)
    if (!isContained(this.projectRoot, canonicalSource)) {
      throw new DebugModeError("HELPER_PATH_UNSAFE", "Probe source resolves outside the project")
    }

    const id = probeId()
    const markers = markerLines(manifest.sessionId, input, id)
    const run = manifest.runs.find((candidate) => candidate.id === input.runId)
    if (run === undefined) throw new DebugModeError("RUN_NOT_FOUND", "Run was not found")
    const markerBlock =
      input.markerBlock ??
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
      }).markerBlock
    const probe: ManifestProbe = {
      id,
      runId: input.runId,
      hypothesisId: input.hypothesisId,
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
    }
    await this.update(manifest, (value) => ({ ...value, probes: [...value.probes, probe] }))
    return { ...probe, markerBlock }
  }

  async register(id: string): Promise<ManifestProbe> {
    const manifest = await this.store.read()
    const probe = manifest.probes.find((candidate) => candidate.id === id)
    if (probe === undefined) throw new DebugModeError("MARKER_MISSING", "Probe was not planned")
    if (probe.expectedBlock === undefined)
      throw new DebugModeError("MARKER_MISMATCH", "Probe marker content is unavailable")
    const source = await readFile(probe.sourceFile, "utf8")
    const occurrences = source.split(probe.expectedBlock).length - 1
    if (occurrences === 0) throw new DebugModeError("MARKER_MISSING", "Owned probe marker is missing")
    if (occurrences !== 1) throw new DebugModeError("MARKER_MISMATCH", "Owned probe marker is not unique")
    const updated: ManifestProbe = {
      ...probe,
      expectedHash: sha256(probe.expectedBlock),
      status: "registered",
      validationStatus: "pending",
    }
    await this.update(manifest, (value) => ({
      ...value,
      probes: value.probes.map((candidate) => (candidate.id === id ? updated : candidate)),
    }))
    return updated
  }

  async validate(probeIds: string[]): Promise<void> {
    const manifest = await this.store.read()
    if (probeIds.some((id) => !manifest.probes.some((probe) => probe.id === id && probe.status === "registered"))) {
      throw new DebugModeError("MARKER_MISMATCH", "Only registered probes can be validated")
    }
    await this.update(manifest, (value) => ({
      ...value,
      probes: value.probes.map((probe) =>
        probeIds.includes(probe.id)
          ? { ...probe, status: "validated" as const, validationStatus: "validated" as const }
          : probe,
      ),
    }))
  }

  async requireValidatedForRun(runId: string): Promise<void> {
    const manifest = await this.store.read()
    if (manifest.probes.some((probe) => probe.runId === runId && probe.validationStatus !== "validated")) {
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
      input.sessionId !== manifest.sessionId ||
      probe.runId !== input.runId ||
      probe.hypothesisId !== input.hypothesisId ||
      run.label !== input.runLabel
    ) {
      throw new DebugModeError("MARKER_MISMATCH", "Runtime event ownership does not match the registered probe")
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
    _manifest: CleanupManifest,
    mutate: (value: CleanupManifest) => CleanupManifest,
  ): Promise<CleanupManifest> {
    return this.store.modify(mutate)
  }
}
