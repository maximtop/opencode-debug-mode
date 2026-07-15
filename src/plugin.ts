import { readFile } from "node:fs/promises"
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
import { EvidenceStore } from "./evidence/store.js"
import { addLoopbackPermission, removeLoopbackPermission } from "./probes/extension-permissions.js"
import { TransportHelper } from "./probes/helper.js"
import { ProbeRegistry } from "./probes/registry.js"
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
      transportTargetPath?: string
      extensionManifestPath?: string
    }): Promise<{
      collectorId: string
      host: "127.0.0.1" | "::1"
      port: number
      status: string
      helperImport?: string
      helperPath?: string
    }>
  }
  cleanup: CleanupService
}

async function updateManifest(session: DebugSession, mutate: Parameters<DebugSession["manifestStore"]["modify"]>[0]) {
  return session.manifestStore.modify(mutate)
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
        return state.hypotheses.some((hypothesis) => hypothesis.id === id)
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
      const collector = {
        start: async (request: {
          runtime: "web" | "extension-background"
          transportTargetPath?: string
          extensionManifestPath?: string
        }) => {
          const manifest = await session.manifestStore.read()
          if (manifest.collector !== null) throw new DebugModeError("COLLECTOR_EXISTS", "A collector is already active")
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
          collectorServer = new CollectorServer(
            createCollectorRouter({
              token: session.secret,
              ingest,
              onAuthenticated: () => registry.touchSession(session),
            }),
            async () => {
              await service.cleanup.run({
                reason: "collector-failure",
                finalReport: terminalReport("escalated", "Collector failed"),
              })
            },
          )
          const handle = await collectorServer.start()
          let permissionChange: Awaited<ReturnType<typeof addLoopbackPermission>> | undefined
          if (request.extensionManifestPath !== undefined) {
            if (request.runtime !== "extension-background") {
              await collectorServer.close()
              throw new DebugModeError(
                "PERMISSION_MISMATCH",
                "Extension permissions require extension-background runtime",
              )
            }
            const manifestPath = path.resolve(session.projectRoot, request.extensionManifestPath)
            if (!isContained(session.projectRoot, manifestPath)) {
              await collectorServer.close()
              throw new DebugModeError("PERMISSION_MISMATCH", "Extension manifest must be inside the project")
            }
            const host = handle.host === "::1" ? "[::1]" : handle.host
            permissionChange = await addLoopbackPermission(manifestPath, `http://${host}:${handle.port}/*`)
          }
          try {
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
            }))
          } catch (error) {
            if (permissionChange !== undefined) {
              await removeLoopbackPermission(permissionChange.manifestPath, permissionChange).catch(() => undefined)
            }
            await collectorServer.close()
            throw error
          }
          let helper: Awaited<ReturnType<TransportHelper["create"]>> | undefined
          if (request.transportTargetPath !== undefined) {
            const transportHelper = new TransportHelper(session.projectRoot, async (owned) => {
              await updateManifest(session, (value) => ({
                ...value,
                ownedFiles: [...value.ownedFiles, { ...owned, kind: "transport-helper" }],
              }))
            })
            helper = await transportHelper.create({
              targetPath: request.transportTargetPath,
              host: handle.host,
              port: handle.port,
              token: session.secret,
              runtime: request.runtime,
            })
          }
          return {
            collectorId: handle.id,
            host: handle.host,
            port: handle.port,
            status: handle.status,
            ...(helper === undefined ? {} : { helperImport: helper.requiredImport, helperPath: helper.relativePath }),
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
    })

    const logCollision = (name: string) => {
      void input.client.app.log({
        body: { service: "opencode-debug-mode", level: "warn", message: `Replacing conflicting ${name} configuration` },
      })
    }

    return {
      config: async (config: Config) => {
        if (config.agent?.debug !== undefined) logCollision("agent.debug")
        if (config.command?.debug !== undefined) logCollision("command.debug")
        config.agent ??= {}
        config.command ??= {}
        // OpenCode accepts arbitrary permission names, while its generated 1.x Config type lists only legacy keys.
        const permission: Record<string, "allow" | "ask" | "deny"> = { question: "allow" }
        config.agent.debug = {
          mode: "primary",
          description: "Hypothesis-driven runtime debugging",
          prompt,
          permission,
        }
        config.command.debug = {
          description: "Start hypothesis-driven runtime debugging",
          agent: "debug",
          template: "$ARGUMENTS",
        }
      },
      tool: tools,
      event: async ({ event }) => {
        if (event.type !== "session.deleted") return
        const trustedId = event.properties.info.id
        try {
          const session = await registry.requireOwned(trustedId)
          await forSession(session).cleanup.run({
            reason: "session-deleted",
            finalReport: terminalReport("abandoned", "OpenCode session was deleted"),
          })
          registry.forgetTrusted(trustedId)
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
      },
    }
  }
}

export const DebugModePlugin: Plugin = createDebugModePlugin()
