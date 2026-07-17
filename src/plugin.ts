import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { lstat, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Config, Plugin } from "@opencode-ai/plugin"
import { CleanupService } from "./cleanup/service.js"
import type { FinalReportInput } from "./cleanup/types.js"
import { createIngestHandler } from "./collector/ingest.js"
import { createCollectorRouter } from "./collector/router.js"
import { CollectorServer } from "./collector/server.js"
import type { Clock } from "./core/clock.js"
import { systemClock } from "./core/clock.js"
import { TEMP_BASE_NAME } from "./core/constants.js"
import { DebugModeError } from "./core/errors.js"
import { readPackageVersion } from "./core/package-metadata.js"
import { EvidenceStore } from "./evidence/store.js"
import {
  hypothesisSemanticFingerprint,
  normalizeQuestionRequest,
  recordQuestionAsked,
  recordQuestionReply,
  recordVisibleLifecycleUpdate,
} from "./investigation/lifecycle-receipts.js"
import { enforceDebugMutationGate, recordBehavioralMutation } from "./investigation/mutation-guard.js"
import { addLoopbackPermission, removeLoopbackPermission } from "./probes/extension-permissions.js"
import { TransportHelper } from "./probes/helper.js"
import { ProbeRegistry } from "./probes/registry.js"
import { removeExactCanonicalProjectFile } from "./probes/source-safety.js"
import { ProcessService } from "./process/service.js"
import { RunService } from "./run/service.js"
import { recoverOrphans } from "./session/orphan-recovery.js"
import { isContained } from "./session/paths.js"
import { type DebugSession, SessionRegistry } from "./session/registry.js"
import { createDebugTools } from "./tools/index.js"

type SessionServices = {
  evidence: EvidenceStore
  runs: RunService
  probes: ProbeRegistry
  process: ProcessService
  collectorServer?: CollectorServer
  collector: {
    start(input: {
      runtime: "web" | "extension-background"
      transportTargetPath: string
      extensionManifestPath?: string
    }): Promise<{
      collectorId: string
      host: "127.0.0.1" | "::1"
      port: number
      status: string
      helperImport: string
      helperPath: string
    }>
  }
  cleanup: CleanupService
}

function nestedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(nestedStrings)
  if (typeof value !== "object" || value === null) return []
  return Object.values(value).flatMap(nestedStrings)
}

function canonicalExistingPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

const GLOB_META = /[*?[\]{}()!]/u

function mayContainPath(scope: string, candidate: string): boolean {
  const canonicalScope = canonicalExistingPath(scope)
  const canonicalCandidate = canonicalExistingPath(candidate)
  return canonicalScope === canonicalCandidate || isContained(canonicalScope, canonicalCandidate)
}

function includeMayMatchOwnedFile(include: string, projectRoot: string, ownedPath: string): boolean {
  if (include.length === 0 || GLOB_META.test(include)) return true
  const normalizedInclude = include.split(path.sep).join("/")
  const relativeOwned = path.relative(projectRoot, ownedPath).split(path.sep).join("/")
  return normalizedInclude === relativeOwned || normalizedInclude === path.posix.basename(relativeOwned)
}

function grepMayTargetOwnedFile(args: unknown, directory: string, projectRoot: string, ownedPaths: string[]): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return true
  const input = args as Record<string, unknown>
  if (input.path !== undefined && typeof input.path !== "string") return true
  if (input.include !== undefined && typeof input.include !== "string") return true
  const scope = typeof input.path === "string" ? path.resolve(directory, input.path) : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  return ownedPaths.some((ownedPath) => {
    if (scope !== undefined && !mayContainPath(scope, ownedPath)) return false
    if (include !== undefined && !includeMayMatchOwnedFile(include, projectRoot, ownedPath)) return false
    return true
  })
}

async function updateManifest(session: DebugSession, mutate: Parameters<DebugSession["manifestStore"]["modify"]>[0]) {
  return session.manifestStore.modify(mutate)
}

async function canonicalExtensionManifestPath(projectRoot: string, requestedPath: string): Promise<string> {
  const canonicalRoot = await realpath(projectRoot)
  const candidate = path.resolve(canonicalRoot, requestedPath)
  if (!isContained(canonicalRoot, candidate)) {
    throw new DebugModeError("PERMISSION_MISMATCH", "Extension manifest must be inside the project")
  }
  try {
    const candidateInfo = await lstat(candidate)
    if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) {
      throw new DebugModeError("PERMISSION_MISMATCH", "Extension manifest must be a regular project file")
    }
    const canonicalPath = await realpath(candidate)
    const canonicalInfo = await lstat(canonicalPath)
    if (
      canonicalPath !== candidate ||
      !isContained(canonicalRoot, canonicalPath) ||
      canonicalInfo.isSymbolicLink() ||
      !canonicalInfo.isFile()
    ) {
      throw new DebugModeError("PERMISSION_MISMATCH", "Extension manifest path must be canonical and symlink-free")
    }
    return canonicalPath
  } catch (error) {
    if (error instanceof DebugModeError) throw error
    throw new DebugModeError("PERMISSION_MISMATCH", "Extension manifest must be a readable project file")
  }
}

async function canonicalNewTransportTargetPath(projectRoot: string, requestedPath: string): Promise<string> {
  const canonicalRoot = await realpath(projectRoot)
  const candidate = path.resolve(canonicalRoot, requestedPath)
  const action =
    "Retry with a new unused .mjs path such as Extension/src/background/opencode-debug-transport.mjs; helperSourceFile is only for extension-content probes"
  if (!isContained(canonicalRoot, candidate) || path.extname(candidate).toLowerCase() !== ".mjs") {
    throw new DebugModeError(
      "HELPER_PATH_UNSAFE",
      "Transport helper target must be a new project-contained .mjs file",
      false,
      { action },
    )
  }
  try {
    await lstat(candidate)
    throw new DebugModeError(
      "HELPER_PATH_UNSAFE",
      "Transport helper target already exists; application source files cannot be used as helper targets",
      false,
      { action },
    )
  } catch (error) {
    if (error instanceof DebugModeError) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DebugModeError("HELPER_PATH_UNSAFE", "Transport helper target could not be checked safely", false, {
        action,
      })
    }
  }
  return candidate
}

async function rollbackOwnedHelper(
  projectRoot: string,
  owned: { path: string; sha256: string; bytes: number },
): Promise<"success" | "already-clean" | "content-mismatch" | "failed"> {
  try {
    return await removeExactCanonicalProjectFile(projectRoot, owned.path, owned.sha256, owned.bytes)
  } catch {
    return "failed"
  }
}

function terminalReport(outcome: "abandoned" | "escalated", reason: string): FinalReportInput {
  return {
    outcome,
    rootCause: reason,
    decidingEvidence: [],
    hypotheses: [],
    fix: "No additional fix was applied during lifecycle cleanup",
    changedFiles: [],
    verification: ["Package-owned resources were cleaned by the lifecycle hook"],
  }
}

export type DebugModePluginOptions = Readonly<{
  clock?: Clock
  tempBase?: string
}>

export function createDebugModePlugin(options: DebugModePluginOptions = {}): Plugin {
  return async (input) => {
    const prompt = await readFile(new URL("../assets/debug-agent.md", import.meta.url), "utf8")
    const diagnostics = {
      packageVersion: await readPackageVersion(),
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
    }
    const tempBase = options.tempBase ?? path.join(tmpdir(), TEMP_BASE_NAME)
    const clock = options.clock ?? systemClock
    const recovery = await recoverOrphans({ tempBase, now: clock.now() }).catch((error) => ({
      cleaned: [],
      ignored: [],
      errors: [{ directory: "<temp-base>", reason: error instanceof Error ? error.name : "recovery-failed" }],
    }))
    if (recovery.errors.length > 0) {
      await input.client.app.log({
        body: {
          service: "opencode-debug-mode",
          level: "warn",
          message: `Orphan recovery reported ${recovery.errors.length} failure(s)`,
        },
      })
    }
    const services = new Map<string, SessionServices>()
    let registry: SessionRegistry

    const forSession = (session: DebugSession): SessionServices => {
      const existing = services.get(session.publicId)
      if (existing !== undefined) return existing
      const evidence = new EvidenceStore(
        session.paths.evidenceFile,
        async (counters) => {
          await updateManifest(session, (manifest) => ({ ...manifest, counters })).catch(() => undefined)
        },
        clock,
        async () => (await session.manifestStore.read()).counters,
      )
      const runs = new RunService(session.manifestStore, clock, (kind) =>
        registry.acquireLeaseForSession(session, kind),
      )
      const probes = new ProbeRegistry(session.manifestStore, session.projectRoot, async (id) => {
        const state = await session.investigationStore.read()
        const hypothesis = state.hypotheses.find((candidate) => candidate.id === id)
        return hypothesis === undefined ? undefined : hypothesisSemanticFingerprint(hypothesis)
      })
      const sampleCounts = new Map<string, number>()
      const processService = new ProcessService({
        session,
        runs,
        evidence,
        probes,
        acquireLease: async () => registry.acquireLeaseForSession(session, "process"),
      })
      let collectorServer: CollectorServer | undefined
      let collectorStarting = false
      const collector = {
        start: async (request: {
          runtime: "web" | "extension-background"
          transportTargetPath: string
          extensionManifestPath?: string
        }) => {
          if (typeof request.transportTargetPath !== "string" || request.transportTargetPath.trim().length === 0) {
            throw new DebugModeError(
              "HELPER_PATH_UNSAFE",
              "Collector startup requires a project-contained transport helper path",
            )
          }
          const transportTargetPath = await canonicalNewTransportTargetPath(
            session.projectRoot,
            request.transportTargetPath,
          )
          if (collectorStarting || collectorServer !== undefined) {
            throw new DebugModeError("COLLECTOR_EXISTS", "A collector is already active")
          }
          collectorStarting = true
          let server: CollectorServer | undefined
          let permissionChange: Awaited<ReturnType<typeof addLoopbackPermission>> | undefined
          let helperOwned: { path: string; sha256: string; bytes: number } | undefined
          let startupFailure: DebugModeError | undefined
          let startupSettled = false
          let manifestCommitted = false
          const assertStartupHealthy = () => {
            if (startupFailure !== undefined) throw startupFailure
          }
          try {
            const manifest = await session.manifestStore.read()
            if (manifest.collector !== null) {
              throw new DebugModeError("COLLECTOR_EXISTS", "A collector is already active")
            }
            let extensionManifestPath: string | undefined
            if (request.extensionManifestPath !== undefined) {
              if (request.runtime !== "extension-background") {
                throw new DebugModeError(
                  "PERMISSION_MISMATCH",
                  "Extension permissions require extension-background runtime",
                )
              }
              extensionManifestPath = await canonicalExtensionManifestPath(
                session.projectRoot,
                request.extensionManifestPath,
              )
            }
            const ingest = createIngestHandler({
              evidence,
              validateEvent: (event) => probes.validateEvent(event),
              sample: async (event) => {
                const probe = (await session.manifestStore.read()).probes.find(
                  (candidate) => candidate.id === event.probeId,
                )
                if (probe?.sampling.mode !== "every" || probe.sampling.n === 1) return false
                const count = (sampleCounts.get(probe.id) ?? 0) + 1
                sampleCounts.set(probe.id, count)
                return count % probe.sampling.n !== 0
              },
            })
            server = new CollectorServer(
              createCollectorRouter({
                token: session.secret,
                ingest,
                onAuthenticated: () => registry.touchSession(session),
              }),
              async () => {
                if (!startupSettled) {
                  startupFailure ??= new DebugModeError(
                    "LOOPBACK_BIND_FAILED",
                    "The loopback collector failed while startup ownership was being committed",
                  )
                  return
                }
                await service.cleanup.run({
                  reason: "collector-failure",
                  finalReport: terminalReport("escalated", "Collector failed"),
                })
                registry.forgetSession(session)
                services.delete(session.publicId)
              },
            )
            const handle = await server.start()
            collectorServer = server
            assertStartupHealthy()
            if (extensionManifestPath !== undefined) {
              const host = handle.host === "::1" ? "[::1]" : handle.host
              permissionChange = await addLoopbackPermission(
                session.projectRoot,
                extensionManifestPath,
                `http://${host}:${handle.port}/*`,
                (change) => {
                  permissionChange = change
                },
              )
              assertStartupHealthy()
            }
            const transportHelper = new TransportHelper(session.projectRoot, (owned) => {
              helperOwned = owned
            })
            const helper = await transportHelper.create({
              targetPath: transportTargetPath,
              host: handle.host,
              port: handle.port,
              token: session.secret,
              runtime: request.runtime,
            })
            assertStartupHealthy()
            await updateManifest(session, (value) => ({
              ...value,
              collector: {
                id: handle.id,
                host: handle.host,
                port: handle.port,
                status: "ready",
                startedAt: clock.now().toISOString(),
              },
              permissionChanges:
                permissionChange === undefined
                  ? value.permissionChanges
                  : [...value.permissionChanges, permissionChange],
              ownedFiles:
                helperOwned === undefined
                  ? value.ownedFiles
                  : [...value.ownedFiles, { ...helperOwned, kind: "transport-helper" }],
            }))
            manifestCommitted = true
            assertStartupHealthy()
            startupSettled = true
            return {
              collectorId: handle.id,
              host: handle.host,
              port: handle.port,
              status: handle.status,
              helperImport: helper.requiredImport,
              helperPath: helper.relativePath,
            }
          } catch (error) {
            startupSettled = true
            if (manifestCommitted && startupFailure !== undefined) {
              const cleanupResult = await service.cleanup.run({
                reason: "collector-failure",
                finalReport: terminalReport("escalated", "Collector failed during startup"),
              })
              registry.forgetSession(session)
              services.delete(session.publicId)
              collectorServer = undefined
              if (cleanupResult.status === "partial") {
                const summary = cleanupResult.remainingArtifacts.join(", ") || "collector-startup-cleanup"
                throw new DebugModeError(
                  "CLEANUP_PARTIAL",
                  "Collector startup failed and manifest-backed cleanup was partial",
                  false,
                  {
                    action: `Inspect and remove the remaining collector resources: ${summary}`,
                    details: { residues: summary },
                  },
                )
              }
              throw error
            }
            const rollbackResidues: Array<{ location: string; status: string }> = []
            if (helperOwned !== undefined) {
              const status = await rollbackOwnedHelper(session.projectRoot, helperOwned)
              if (status === "content-mismatch" || status === "failed") {
                rollbackResidues.push({ location: helperOwned.path, status })
              }
            }
            if (permissionChange !== undefined) {
              try {
                const result = await removeLoopbackPermission(
                  session.projectRoot,
                  permissionChange.manifestPath,
                  permissionChange,
                )
                if (result.status === "failed") {
                  rollbackResidues.push({
                    location: permissionChange.manifestPath,
                    status: result.reason ?? "permission-removal-failed",
                  })
                }
              } catch (permissionError) {
                const location =
                  permissionError instanceof DebugModeError && typeof permissionError.details?.residuePath === "string"
                    ? permissionError.details.residuePath
                    : permissionChange.manifestPath
                rollbackResidues.push({
                  location,
                  status:
                    permissionError instanceof DebugModeError && permissionError.code === "CLEANUP_PARTIAL"
                      ? "permission-rewrite-rollback-failed"
                      : "permission-removal-failed",
                })
              }
            }
            let collectorClosed = true
            try {
              await server?.close()
            } catch {
              collectorClosed = false
              rollbackResidues.push({ location: "loopback-collector", status: "collector-close-failed" })
            }
            if (collectorClosed && collectorServer === server) collectorServer = undefined
            if (rollbackResidues.length > 0) {
              const summary = rollbackResidues.map(({ location, status }) => `${location}:${status}`).join(", ")
              throw new DebugModeError(
                "CLEANUP_PARTIAL",
                "Collector startup failed and rollback left security-sensitive resources",
                false,
                {
                  action: `Inspect and remove the remaining collector resources: ${summary}`,
                  details: { residues: summary },
                },
              )
            }
            throw error
          } finally {
            collectorStarting = false
          }
        },
      }
      const cleanup = new CleanupService(session, {
        collector: { close: async () => collectorServer?.close() },
      })
      const service: SessionServices = {
        evidence,
        runs,
        probes,
        process: processService,
        collector,
        cleanup,
        ...(collectorServer === undefined ? {} : { collectorServer }),
      }
      services.set(session.publicId, service)
      return service
    }

    registry = new SessionRegistry(tempBase, clock, async (session) => {
      const result = await forSession(session).cleanup.run({
        reason: "idle-expired",
        finalReport: terminalReport("abandoned", "Debug session expired after inactivity"),
      })
      services.delete(session.publicId)
      if (result.status === "partial") {
        await input.client.app.log({
          body: {
            service: "opencode-debug-mode",
            level: "warn",
            message: "Idle session cleanup completed with partial failures",
          },
        })
      }
    })

    const tools = createDebugTools({
      registry,
      runFor: (session) => forSession(session).runs,
      processFor: (session) => forSession(session).process,
      collectorFor: (session) => forSession(session).collector,
      probesFor: (session) => forSession(session).probes,
      evidenceFor: (session) => forSession(session).evidence,
      cleanupFor: (session) => forSession(session).cleanup,
      onCleanup: (session) => services.delete(session.publicId),
      diagnostics,
    })
    const debugAgentSessions = new Set<string>()

    await input.client.app.log({
      body: {
        service: "opencode-debug-mode",
        level: "info",
        message: `Loaded v${diagnostics.packageVersion} prompt=${diagnostics.promptSha256}`,
      },
    })

    const logCollision = (name: string) => {
      void input.client.app.log({
        body: { service: "opencode-debug-mode", level: "warn", message: `Replacing conflicting ${name} configuration` },
      })
    }
    const agentTools = {
      ...Object.fromEntries([...Object.keys(tools), "question"].map((name) => [name, true])),
      bash: false,
      task: false,
      "sdd-command": false,
    }
    const permission: Record<string, "allow" | "ask" | "deny"> = {
      "*": "ask",
      bash: "deny",
      task: "deny",
      "sdd-command": "deny",
      doom_loop: "deny",
      external_directory: "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow",
      codesearch: "allow",
      webfetch: "allow",
      websearch: "allow",
      todoread: "allow",
      todowrite: "allow",
      edit: "allow",
      question: "allow",
      ...Object.fromEntries(Object.keys(tools).map((name) => [name, "allow" as const])),
    }

    return {
      config: async (config: Config) => {
        if (config.agent?.debug !== undefined) logCollision("agent.debug")
        if (config.command?.debug !== undefined) logCollision("command.debug")
        config.agent ??= {}
        config.command ??= {}
        config.agent.debug = {
          mode: "primary",
          description: "Hypothesis-driven runtime debugging",
          prompt,
          tools: agentTools,
          permission,
        }
        config.command.debug = {
          description: "Start hypothesis-driven runtime debugging",
          agent: "debug",
          template: "$ARGUMENTS",
        }
      },
      tool: tools,
      "chat.message": async ({ sessionID, agent }) => {
        if (agent === "debug") debugAgentSessions.add(sessionID)
        else if (agent !== undefined) debugAgentSessions.delete(sessionID)
      },
      "chat.params": async ({ sessionID, agent }) => {
        if (agent === "debug") debugAgentSessions.add(sessionID)
        else debugAgentSessions.delete(sessionID)
      },
      "tool.execute.before": async ({ tool, sessionID, callID }, output) => {
        if (!debugAgentSessions.has(sessionID)) return
        if (
          (tool === "read" || tool === "grep" || tool === "codesearch" || tool === "webfetch") &&
          (await registry.hasTrusted(sessionID))
        ) {
          const session = await registry.requireOwned(sessionID)
          const manifest = await session.manifestStore.read()
          const values = nestedStrings(output.args)
          const readsOwnedCredential =
            tool === "read" &&
            values.some((value) => {
              const requested = canonicalExistingPath(
                path.isAbsolute(value) ? value : path.resolve(session.directory, value),
              )
              return (manifest.ownedFiles ?? []).some((owned) => canonicalExistingPath(owned.path) === requested)
            })
          const ownedPaths = (manifest.ownedFiles ?? []).map((owned) => owned.path)
          const searchesAcrossOwnedCredentials =
            (tool === "codesearch" && ownedPaths.length > 0) ||
            (tool === "grep" &&
              ownedPaths.length > 0 &&
              grepMayTargetOwnedFile(output.args, session.directory, session.projectRoot, ownedPaths))
          const callsOwnedCollector =
            tool === "webfetch" &&
            manifest.collector !== null &&
            values.some((value) => {
              const host = manifest.collector?.host === "::1" ? "[::1]" : manifest.collector?.host
              return value.includes(`http://${host}:${manifest.collector?.port}`)
            })
          if (readsOwnedCredential || searchesAcrossOwnedCredentials || callsOwnedCollector) {
            throw new DebugModeError(
              "PERMISSION_MISMATCH",
              "Package-owned collector credentials are not readable, searchable, or callable through general tools",
              false,
              {
                action: "Use the returned helper import and debug evidence tools without inspecting transport secrets",
              },
            )
          }
        }
        await enforceDebugMutationGate({
          registry,
          evidenceFor: (session) => forSession(session).evidence,
          sessionID,
          tool,
          args: output.args,
        })
        if (tool === "question") {
          if (!(await registry.hasTrusted(sessionID))) {
            throw new DebugModeError(
              "INVALID_PHASE",
              "Debug Mode requires a managed lifecycle before Question",
              false,
              { action: "Start the debug session and prepare a reproduction or verification checkpoint first" },
            )
          }
          const questionSession = await registry.requireOwned(sessionID)
          output.args = normalizeQuestionRequest(output.args) as typeof output.args
          await recordQuestionAsked({
            session: questionSession,
            callId: callID,
            args: output.args,
            clock,
          })
        }
      },
      "tool.execute.after": async ({ tool, sessionID, callID, args }, output) => {
        if (!debugAgentSessions.has(sessionID)) return
        if (tool === "question" && (await registry.hasTrusted(sessionID))) {
          const session = await registry.requireOwned(sessionID)
          await recordQuestionReply({ session, callId: callID, metadata: output.metadata, clock })
        }
        await recordBehavioralMutation({ registry, sessionID, tool, args, clock })
      },
      "experimental.text.complete": async ({ sessionID }, output) => {
        if (!debugAgentSessions.has(sessionID) || !(await registry.hasTrusted(sessionID))) return
        try {
          await recordVisibleLifecycleUpdate(await registry.requireOwned(sessionID), output.text, clock)
        } catch (error) {
          if (
            error instanceof DebugModeError &&
            ["NO_ACTIVE_SESSION", "STATE_MISSING", "STATE_INVALID"].includes(error.code)
          ) {
            return
          }
          throw error
        }
      },
      event: async ({ event }) => {
        if (event.type !== "session.deleted") return
        const trustedId = event.properties.info.id
        debugAgentSessions.delete(trustedId)
        try {
          const session = await registry.requireOwned(trustedId)
          await forSession(session).cleanup.run({
            reason: "session-deleted",
            finalReport: terminalReport("abandoned", "OpenCode session was deleted"),
          })
          registry.forgetSession(session)
          services.delete(session.publicId)
        } catch (error) {
          if (!(error instanceof DebugModeError && error.code === "NO_ACTIVE_SESSION")) throw error
        }
      },
      "experimental.session.compacting": async ({ sessionID }, output) => {
        if (await registry.hasTrusted(sessionID)) {
          output.context.push(
            "An opencode-debug-mode investigation is active. Before any next action, call debug_state_read and reconcile its revision, phase, completed checks, evidence references, and nextAction. Do not repeat a conclusive check unless the checkpoint records invalidating evidence.",
          )
        }
      },
      dispose: async () => {
        for (const session of registry.listActive()) {
          await forSession(session).cleanup.run({
            reason: "plugin-dispose",
            finalReport: terminalReport("abandoned", "OpenCode plugin was disposed"),
          })
        }
        await registry.closeAll()
        services.clear()
      },
    }
  }
}

export const DebugModePlugin: Plugin = createDebugModePlugin()
