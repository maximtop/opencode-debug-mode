import { PROCESS_EVENT_PREFIX } from "../core/constants.js"
import { DebugModeError } from "../core/errors.js"
import { type ProbeSampling, type ProbeTransport, SAFE_CAPTURE } from "./types.js"

export type ProbeTemplateInput = Readonly<{
  sessionId: string
  runId: string
  runLabel: "pre-fix" | "post-fix"
  hypothesisId: string
  probeId: string
  sourceFile: string
  sourceLine: number
  message: string
  captures: Array<{ label: string; path: string }>
  transport: ProbeTransport
  sampling: ProbeSampling
  contentAdapter?: "chrome.runtime.sendMessage" | "browser.runtime.sendMessage" | "wrapper.sendMessage"
}>

export function createProbeTemplate(input: ProbeTemplateInput): { markerBlock: string } {
  if (input.captures.some((capture) => !SAFE_CAPTURE.test(capture.path))) {
    throw new DebugModeError("UNSAFE_CAPTURE", "Probe capture path is unsafe")
  }
  const ownership = `opencode-debug-mode session=${input.sessionId} run=${input.runId} hypothesis=${input.hypothesisId} probe=${input.probeId}`
  const data = input.captures.map((capture) => `${JSON.stringify(capture.label)}: ${capture.path}`).join(", ")
  const event = `{
  schemaVersion: 1,
  sessionId: ${JSON.stringify(input.sessionId)},
  runId: ${JSON.stringify(input.runId)},
  runLabel: ${JSON.stringify(input.runLabel)},
  hypothesisId: ${JSON.stringify(input.hypothesisId)},
  probeId: ${JSON.stringify(input.probeId)},
  timestamp: new Date().toISOString(),
  message: ${JSON.stringify(input.message)},
  source: { file: ${JSON.stringify(input.sourceFile)}, line: ${input.sourceLine} },
  data: { ${data} },
}`
  let emission: string
  if (input.transport === "process") {
    emission = `void ((event) => process.stderr.write(${JSON.stringify(PROCESS_EVENT_PREFIX)} + JSON.stringify(event) + "\\n"))(${event})`
  } else if (input.transport === "extension-content") {
    const adapter = input.contentAdapter ?? "chrome.runtime.sendMessage"
    emission = `void ${adapter}({ type: "opencode-debug-event", event: ${event} })`
  } else {
    emission = `void __opencodeDebugEmit(${event})`
  }
  return {
    markerBlock: `/* DEBUG-START ${ownership} */\n${emission}\n/* DEBUG-END ${ownership} */`,
  }
}
