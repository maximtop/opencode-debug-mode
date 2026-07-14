import type { ToolDefinition } from "@opencode-ai/plugin"
import type { CleanupService } from "../cleanup/service.js"
import type { EvidenceStore } from "../evidence/store.js"
import type { ProbeRegistry } from "../probes/registry.js"
import type { RunService } from "../run/service.js"
import type { DebugSession, SessionRegistry } from "../session/registry.js"
import { createCleanupTool } from "./cleanup-tool.js"
import { createCollectorStartTool, type PublicCollectorService } from "./collector-tools.js"
import { createEvidenceReadTool } from "./evidence-tools.js"
import { createProbePrepareTool, createProbeRegisterTool } from "./probe-tools.js"
import { createProcessCaptureTool, createRunStartTool, type RunToolDependencies } from "./run-tools.js"
import { createSessionStartTool, createSessionStatusTool } from "./session-tools.js"
import { createStateCheckpointTool, createStateReadTool } from "./state-tools.js"

export interface DebugToolDependencies extends RunToolDependencies {
  registry: SessionRegistry
  runFor(session: DebugSession): RunService
  collectorFor(session: DebugSession): PublicCollectorService
  probesFor(session: DebugSession): ProbeRegistry
  evidenceFor(session: DebugSession): EvidenceStore
  cleanupFor(session: DebugSession): CleanupService
}

export type DebugTools = {
  debug_session_start: ToolDefinition
  debug_session_status: ToolDefinition
  debug_state_read: ToolDefinition
  debug_state_checkpoint: ToolDefinition
  debug_run_start: ToolDefinition
  debug_process_capture: ToolDefinition
  debug_collector_start: ToolDefinition
  debug_probe_prepare: ToolDefinition
  debug_probe_register: ToolDefinition
  debug_evidence_read: ToolDefinition
  debug_cleanup: ToolDefinition
}

export function createDebugTools(dependencies: DebugToolDependencies): DebugTools {
  return {
    debug_session_start: createSessionStartTool(dependencies.registry),
    debug_session_status: createSessionStatusTool(dependencies.registry),
    debug_state_read: createStateReadTool(dependencies.registry),
    debug_state_checkpoint: createStateCheckpointTool(dependencies.registry),
    debug_run_start: createRunStartTool(dependencies.registry, dependencies.runFor),
    debug_process_capture: createProcessCaptureTool(dependencies),
    debug_collector_start: createCollectorStartTool(dependencies.registry, dependencies.collectorFor),
    debug_probe_prepare: createProbePrepareTool(dependencies.registry, dependencies.probesFor),
    debug_probe_register: createProbeRegisterTool(dependencies.registry, dependencies.probesFor),
    debug_evidence_read: createEvidenceReadTool(dependencies.registry, dependencies.evidenceFor),
    debug_cleanup: createCleanupTool(dependencies.registry, dependencies.cleanupFor),
  }
}
