export const SAFE_CAPTURE = /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*)*$/

export type ProbeTransport = "process" | "http-web" | "extension-background" | "extension-content"
export type ProbeSampling = { mode: "every"; n: number } | { mode: "aggregate"; windowMs: number }

export type ProbeMarkerEdit = Readonly<{
  filePath: string
  oldString: string
  newString: string
}>

export type ProbePlanInput = Readonly<{
  runId: string
  hypothesisId: string
  sourceFile: string
  helperSourceFile?: string
  sourceLine: number
  /** Diagnostic metadata only. Marker placement is always before sourceLine. */
  sourceColumn?: number
  message: string
  captures: Array<{ label: string; path: string }>
  transport: ProbeTransport
  sampling: ProbeSampling
  markerBlock?: string
}>
