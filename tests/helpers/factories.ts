import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { Config, Plugin, ToolContext } from "@opencode-ai/plugin"
import { onTestFinished, vi } from "vitest"
import { CleanupService } from "../../src/cleanup/service.js"
import type { CleanupResult, FinalReportInput } from "../../src/cleanup/types.js"
import { createIngestHandler } from "../../src/collector/ingest.js"
import { createCollectorRouter } from "../../src/collector/router.js"
import { CollectorServer } from "../../src/collector/server.js"
import type { Clock } from "../../src/core/clock.js"
import { EVENT_SCHEMA_VERSION, LIMITS, PROCESS_EVENT_PREFIX } from "../../src/core/constants.js"
import { DebugModeError } from "../../src/core/errors.js"
import { EvidenceStore } from "../../src/evidence/store.js"
import { initialInvestigationState } from "../../src/investigation/store.js"
import { createDebugModePlugin } from "../../src/plugin.js"
import { addLoopbackPermission, removeLoopbackPermission } from "../../src/probes/extension-permissions.js"
import { TransportHelper } from "../../src/probes/helper.js"
import { ProbeRegistry } from "../../src/probes/registry.js"
import { removeOwnedProbe } from "../../src/probes/remove.js"
import { createProbeTemplate } from "../../src/probes/template.js"
import type { ProbeTransport } from "../../src/probes/types.js"
import { ProcessService } from "../../src/process/service.js"
import { RunService } from "../../src/run/service.js"
import { createInitialManifest } from "../../src/session/manifest-store.js"
import type { OrphanRecoveryOptions } from "../../src/session/orphan-recovery.js"
import { type DebugSession, type ProjectContext, SessionRegistry } from "../../src/session/registry.js"
import type { CleanupManifest, ManifestProbe } from "../../src/session/types.js"
import type { DebugToolDependencies } from "../../src/tools/index.js"
import type { RunToolDependencies } from "../../src/tools/run-tools.js"
import { FakeClock } from "./fake-clock.js"

export const eventFixture = {
  schemaVersion: EVENT_SCHEMA_VERSION,
  eventId: "event_fixture",
  timestamp: "2026-07-13T00:00:00.000Z",
  sessionId: "session_fixture",
  runId: "run_fixture",
  runLabel: "pre-fix" as const,
  hypothesisId: "hyp_fixture",
  probeId: "probe_fixture",
  kind: "probe",
  message: "fixture event",
  data: { value: 1 },
  source: { file: "src/example.ts", line: 1 },
}

export function runServiceFixture(
  acquireLease?: (kind: "process" | "waiting") => Promise<() => void> | (() => void),
): RunService {
  let manifest: CleanupManifest = createInitialManifest({
    sessionId: "session_fixture",
    trustedSessionHash: "a".repeat(64),
    projectRoot: "/project",
    sessionDir: "/session",
    now: "2026-07-13T00:00:00.000Z",
  })
  return new RunService(
    {
      read: async () => structuredClone(manifest),
      update: async (expectedRevision, mutate) => {
        if (manifest.revision !== expectedRevision) throw new Error("stale")
        manifest = { ...mutate(structuredClone(manifest)), revision: expectedRevision + 1 }
        return structuredClone(manifest)
      },
    },
    {
      now: () => new Date("2026-07-13T00:00:00.000Z"),
      monotonicMs: () => 0,
    },
    acquireLease,
  )
}

const registryEnvironments = new WeakMap<Clock, Promise<{ container: string; root: string; tempBase: string }>>()
let currentProjectRoot: string | undefined

export async function registryFixture(clock: Clock): Promise<SessionRegistry> {
  let environment = registryEnvironments.get(clock)
  if (environment === undefined) {
    const created = (async () => {
      const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-registry-"))
      const root = path.join(container, "project")
      const tempBase = path.join(container, "opencode-debug-mode-v1")
      await mkdir(root, { recursive: true })
      return { container, root, tempBase }
    })()
    environment = created
    registryEnvironments.set(clock, environment)
    onTestFinished(async () => {
      const value = await created
      await rm(value.container, { recursive: true, force: true })
      currentProjectRoot = undefined
    })
  }
  const value = await environment
  currentProjectRoot = value.root
  return new SessionRegistry(value.tempBase, clock)
}

export function projectContextFixture(): ProjectContext {
  if (currentProjectRoot === undefined) throw new Error("registryFixture must be created first")
  return { directory: currentProjectRoot, worktree: currentProjectRoot }
}

const execFileAsync = promisify(execFile)

export async function createProcessServiceFixture() {
  try {
    await access(path.resolve("dist/process-supervisor.js"))
  } catch {
    await execFileAsync("npm", ["run", "build"], { cwd: process.cwd() })
  }
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-process-"))
  const projectRoot = path.join(container, "project")
  const tempBase = path.join(container, "opencode-debug-mode-v1")
  await mkdir(projectRoot, { recursive: true })
  const trustedId = "trusted-process-fixture"
  const registry = new SessionRegistry(tempBase)
  const session = await registry.start(trustedId, { directory: projectRoot, worktree: projectRoot })
  const runs = new RunService(session.manifestStore)
  const run = await runs.start({ label: "pre-fix", reproduction: "fixture", waitingForUser: false })
  const evidence = new EvidenceStore(session.paths.evidenceFile)
  const service = new ProcessService({
    session,
    runs,
    evidence,
    acquireLease: () => registry.acquireLease(trustedId, "process"),
    supervisorPath: path.resolve("dist/process-supervisor.js"),
  })
  const scriptPath = path.join(projectRoot, "emit-output-and-probe.mjs")
  const event = {
    schemaVersion: 1,
    sessionId: session.publicId,
    runId: run.id,
    runLabel: "pre-fix",
    hypothesisId: "hyp_A",
    probeId: "probe_A",
    timestamp: "2026-07-13T00:00:00.000Z",
    message: "probe evidence",
    source: { file: "fixture.ts", line: 1 },
    data: { value: 42 },
  }
  await writeFile(
    scriptPath,
    `console.log("stdout fixture")\nconsole.error("stderr fixture")\nconsole.error(${JSON.stringify(
      PROCESS_EVENT_PREFIX + JSON.stringify(event),
    )})\nprocess.exitCode = 7\n`,
  )
  onTestFinished(async () => {
    await registry.closeAll()
    await rm(container, { recursive: true, force: true })
  })
  return {
    service,
    session,
    runId: run.id,
    projectRoot,
    script: (name: string) => path.join(projectRoot, name),
  }
}

export function processArgsFixture(overrides: Record<string, unknown> = {}) {
  return {
    approvalClass: "local-deterministic" as const,
    purpose: "reproduction" as const,
    probeIds: [],
    executable: process.execPath,
    args: ["--version"],
    cwd: "/project",
    env: {},
    runId: "run_fixture",
    timeoutMs: 5_000,
    ...overrides,
  }
}

export function toolContextFixture(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "trusted-fixture",
    messageID: "message-fixture",
    agent: "debug",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

export function toolDependenciesFixture(): RunToolDependencies {
  const session = { publicId: "session_fixture" } as unknown as DebugSession
  return {
    registry: { requireOwned: vi.fn().mockResolvedValue(session) },
    processFor: () => ({
      capture: vi.fn().mockResolvedValue({
        processId: "process_fixture",
        runId: "run_fixture",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 1,
        stdoutEvents: 0,
        stderrEvents: 0,
        probeEvents: 0,
      }),
    }),
    probesFor: () => ({
      validate: vi.fn().mockResolvedValue(undefined),
      requireValidatedForRun: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

export async function createCollectorFixture(
  options: {
    registeredProbe?: boolean
    sample?: (event: Record<string, unknown>) => boolean
    atEventLimit?: boolean
  } = {},
) {
  const secret = Buffer.alloc(32, 9).toString("base64url")
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-collector-"))
  const evidenceFile = path.join(container, "evidence.ndjson")
  const evidence = new EvidenceStore(
    evidenceFile,
    undefined,
    undefined,
    options.atEventLimit === true
      ? async () => ({ accepted: LIMITS.events, rejected: 0, sampled: 0, truncated: 0, dropped: 0, requests: 0 })
      : undefined,
  )
  const registered = {
    schemaVersion: 1 as const,
    sessionId: "session_A",
    runId: "run_A",
    runLabel: "pre-fix" as const,
    hypothesisId: "hyp_A",
    probeId: "probe_A",
    timestamp: "2026-07-13T00:00:00.000Z",
    message: "fixture event",
    source: { file: "src/fixture.ts", line: 1 },
    data: { value: 1 },
  }
  const ingest = createIngestHandler({
    evidence,
    ...(options.sample === undefined ? {} : { sample: options.sample }),
    validateEvent: async (event) => {
      if (
        event.sessionId !== registered.sessionId ||
        event.runId !== registered.runId ||
        event.runLabel !== registered.runLabel ||
        event.hypothesisId !== registered.hypothesisId ||
        event.probeId !== registered.probeId ||
        event.source.file !== registered.source.file ||
        event.source.line !== registered.source.line
      ) {
        throw new Error("ownership mismatch")
      }
      return { ...event, source: registered.source }
    },
  })
  const server = new CollectorServer(createCollectorRouter({ token: secret, ingest }))
  let started: Awaited<ReturnType<CollectorServer["start"]>> | undefined
  onTestFinished(async () => {
    await server.close()
    await rm(container, { recursive: true, force: true })
  })
  return {
    authHeaders: { Authorization: `Bearer ${secret}` },
    event: (overrides: Record<string, unknown> = {}) => ({ ...registered, ...overrides }),
    evidenceText: async () => {
      try {
        return await readFile(evidenceFile, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
        throw error
      }
    },
    start: async () => {
      started ??= await server.start()
      return started
    },
  }
}

export async function createCollectorLifecycleFixture(options: { waitingForReproduction?: boolean } = {}) {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-lifecycle-"))
  const projectRoot = path.join(container, "project")
  const tempBase = path.join(container, "opencode-debug-mode-v1")
  await mkdir(projectRoot, { recursive: true })
  const clock = new FakeClock("2026-07-13T00:00:00.000Z")
  const cleanup = vi.fn().mockResolvedValue(undefined)
  const registry = new SessionRegistry(tempBase, clock, async (_session, reason) => cleanup(reason))
  const session = await registry.start("trusted-lifecycle", { directory: projectRoot, worktree: projectRoot })
  if (options.waitingForReproduction === true) {
    const manifest = await session.manifestStore.read()
    await session.manifestStore.update(manifest.revision, (value) => ({ ...value, waitingForReproduction: true }))
  }
  onTestFinished(async () => {
    await registry.closeAll()
    await rm(container, { recursive: true, force: true })
  })
  return { clock, cleanup, tick: () => registry.sweep() }
}

export async function createProbePlanFixture(options: { transport: ProbeTransport }) {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-probe-"))
  const projectRoot = path.join(container, "project")
  await mkdir(projectRoot, { recursive: true })
  const secret = Buffer.alloc(32, 11).toString("base64url")
  const helperRelativePath = "./debug-transport.mjs"
  const helper = new TransportHelper(projectRoot)
  const helperPath = path.join(projectRoot, "debug-transport.mjs")
  onTestFinished(async () => rm(container, { recursive: true, force: true }))
  return {
    secret,
    helperRelativePath,
    helperText: () => readFile(helperPath, "utf8"),
    prepare: async (input: { captures: Array<{ label: string; path: string }> }) => {
      const transport = await helper.create({
        targetPath: "debug-transport.mjs",
        host: "127.0.0.1",
        port: 32123,
        token: secret,
        runtime: options.transport === "extension-background" ? "extension-background" : "web",
      })
      const probeId = "probe_A"
      const template = createProbeTemplate({
        sessionId: "session_A",
        runId: "run_A",
        runLabel: "pre-fix",
        hypothesisId: "hyp_A",
        probeId,
        sourceFile: "src/example.ts",
        sourceLine: 12,
        message: "branch input",
        captures: input.captures,
        transport: options.transport,
        sampling: { mode: "every", n: 1 },
      })
      return {
        probeId,
        markerBlock: template.markerBlock,
        requiredImport: transport.requiredImport,
        helperSha256: transport.sha256,
        helperBytes: transport.bytes,
      }
    },
  }
}

export async function markerFileFixture(options: { before?: string; after?: string; mutateInsideMarker?: boolean }) {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-marker-"))
  const sourceFile = path.join(container, "example.ts")
  const markerStart = "/* DEBUG-START opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A */"
  const markerEnd = "/* DEBUG-END opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A */"
  const expectedBlock = `${markerStart}\nvoid 0\n${markerEnd}\n`
  const actualBlock = options.mutateInsideMarker === true ? expectedBlock.replace("void 0", "void 1") : expectedBlock
  await writeFile(sourceFile, `${options.before ?? ""}${actualBlock}${options.after ?? ""}`)
  const manifestProbe: ManifestProbe = {
    id: "probe_A",
    runId: "run_A",
    hypothesisId: "hyp_A",
    sourceFile,
    sourceLine: 1,
    message: "fixture",
    transport: "process",
    captures: [],
    sampling: { mode: "every", n: 1 },
    status: "registered",
    validationStatus: "pending",
    markerStart,
    markerEnd,
    expectedBlock,
    expectedHash: createHash("sha256").update(expectedBlock).digest("hex"),
  }
  onTestFinished(async () => rm(container, { recursive: true, force: true }))
  return { manifestProbe, read: () => readFile(sourceFile, "utf8") }
}

export async function extensionManifestFixture(options: { manifestVersion: number; unrelatedEdit?: boolean }) {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-extension-"))
  const manifestPath = path.join(container, "manifest.json")
  const property = options.manifestVersion === 2 ? "permissions" : "host_permissions"
  const initial = {
    manifest_version: options.manifestVersion,
    name: "Fixture",
    version: "1.0.0",
    ...(options.unrelatedEdit === true ? { description: "user edit" } : {}),
    [property]: [],
  }
  await writeFile(manifestPath, `${JSON.stringify(initial, null, 2)}\n`)
  onTestFinished(async () => rm(container, { recursive: true, force: true }))
  return {
    path: manifestPath,
    matchPattern: "http://127.0.0.1:32123/*",
    read: () => readFile(manifestPath, "utf8"),
    addUnrelatedPermission: async (permission: string) => {
      const current = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
      const values = current[property] as string[]
      values.push(permission)
      await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`)
    },
  }
}

export async function retainedBundleFixture() {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-retention-"))
  const sessionDir = path.join(container, "session")
  const destination = path.join(container, "retained")
  await mkdir(sessionDir, { recursive: true })
  await mkdir(destination, { recursive: true })
  const evidenceFile = path.join(sessionDir, "evidence.ndjson")
  const stateFile = path.join(sessionDir, "investigation-state.json")
  const token = Buffer.alloc(32, 13).toString("base64url")
  const secretFixture = "security-fixture-secret"
  const evidence = new EvidenceStore(evidenceFile)
  await evidence.append({ ...eventFixture, data: { password: secretFixture, Authorization: `Bearer ${token}` } })
  await writeFile(
    stateFile,
    `${JSON.stringify({
      ...initialInvestigationState("2026-07-13T00:00:00.000Z"),
      problemSummary: `request used ${secretFixture} with bearer ${token}`,
    })}\n`,
  )
  const finalReport: FinalReportInput = {
    outcome: "completed",
    rootCause: "Fixture cause",
    decidingEvidence: ["event_fixture"],
    hypotheses: [{ id: "hyp_fixture", status: "confirmed", statement: "Fixture hypothesis" }],
    fix: "Fixture fix",
    changedFiles: ["src/example.ts"],
    verification: ["Fixture test passed"],
  }
  const cleanupResult: CleanupResult = {
    status: "complete",
    reason: "completed",
    resources: {
      collector: { status: "already-clean" },
      processes: [],
      probes: [],
      permissions: [],
      files: [],
      secret: { status: "success" },
      sessionDirectory: { status: "success" },
    },
    remainingArtifacts: [],
    durationMs: 10,
  }
  onTestFinished(async () => rm(container, { recursive: true, force: true }))
  return {
    token,
    secretFixture,
    input: {
      keepArtifacts: true,
      destination,
      sessionDir,
      evidenceFile,
      stateFile,
      token,
      securityValues: [secretFixture],
      finalReport,
    },
    cleanupResult,
    list: (directory: string) => readdir(directory),
  }
}

export async function createCleanupFixture(options: {
  changedMarker?: boolean
  activeCollector?: boolean
  activeProcess?: boolean
  keepArtifacts?: boolean
}) {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-cleanup-"))
  const projectRoot = path.join(container, "project")
  const tempBase = path.join(container, "opencode-debug-mode-v1")
  const retentionDestination = path.join(container, "retained")
  await mkdir(projectRoot, { recursive: true })
  if (options.keepArtifacts === true) await mkdir(retentionDestination, { recursive: true })
  const registry = new SessionRegistry(tempBase)
  const session = await registry.start(
    "trusted-cleanup",
    { directory: projectRoot, worktree: projectRoot },
    options.keepArtifacts === true ? { keepArtifacts: true, retentionDestination } : {},
  )
  await writeFile(session.paths.evidenceFile, "")
  const sourceFile = path.join(projectRoot, "example.js")
  const markerStart = "/* DEBUG-START opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A */"
  const markerEnd = "/* DEBUG-END opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A */"
  const expectedBlock = `${markerStart}\nvoid 0\n${markerEnd}\n`
  await writeFile(
    sourceFile,
    options.changedMarker === true ? expectedBlock.replace("void 0", "void 1") : expectedBlock,
  )
  const manifest = await session.manifestStore.read()
  await session.manifestStore.update(manifest.revision, (value) => ({
    ...value,
    collector:
      options.activeCollector === true
        ? {
            id: "collector_A",
            host: "127.0.0.1",
            port: 32123,
            status: "ready",
            startedAt: new Date().toISOString(),
          }
        : null,
    processes:
      options.activeProcess === true
        ? [
            {
              id: "process_A",
              runId: "run_A",
              commandSummary: "fixture",
              ownerNonceHash: "a".repeat(64),
              status: "running",
              startedAt: new Date().toISOString(),
            },
          ]
        : [],
    probes: [
      {
        id: "probe_A",
        runId: "run_A",
        hypothesisId: "hyp_A",
        sourceFile,
        sourceLine: 1,
        message: "fixture",
        transport: "process",
        captures: [],
        sampling: { mode: "every", n: 1 },
        status: "registered",
        validationStatus: "pending",
        markerStart,
        markerEnd,
        expectedBlock,
        expectedHash: createHash("sha256").update(expectedBlock).digest("hex"),
      },
    ],
  }))
  const closeCollector = vi.fn().mockResolvedValue(undefined)
  const removeSecret = vi.fn(() => session.secretStore.remove())
  const cleanup = new CleanupService(session, {
    ...(options.activeCollector === true ? { collector: { close: closeCollector } } : {}),
    terminateProcess: vi.fn().mockResolvedValue({ status: "success" }),
    removeSecret,
  })
  const finalReport: FinalReportInput = {
    outcome: "completed",
    rootCause: "Fixture root cause",
    decidingEvidence: [],
    hypotheses: [{ id: "hyp_A", status: "confirmed", statement: "Fixture" }],
    fix: "Fixture fix",
    changedFiles: ["example.js"],
    verification: ["Fixture verified"],
  }
  onTestFinished(async () => {
    await registry.closeAll()
    await rm(container, { recursive: true, force: true })
  })
  return {
    cleanup,
    finalReport,
    session,
    projectRoot,
    sourceFile,
    retentionDestination,
    removeSecret,
    sessionExists: async () => {
      try {
        await access(session.paths.sessionDir)
        return true
      } catch {
        return false
      }
    },
  }
}

export async function orphanRecoveryFixture() {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-orphan-"))
  const projectRoot = path.join(container, "project")
  const tempBase = path.join(container, "opencode-debug-mode-v1")
  const unrelatedDir = path.join(tempBase, "unrelated")
  const outsideFile = path.join(container, "outside.ts")
  await mkdir(projectRoot, { recursive: true })
  await mkdir(unrelatedDir, { recursive: true })
  await writeFile(outsideFile, "preserve outside project\n")
  const registry = new SessionRegistry(tempBase)
  const expired = await registry.start("trusted-expired", { directory: projectRoot, worktree: projectRoot })
  const active = await registry.start("trusted-active", { directory: projectRoot, worktree: projectRoot })
  let manifest = await expired.manifestStore.read()
  await expired.manifestStore.update(manifest.revision, (value) => ({
    ...value,
    expiresAt: "2000-01-01T00:00:00.000Z",
  }))
  manifest = await active.manifestStore.read()
  await active.manifestStore.update(manifest.revision, (value) => ({ ...value, expiresAt: "2999-01-01T00:00:00.000Z" }))
  onTestFinished(async () => {
    await registry.closeAll()
    await rm(container, { recursive: true, force: true })
  })
  const recoveryOptions: OrphanRecoveryOptions = { tempBase, now: new Date("2026-07-13T00:00:00.000Z") }
  return {
    options: recoveryOptions,
    expiredSessionId: expired.publicId,
    expiredDir: expired.paths.sessionDir,
    activeDir: active.paths.sessionDir,
    unrelatedDir,
    outsideFile,
    injectEscapingProbe: async () => {
      const markerStart =
        "/* DEBUG-START opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_escape */"
      const markerEnd =
        "/* DEBUG-END opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_escape */"
      const expectedBlock = `${markerStart}\nvoid 0\n${markerEnd}\n`
      await writeFile(outsideFile, expectedBlock)
      const current = await expired.manifestStore.read()
      await expired.manifestStore.update(current.revision, (value) => ({
        ...value,
        probes: [
          ...value.probes,
          {
            id: "probe_escape",
            runId: "run_A",
            hypothesisId: "hyp_A",
            sourceFile: outsideFile,
            sourceLine: 1,
            message: "escape",
            transport: "process",
            captures: [],
            sampling: { mode: "every", n: 1 },
            status: "registered",
            validationStatus: "pending",
            markerStart,
            markerEnd,
            expectedBlock,
            expectedHash: createHash("sha256").update(expectedBlock).digest("hex"),
          },
        ],
      }))
    },
    readOutside: () => readFile(outsideFile, "utf8"),
    exists: async (target: string) => {
      try {
        await access(target)
        return true
      } catch {
        return false
      }
    },
  }
}

export function publicToolsFixture() {
  const registry = {
    requireOwned: vi.fn().mockRejectedValue(new DebugModeError("NO_ACTIVE_SESSION", "No active session")),
    start: vi.fn(),
    touch: vi.fn(),
  }
  const dependencies = {
    registry,
    runFor: vi.fn(),
    processFor: vi.fn(),
    collectorFor: vi.fn(),
    probesFor: vi.fn(),
    evidenceFor: vi.fn(),
    cleanupFor: vi.fn(),
  } as unknown as DebugToolDependencies
  return { registry, dependencies }
}

export async function pluginHarness(plugin?: Plugin, options: { activeSessions?: string[] } = {}) {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-plugin-"))
  const selectedPlugin = plugin ?? createDebugModePlugin({ tempBase: path.join(container, "sessions") })
  const client = { app: { log: vi.fn().mockResolvedValue({}) } }
  const hooks = await selectedPlugin({
    client,
    project: {} as never,
    directory: container,
    worktree: container,
    experimental_workspace: { register: vi.fn() },
    serverUrl: new URL("http://127.0.0.1"),
    $: {} as never,
  } as never)
  for (const sessionID of options.activeSessions ?? []) {
    await hooks.tool?.debug_session_start?.execute(
      { keepArtifacts: false },
      toolContextFixture({ sessionID, directory: container, worktree: container }),
    )
  }
  const cleanup = vi.fn().mockResolvedValue(undefined)
  const closeAll = vi.fn().mockResolvedValue(undefined)
  const toolCalls: string[] = []
  let disposed = false
  onTestFinished(async () => {
    if (!disposed) await hooks.dispose?.()
    await rm(container, { recursive: true, force: true })
  })
  return {
    projectRoot: container,
    clientLog: client.app.log,
    cleanup,
    registry: { closeAll },
    applyConfig: async (config: Config) => {
      await hooks.config?.(config)
      return config
    },
    event: async (event: unknown) => {
      const value = event as { type?: string; properties?: { info?: { id?: string } } }
      if (value.type === "session.deleted" && value.properties?.info?.id !== undefined) {
        await hooks.event?.({ event: event as never })
        cleanup(value.properties.info.id, "session-deleted")
      }
    },
    dispose: async () => {
      await hooks.dispose?.()
      closeAll()
      disposed = true
    },
    executeTool: async (
      name: string,
      args: Record<string, unknown>,
      sessionID = "session-A",
      contextOverrides: Partial<ToolContext> = {},
    ) => {
      const definition = hooks.tool?.[name]
      if (definition === undefined) throw new Error(`Unknown tool: ${name}`)
      toolCalls.push(name)
      return definition.execute(
        args,
        toolContextFixture({ sessionID, directory: container, worktree: container, ...contextOverrides }),
      )
    },
    toolCalls,
    compact: async (sessionID = "session-A") => {
      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]?.({ sessionID } as never, output)
      return output
    },
  }
}

export async function runCliDebugFixture() {
  try {
    await access(path.resolve("dist/process-supervisor.js"))
  } catch {
    await execFileAsync("npm", ["run", "build"], { cwd: process.cwd() })
  }
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-cli-e2e-"))
  const projectRoot = path.join(container, "project")
  const tempBase = path.join(container, "opencode-debug-mode-v1")
  await mkdir(projectRoot, { recursive: true })
  const discountFile = path.join(projectRoot, "discount.mjs")
  const runFile = path.join(projectRoot, "run.mjs")
  const source = (await readFile(path.resolve("fixtures/cli-bug/src/discount.ts"), "utf8"))
    .replace(": string", "")
    .replace(": number", "")
  await writeFile(discountFile, source)
  await writeFile(
    runFile,
    'import { discount } from "./discount.mjs"\nconst result = discount("vip-42")\nconsole.log(JSON.stringify({ result }))\nif (result !== 20) process.exitCode = 1\n',
  )
  const unrelatedFile = path.join(projectRoot, "unrelated.txt")
  await writeFile(unrelatedFile, "preserved\n")

  const trustedId = "trusted-cli-e2e"
  const registry = new SessionRegistry(tempBase)
  const session = await registry.start(trustedId, { directory: projectRoot, worktree: projectRoot })
  let state = await session.investigationStore.read()
  const scoped = await session.investigationStore.checkpoint(state.revision, {
    ...state,
    problemSummary: "VIP discount is skipped",
    expectedBehavior: "vip-42 receives 20 percent",
    actualBehavior: "vip-42 receives zero",
    runtimeContext: { kind: "cli", target: "discount.mjs" },
    reproduction: { method: "node run.mjs", requiresUser: false, confirmed: null },
    successCriteria: ["VIP discount is 20"],
    phase: "hypotheses",
    hypotheses: [
      {
        id: "hyp_membership",
        rank: 1,
        statement: "Array membership uses the index operator",
        confirmationSignals: ["vip-42 produces isVip false"],
        eliminationSignals: ["vip-42 produces isVip true"],
        status: "open",
        evidenceRefs: [],
      },
      {
        id: "hyp_input",
        rank: 2,
        statement: "The user ID differs at runtime",
        confirmationSignals: ["userId is not vip-42"],
        eliminationSignals: ["userId is vip-42"],
        status: "open",
        evidenceRefs: [],
      },
    ],
    nextAction: "Capture the membership operands",
  })
  state = scoped.state
  const runs = new RunService(session.manifestStore)
  const probes = new ProbeRegistry(session.manifestStore, session.projectRoot, async (id) => {
    const checkpoint = await session.investigationStore.read()
    return checkpoint.hypotheses.some((hypothesis) => hypothesis.id === id)
  })
  const evidence = new EvidenceStore(session.paths.evidenceFile)
  const processes = new ProcessService({
    session,
    runs,
    probes,
    evidence,
    acquireLease: async () => registry.acquireLeaseForSession(session, "process"),
    supervisorPath: path.resolve("dist/process-supervisor.js"),
  })

  const executeRun = async (label: "pre-fix" | "post-fix") => {
    const run = await runs.start({ label, reproduction: "node run.mjs", waitingForUser: false })
    const probe = await probes.plan({
      runId: run.id,
      hypothesisId: "hyp_membership",
      sourceFile: "discount.mjs",
      sourceLine: 4,
      message: "membership operands",
      captures: [
        { label: "isVip", path: "isVip" },
        { label: "userId", path: "userId" },
      ],
      transport: "process",
      sampling: { mode: "every", n: 1 },
    })
    const current = await readFile(discountFile, "utf8")
    await writeFile(discountFile, current.replace("  return isVip", `${probe.markerBlock}\n  return isVip`))
    await probes.register(probe.id)
    await probes.validate([probe.id])
    await processes.capture({
      runId: run.id,
      executable: process.execPath,
      args: [runFile],
      cwd: projectRoot,
      env: {},
      timeoutMs: 5_000,
    })
    await runs.complete(run.id, "completed")
    const page = await evidence.read({ runId: run.id, limit: 100 })
    const event = page.events.find((candidate) => candidate.kind === "probe")
    if (event === undefined) throw new Error("Expected probe evidence")
    const registeredProbe = (await session.manifestStore.read()).probes.find((candidate) => candidate.id === probe.id)
    if (registeredProbe === undefined) throw new Error("Registered probe disappeared")
    await removeOwnedProbe(registeredProbe)
    return { run, evidence: event.data as { isVip: boolean; userId: string }, eventId: event.eventId }
  }

  const preFix = await executeRun("pre-fix")
  const beforeFix = await readFile(discountFile, "utf8")
  await writeFile(discountFile, beforeFix.replace("userId in vipIds", "vipIds.includes(userId)"))
  const postFix = await executeRun("post-fix")
  const report: FinalReportInput = {
    outcome: "completed",
    rootCause: "Array membership used the index operator instead of value membership",
    decidingEvidence: [preFix.eventId, postFix.eventId],
    hypotheses: [
      { id: "hyp_membership", status: "confirmed", statement: "Array membership uses the index operator" },
      { id: "hyp_input", status: "eliminated", statement: "The user ID differs at runtime" },
    ],
    fix: "Use Array.includes for value membership",
    changedFiles: ["discount.mjs"],
    verification: ["The same run changed isVip from false to true"],
  }
  const cleanup = await new CleanupService(session).run({ reason: "completed", finalReport: report })
  onTestFinished(async () => {
    await registry.closeAll()
    await rm(container, { recursive: true, force: true })
  })
  return {
    report,
    preFix,
    postFix,
    cleanup,
    remainingDebugArtifacts: async () => {
      const artifacts: string[] = []
      for (const name of await readdir(projectRoot)) {
        const target = path.join(projectRoot, name)
        const text = await readFile(target, "utf8")
        if (text.includes("DEBUG-START") || name.includes("debug-transport")) artifacts.push(name)
      }
      return artifacts
    },
    unrelatedEdit: () => readFile(unrelatedFile, "utf8"),
  }
}

export async function runHumanReproductionFixture(options: {
  fixture: "web" | "chrome-mv3" | "firefox-mv2"
  transport: "http-web" | "extension-content"
}) {
  const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-browser-e2e-"))
  const projectRoot = path.join(container, "project")
  await mkdir(projectRoot, { recursive: true })
  onTestFinished(() => rm(container, { recursive: true, force: true }))
  const collector = await createCollectorFixture({ registeredProbe: true })
  const handle = await collector.start()
  const secret = collector.authHeaders.Authorization?.replace(/^Bearer\s+/u, "")
  if (secret === undefined) throw new Error("Collector fixture did not expose its test credential")
  const helper = new TransportHelper(projectRoot)
  const helperResult = await helper.create({
    targetPath: "debug-transport.mjs",
    host: handle.host,
    port: handle.port,
    token: secret,
    runtime: options.fixture === "web" ? "web" : "extension-background",
  })
  const helperPath = path.join(projectRoot, "debug-transport.mjs")
  let targetPath: string
  let runnerPath: string
  let requiredImportPath: string | undefined
  let permissionChange: Awaited<ReturnType<typeof addLoopbackPermission>> | undefined
  const template = createProbeTemplate({
    sessionId: "session_A",
    runId: "run_A",
    runLabel: "pre-fix",
    hypothesisId: "hyp_A",
    probeId: "probe_A",
    sourceFile: "src/fixture.ts",
    sourceLine: 1,
    message: "fixture event",
    captures: [{ label: "value", path: options.fixture === "web" ? "value" : "message.value" }],
    transport: options.transport,
    sampling: { mode: "every", n: 1 },
    ...(options.fixture === "web"
      ? {}
      : {
          contentAdapter:
            options.fixture === "chrome-mv3"
              ? ("chrome.runtime.sendMessage" as const)
              : ("browser.runtime.sendMessage" as const),
        }),
  })
  if (options.transport === "extension-content" && template.markerBlock.includes("fetch(")) {
    throw new Error("Content probe must not fetch loopback")
  }

  if (options.fixture === "web") {
    targetPath = path.join(projectRoot, "app.mjs")
    runnerPath = path.join(projectRoot, "run.mjs")
    const fixtureSource = await readFile(path.resolve("fixtures/web-bug/app.js"), "utf8")
    await writeFile(
      targetPath,
      `${helperResult.requiredImport}\n${fixtureSource.replace("  return", `  ${template.markerBlock}\n  return`)}`,
    )
    requiredImportPath = targetPath
    await writeFile(
      runnerPath,
      'import { selectedPlan } from "./app.mjs"\nconsole.log(selectedPlan("pro"))\nawait new Promise((resolve) => setTimeout(resolve, 100))\n',
    )
  } else {
    const fixtureRoot = path.resolve("fixtures/extensions", options.fixture)
    const manifestPath = path.join(projectRoot, "manifest.json")
    const backgroundPath = path.join(projectRoot, "background.mjs")
    targetPath = path.join(projectRoot, "content.mjs")
    runnerPath = path.join(projectRoot, "run.mjs")
    await writeFile(manifestPath, await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"))
    await writeFile(
      backgroundPath,
      `${helperResult.requiredImport}\n${await readFile(path.join(fixtureRoot, "background.js"), "utf8")}`,
    )
    requiredImportPath = backgroundPath
    const content = await readFile(path.join(fixtureRoot, "content.js"), "utf8")
    await writeFile(
      targetPath,
      content.replace(/\n(?=(?:chrome|browser)\.runtime\.sendMessage)/u, `\n${template.markerBlock}\n`),
    )
    const host = handle.host === "::1" ? `[::1]` : handle.host
    permissionChange = await addLoopbackPermission(manifestPath, `http://${host}:${handle.port}/*`)
    const namespace = options.fixture === "chrome-mv3" ? "chrome" : "browser"
    await writeFile(
      runnerPath,
      `const listeners = []
const runtime = {
  onMessage: { addListener(listener) { listeners.push(listener) } },
  async sendMessage(message) { return Promise.all(listeners.map((listener) => listener(message))) },
}
globalThis.${namespace} = { runtime }
await import("./background.mjs")
await import("./content.mjs")
await new Promise((resolve) => setTimeout(resolve, 100))
`,
    )
  }

  const runFixture = () => execFileAsync(process.execPath, [runnerPath], { cwd: projectRoot, timeout: 5_000 })
  const preRun = await runFixture()
  if (options.fixture === "web" && !preRun.stdout.includes("basic"))
    throw new Error("Web fixture baseline did not fail")
  const preFixEvents = (await collector.evidenceText()).trim().split("\n").filter(Boolean).length
  if (options.fixture === "web") {
    const source = await readFile(targetPath, "utf8")
    await writeFile(targetPath, source.replace('value === "premium"', 'value === "pro"'))
  }
  const postRun = await runFixture()
  if (options.fixture === "web" && !postRun.stdout.includes("premium"))
    throw new Error("Web fixture fix did not verify")
  const totalEvents = (await collector.evidenceText()).trim().split("\n").filter(Boolean).length
  const postFixEvents = totalEvents - preFixEvents
  await handle.close()
  const markerProbe: ManifestProbe = {
    id: "probe_A",
    runId: "run_A",
    hypothesisId: "hyp_A",
    sourceFile: targetPath,
    sourceLine: 1,
    message: "fixture event",
    transport: options.transport,
    captures: [{ label: "value", path: options.fixture === "web" ? "value" : "message.value" }],
    sampling: { mode: "every", n: 1 },
    status: "registered",
    validationStatus: "validated",
    markerStart: template.markerBlock.split("\n")[0] ?? "",
    markerEnd: template.markerBlock.split("\n").at(-1) ?? "",
    expectedBlock: template.markerBlock,
    expectedHash: createHash("sha256").update(template.markerBlock).digest("hex"),
  }
  const markerResult = await removeOwnedProbe(markerProbe)
  if (requiredImportPath !== undefined) {
    const source = await readFile(requiredImportPath, "utf8")
    await writeFile(requiredImportPath, source.replace(`${helperResult.requiredImport}\n`, ""))
  }
  const helperContent = await readFile(helperPath)
  const helperMatches = createHash("sha256").update(helperContent).digest("hex") === helperResult.sha256
  if (helperMatches) await rm(helperPath)
  const permissionResult =
    permissionChange === undefined
      ? { status: "already-clean" as const }
      : await removeLoopbackPermission(permissionChange.manifestPath, permissionChange)
  const checkTargets = [targetPath, runnerPath, ...(requiredImportPath === undefined ? [] : [requiredImportPath])]
  const checks = await Promise.all(
    checkTargets.map((filename) =>
      execFileAsync(process.execPath, ["--check", filename], { cwd: projectRoot, timeout: 5_000 }),
    ),
  )
  const remainingOwnedArtifacts: string[] = []
  for (const filename of await readdir(projectRoot)) {
    const fullPath = path.join(projectRoot, filename)
    const text = await readFile(fullPath, "utf8")
    if (filename.includes("debug-transport") || text.includes("DEBUG-START") || text.includes("127.0.0.1")) {
      remainingOwnedArtifacts.push(filename)
    }
  }
  const cleanupComplete =
    markerResult.status !== "failed" &&
    helperMatches &&
    permissionResult.status !== "failed" &&
    remainingOwnedArtifacts.length === 0
  return {
    preFixEvents,
    postFixEvents,
    manualCollectorSteps: [],
    cleanup: { status: cleanupComplete ? "complete" : "partial" },
    remainingOwnedArtifacts,
    cleanedBuild: { exitCode: checks.every((result) => result.stderr === "") ? 0 : 1 },
  }
}
