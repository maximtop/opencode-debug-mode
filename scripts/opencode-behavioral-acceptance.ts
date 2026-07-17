import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { parse } from "@babel/parser"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { applyEdits, modify, type ParseError, parse as parseJsonc } from "jsonc-parser"

const executeFile = promisify(execFile)
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const DEFAULT_OPENCODE = path.join(homedir(), ".opencode", "bin", "opencode")
const DEFAULT_OPENCODE_VERSION = "1.18.3"
const DEFAULT_PROFILE: AcceptanceProfileId = "synthetic-cli"
const AG_55256_SOURCE = path.resolve(PROJECT_ROOT, "..", "browser-extension")
const AG_55256_COMMIT = "3db0d614806984803cc4d5976fd64d78917999f2"
const SYNTHETIC_CLI_SOURCE = path.join(PROJECT_ROOT, "fixtures", "feature-flag-bug")
const DEFAULT_MODEL = "tokenguard/deepseek-v4-flash"
const DEFAULT_VARIANT = "high"
const AG_55256_PREPARE_COMMAND = "pnpm install --frozen-lockfile --ignore-scripts"
const PREPARE_TIMEOUT_MS = 20 * 60 * 1_000
const SDK_REQUEST_TIMEOUT_MS = 15_000
const SDK_CLEANUP_TIMEOUT_MS = 10_000
const MAX_CAPTURE_BYTES = 25 * 1024 * 1024
const MIN_EXACT_SECRET_LENGTH = 8
const ACCEPTANCE_ENVIRONMENT_KEY =
  /^(?:CI|COLORTERM|COMSPEC|FORCE_COLOR|LANG|LANGUAGE|LC_[A-Z0-9_]+|NO_COLOR|PATH|PATHEXT|SYSTEMROOT|TERM|TZ|WINDIR)$/iu

export const REQUIRED_DEBUG_TOOLS = Object.freeze([
  "debug_session_start",
  "debug_session_status",
  "debug_state_read",
  "debug_state_checkpoint",
  "debug_run_start",
  "debug_run_finish",
  "debug_collector_start",
  "debug_probe_prepare",
  "debug_probe_register",
  "debug_probe_remove",
  "debug_process_capture",
  "debug_evidence_read",
  "debug_cleanup",
])

const CODE_DISCOVERY_TOOLS = new Set(["read", "grep", "codesearch"])
const CUSTOM_FILTER_LOADER_PATH = /Extension[\\/]src[\\/]background[\\/]api[\\/]filters[\\/]custom[\\/]loader\.ts/iu

export const AG_55256_ACCEPTANCE_PROMPT = `[opencode-debug-mode] Debug AG-55256 on this detached baseline.

Expected: an MV3 custom filter subscribed through its original GitHub raw URL keeps updating after the repository is renamed and that URL starts redirecting.

Actual reproduction: create a GitHub filter repository, subscribe to its raw filter URL, rename the repository, change the filter content, then open Filters and run Check for updates. The old raw URL redirects, but the custom filter remains stale.

Investigate the real runtime path and establish evidence before changing product behavior. Do not assume a previously proposed diagnosis or fix is correct.`

export const SYNTHETIC_CLI_ACCEPTANCE_PROMPT = `[opencode-debug-mode] Debug this small deterministic CLI project.

Expected: npm test passes because account "team/acme" has the beta feature enabled by the checked-in data file.

Actual: npm test fails because isBetaEnabled("team/acme") returns false.

Use the real local runtime path. Show the ranked working hypotheses before instrumentation and a concise evidence decision before editing. Establish discriminating runtime evidence before changing behavior, apply the smallest evidence-backed fix, rerun the same test as post-fix verification, remove all temporary instrumentation, and finish the debug lifecycle. Do not assume the cause from the symptom. This reproduction is fully local and requires no user action.`

export type AcceptanceProfileId = "synthetic-cli" | "ag-55256"

interface AcceptanceProfile {
  id: AcceptanceProfileId
  title: string
  source: string
  commit: string
  prepareCommand: string
  prompt: string
  sourceKind: "fixture" | "git"
}

function acceptanceProfile(id: AcceptanceProfileId): AcceptanceProfile {
  if (id === "ag-55256") {
    return {
      id,
      title: "[opencode-debug-mode] AG-55256 behavioral acceptance",
      source: AG_55256_SOURCE,
      commit: AG_55256_COMMIT,
      prepareCommand: AG_55256_PREPARE_COMMAND,
      prompt: AG_55256_ACCEPTANCE_PROMPT,
      sourceKind: "git",
    }
  }
  return {
    id,
    title: "[opencode-debug-mode] synthetic CLI behavioral acceptance",
    source: SYNTHETIC_CLI_SOURCE,
    commit: "",
    prepareCommand: "",
    prompt: SYNTHETIC_CLI_ACCEPTANCE_PROMPT,
    sourceKind: "fixture",
  }
}

type JsonRecord = Record<string, unknown>

export interface HarnessOptions {
  profile: AcceptanceProfileId
  opencode: string
  expectedVersion: string
  source: string
  commit: string
  model: string
  variant: string
  prompt: string
  authFile: string
  baseConfig: string
  prepareCommand: string
  output: string
}

export interface OrderedTool {
  index: number
  messageIndex: number
  partIndex: number
  name: string
  status: string
  input: unknown
  output?: string
  startedAt?: number
  endedAt?: number
}

export interface TranscriptEntry {
  messageIndex: number
  role: string
  text: string[]
  tools: Array<{ name: string; status: string }>
}

export interface PluginCapture {
  found: boolean
  sessionDirectory?: string
  manifest?: JsonRecord
  state?: JsonRecord
  evidence: unknown[]
}

export interface RepositoryCapture {
  root: string
  status: string
  patch: string
  changedFiles: string[]
  untrackedFiles: string[]
  exactInstrumentation?: {
    passed: boolean
    errors: string[]
  }
  semanticProbeBoundaries?: {
    passed: boolean
    errors: string[]
  }
}

export interface FingerprintCapture {
  profileId: AcceptanceProfileId
  model: string
  variant: string
  sourceRevision: string
  opencodeVersion: string
  expectedVersion: string
  packageVersion: string
  pluginUrl: string
  distSha256: string
  promptSha256: string
  resolvedPluginUrls: string[]
  resolvedAgentPromptSha256?: string
  resolvedAgentPermission?: Array<{ permission: string; pattern: string; action: string }>
  registeredTools: string[]
  debugSessionStart?: { packageVersion?: string; promptSha256?: string }
}

export interface BehavioralSnapshot {
  fingerprint: FingerprintCapture
  stopReason: "question" | "idle" | "permission" | "error" | "infrastructure"
  question?: JsonRecord
  pendingQuestions: unknown[]
  openCodeSessionStatus?: unknown
  orderedTools: OrderedTool[]
  transcript: TranscriptEntry[]
  sessionDiff: unknown[]
  repository: RepositoryCapture
  plugin: PluginCapture
  postCleanup: {
    remainingPluginSessionDirectories: string[]
    repository: RepositoryCapture
  }
}

type HarnessStop = { reason: BehavioralSnapshot["stopReason"]; question?: JsonRecord; error?: unknown }

export interface AcceptanceCheck {
  id: string
  passed: boolean
  detail: string
}

export interface AcceptanceResult {
  passed: boolean
  checks: AcceptanceCheck[]
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//u, "")
}

function relativeProjectPath(projectRoot: string, value: string): string | undefined {
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value)
  const relative = path.relative(projectRoot, resolved)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined
  }
  return normalizePath(relative)
}

function truncate(value: string, maximum = 64 * 1024): string {
  if (Buffer.byteLength(value) <= maximum) return value
  return `${Buffer.from(value).subarray(0, maximum).toString("utf8")}\n[TRUNCATED]`
}

function exactSecretValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length >= MIN_EXACT_SECRET_LENGTH))].sort(
    (left, right) => right.length - left.length,
  )
}

export function redactText(value: string, sensitiveValues: readonly string[] = []): string {
  let redacted = value
  for (const secret of exactSecretValues(sensitiveValues)) redacted = redacted.split(secret).join("[REDACTED]")
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\bnpm_[A-Za-z0-9]{16,}\b/gu, "[REDACTED_NPM_TOKEN]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gu,
      "[REDACTED_TOKEN]",
    )
    .replace(/(\bauthorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,}]+/giu, "$1[REDACTED]")
    .replace(
      /((?<![\p{L}\p{N}_-])["']?(?:key|password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu,
      "$1[REDACTED]",
    )
  return truncate(redacted)
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|[_-])(?:key|password|secret|authorization|cookie|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|token)(?:$|[_-])/iu.test(
    key,
  )
}

function collectNestedSensitiveValues(value: unknown, values: Set<string>, sensitive = false): void {
  if (typeof value === "string") {
    if (sensitive && value.length >= MIN_EXACT_SECRET_LENGTH) values.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNestedSensitiveValues(item, values, sensitive)
    return
  }
  const record = asRecord(value)
  if (record === undefined) return
  for (const [key, item] of Object.entries(record)) {
    const authSensitive = sensitive || isSensitiveKey(key) || /^(?:access|refresh)$/iu.test(key)
    collectNestedSensitiveValues(item, values, authSensitive)
  }
}

function credentialedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.username !== "" || url.password !== "" || [...url.searchParams.keys()].some((key) => isSensitiveKey(key))
  } catch {
    return false
  }
}

export function collectSensitiveValues(source: NodeJS.ProcessEnv, selectedAuth: JsonRecord): string[] {
  const values = new Set<string>()
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      value.length >= MIN_EXACT_SECRET_LENGTH &&
      (isSensitiveKey(key) || credentialedUrl(value))
    ) {
      values.add(value)
    }
  }
  collectNestedSensitiveValues(selectedAuth, values)
  return exactSecretValues([...values])
}

export function sanitizeForReport(
  value: unknown,
  sensitiveValues: readonly string[] = [],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return redactText(value, sensitiveValues)
  if (typeof value !== "object" || value === null) return value
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeForReport(item, sensitiveValues, seen))

  const result: JsonRecord = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeForReport(item, sensitiveValues, seen)
  }
  return result
}

export function sanitizeToolOutput(value: string, sensitiveValues: readonly string[] = []): string {
  try {
    return JSON.stringify(sanitizeForReport(JSON.parse(value), sensitiveValues))
  } catch {
    return redactText(value, sensitiveValues)
  }
}

function sanitizedAcceptancePath(value: string): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const entry of value.split(path.delimiter)) {
    if (entry.length === 0 || !path.isAbsolute(entry)) continue
    const normalized = path.normalize(entry)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    entries.push(normalized)
  }
  return entries.join(path.delimiter)
}

export function createIsolatedEnvironment(
  source: NodeJS.ProcessEnv,
  directories: {
    home: string
    config: string
    data: string
    state: string
    cache: string
    temp: string
  },
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !ACCEPTANCE_ENVIRONMENT_KEY.test(key)) continue
    if (key.toUpperCase() === "PATH") {
      const pathValue = sanitizedAcceptancePath(value)
      if (pathValue !== "") result.PATH = pathValue
    } else result[key] = value
  }
  return {
    ...result,
    HOME: directories.home,
    USERPROFILE: directories.home,
    XDG_CONFIG_HOME: path.dirname(directories.config),
    OPENCODE_CONFIG_DIR: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_STATE_HOME: directories.state,
    XDG_CACHE_HOME: directories.cache,
    TMPDIR: directories.temp,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }
}

export function createSelectedProviderAuth(auth: JsonRecord, providerID: string): JsonRecord {
  const selected = auth[providerID]
  if (asRecord(selected) === undefined) throw new Error(`OpenCode auth has no entry for ${providerID}`)
  return { [providerID]: structuredClone(selected) }
}

function assertNoInlineProviderCredential(value: unknown, location = "provider"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoInlineProviderCredential(item, `${location}[${index}]`)
    return
  }
  const record = asRecord(value)
  if (record === undefined) return
  for (const [key, item] of Object.entries(record)) {
    if (
      /^(?:authorization|cookie|password|secret|clientSecret|apiKey|accessToken|refreshToken|token)$/iu.test(key) &&
      item !== undefined &&
      item !== null &&
      item !== ""
    ) {
      throw new Error(`Selected provider contains an inline credential at ${location}.${key}; keep it in auth.json`)
    }
    if (/^(?:baseURL|url)$/iu.test(key) && typeof item === "string") {
      try {
        const url = new URL(item)
        const hasSensitiveQuery = [...url.searchParams.keys()].some((name) =>
          /^(?:key|token|secret|password|authorization)$/iu.test(name),
        )
        if (url.username !== "" || url.password !== "" || hasSensitiveQuery) {
          throw new Error(`Selected provider URL contains inline credentials at ${location}.${key}`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("inline credentials")) throw error
      }
    }
    assertNoInlineProviderCredential(item, `${location}.${key}`)
  }
}

export function parseBaseConfig(text: string): JsonRecord {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    throw new Error(`Base OpenCode config has ${errors.length} JSONC parse error(s)`)
  }
  const record = asRecord(parsed)
  if (record === undefined) throw new Error("Base OpenCode config must contain an object")
  return record
}

export function createSelectedProviderConfig(
  baseConfig: JsonRecord,
  providerID: string,
  pluginUrl: string,
): JsonRecord {
  const providers = asRecord(baseConfig.provider)
  const selectedProvider = asRecord(providers?.[providerID])
  if (selectedProvider === undefined) {
    throw new Error(`Base OpenCode config has no provider definition for ${providerID}`)
  }
  assertNoInlineProviderCredential(selectedProvider, `provider.${providerID}`)
  const model = asString(baseConfig.model)
  const smallModel = asString(baseConfig.small_model)
  return {
    ...(model?.startsWith(`${providerID}/`) === true ? { model } : {}),
    ...(smallModel?.startsWith(`${providerID}/`) === true ? { small_model: smallModel } : {}),
    provider: { [providerID]: structuredClone(selectedProvider) },
    plugin: [pluginUrl],
    share: "disabled",
    autoupdate: false,
    default_agent: "debug",
    permission: {
      "*": "allow",
      bash: {
        "*": "allow",
        "git push": "deny",
        "git push *": "deny",
        "git commit": "deny",
        "git commit *": "deny",
        "git tag": "deny",
        "git tag *": "deny",
        "gh *": "deny",
        "bb *": "deny",
        "npm publish": "deny",
        "npm publish *": "deny",
        "pnpm publish": "deny",
        "pnpm publish *": "deny",
        "yarn publish": "deny",
        "yarn publish *": "deny",
      },
      external_directory: "deny",
      debug_process_external: "deny",
      question: "allow",
    },
  }
}

function optionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

export function parseHarnessOptions(args: string[], environment: NodeJS.ProcessEnv = process.env): HarnessOptions {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-")
  const home = environment.HOME ?? homedir()
  const profileIndex = args.indexOf("--profile")
  const profileValue = profileIndex < 0 ? DEFAULT_PROFILE : optionValue(args, profileIndex, "--profile")
  if (profileValue !== "synthetic-cli" && profileValue !== "ag-55256") {
    throw new Error(`Unknown profile: ${profileValue}`)
  }
  const profile = acceptanceProfile(profileValue)
  const values: HarnessOptions = {
    profile: profile.id,
    opencode: path.join(home, ".opencode", "bin", "opencode"),
    expectedVersion: DEFAULT_OPENCODE_VERSION,
    source: profile.source,
    commit: profile.commit,
    model: DEFAULT_MODEL,
    variant: DEFAULT_VARIANT,
    prompt: profile.prompt,
    authFile: path.join(home, ".local", "share", "opencode", "auth.json"),
    baseConfig: path.join(home, ".config", "opencode", "opencode.jsonc"),
    prepareCommand: profile.prepareCommand,
    output: path.join(PROJECT_ROOT, ".opencode-debug-mode", "acceptance", timestamp),
  }

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === "--help") throw new Error("HELP")
    if (name === "--profile") index += 1
    else if (name === "--opencode") values.opencode = optionValue(args, index++, name)
    else if (name === "--expected-version") values.expectedVersion = optionValue(args, index++, name)
    else if (name === "--source") values.source = optionValue(args, index++, name)
    else if (name === "--commit") values.commit = optionValue(args, index++, name)
    else if (name === "--model") values.model = optionValue(args, index++, name)
    else if (name === "--variant") values.variant = optionValue(args, index++, name)
    else if (name === "--auth") values.authFile = optionValue(args, index++, name)
    else if (name === "--base-config") values.baseConfig = optionValue(args, index++, name)
    else if (name === "--prepare-command") values.prepareCommand = optionValue(args, index++, name)
    else if (name === "--output") values.output = optionValue(args, index++, name)
    else if (name === "--prompt-file") {
      const filename = optionValue(args, index++, name)
      values.prompt = `@file:${filename}`
    } else {
      throw new Error(`Unknown option: ${name}`)
    }
  }
  return values
}

export function usage(): string {
  return `Usage: node --experimental-strip-types scripts/opencode-behavioral-acceptance.ts [options]

Runs a real, isolated OpenCode debug-agent acceptance session. The default synthetic CLI profile must finish autonomously; the AG-55256 profile stops at its first Question.

Options:
  --profile <id>             synthetic-cli (default) or ag-55256
  --opencode <path>          OpenCode executable (default: ${DEFAULT_OPENCODE})
  --expected-version <ver>   Required OpenCode version (default: ${DEFAULT_OPENCODE_VERSION})
  --source <path>            Override the selected fixture/git source
  --commit <sha>             Override the detached commit for ag-55256
  --model <provider/model>   Model (default: ${DEFAULT_MODEL})
  --variant <name>           Model variant (default: ${DEFAULT_VARIANT})
  --auth <path>              OpenCode auth.json source for the selected provider only
  --base-config <path>       JSONC source for only the selected provider definition
  --prepare-command <cmd>    Override disposable-project setup
  --prompt-file <path>       Override the selected profile prompt
  --output <path>            New artifact directory
  --help                     Show this text
`
}

function toolInput(tool: OrderedTool): JsonRecord {
  return asRecord(tool.input) ?? {}
}

function checkpointState(tool: OrderedTool): JsonRecord | undefined {
  const value = toolInput(tool).state
  const direct = asRecord(value)
  if (direct !== undefined) return direct
  if (typeof value !== "string") return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

function isExplicitMutation(tool: OrderedTool): boolean {
  const name = tool.name.toLowerCase()
  if (["edit", "write", "apply_patch", "multiedit", "patch"].includes(name)) return true
  if (name !== "bash") return false
  const command = asString(toolInput(tool).command) ?? asString(toolInput(tool).cmd) ?? ""
  return /(?:^|[;&|\n]\s*)(?:rm|mv|cp|mkdir|touch|install)\b|(?:^|\s)(?:sed\s+-i|perl\s+-pi|git\s+(?:apply|checkout|reset|clean)|npm\s+(?:install|ci)|pnpm\s+install|yarn\s+install)\b|(?:^|[^>])>{1,2}(?!=)/iu.test(
    command,
  )
}

function isAppliedMutation(tool: OrderedTool): boolean {
  if (!isExplicitMutation(tool) || tool.status !== "completed") return false
  if (tool.output === undefined) return true
  try {
    const envelope = asRecord(JSON.parse(tool.output))
    return envelope?.ok !== false
  } catch {
    return true
  }
}

function parseToolEnvelope(tool: OrderedTool | undefined): { ok: boolean; data?: JsonRecord } {
  if (tool?.status !== "completed" || tool.output === undefined) return { ok: false }
  try {
    const envelope = asRecord(JSON.parse(tool.output))
    const data = asRecord(envelope?.data)
    return envelope?.ok === true ? { ok: true, ...(data === undefined ? {} : { data }) } : { ok: false }
  } catch {
    return { ok: false }
  }
}

function toolSucceeded(tool: OrderedTool | undefined): boolean {
  return parseToolEnvelope(tool).ok
}

function protocolErrorSignature(tool: OrderedTool): string | undefined {
  if (tool.output === undefined) return undefined
  try {
    const envelope = asRecord(JSON.parse(tool.output))
    if (envelope?.ok !== false) return undefined
    const error = asRecord(envelope.error)
    return `${tool.name}:${asString(error?.code) ?? "unknown"}:${asString(error?.message) ?? "unknown"}`
  } catch {
    return undefined
  }
}

function strictReproductionQuestion(question: JsonRecord | undefined): boolean {
  if (question === undefined) return false
  const questions = asArray(question.questions)
  if (questions.length !== 1) return false
  const item = asRecord(questions[0])
  const options = asArray(item?.options)
  if (
    item === undefined ||
    options.length !== 3 ||
    (item.multiple !== undefined && item.multiple !== false) ||
    (item.custom !== undefined && item.custom !== false)
  ) {
    return false
  }
  const labels = options.map((option) => asString(asRecord(option)?.label)?.trim().toLowerCase())
  if (labels.some((label) => label === undefined)) return false
  return (
    labels.filter((label) => label === "reproduced").length === 1 &&
    labels.filter((label) => label === "did not reproduce").length === 1 &&
    labels.filter((label) => label === "could not complete").length === 1
  )
}

function questionOffersSpeculativeChoice(question: JsonRecord | undefined): boolean {
  if (question === undefined) return false
  const questions = asArray(question.questions)
  const choiceText = questions
    .flatMap((item) => {
      const record = asRecord(item)
      return [
        asString(record?.header) ?? "",
        asString(record?.question) ?? "",
        ...asArray(record?.options).flatMap((option) => {
          const value = asRecord(option)
          return [asString(value?.label) ?? "", asString(value?.description) ?? ""]
        }),
      ]
    })
    .join(" ")
  return /(?:\b(?:choose|select|pick|decide|which|what)\b[\s\S]{0,80}\b(?:hypothesis|root cause|cause|fix|implementation|workaround|approach|direction|option)\b|\b(?:hypothesis|root cause|fix direction|implementation (?:choice|option)|speculative workaround)\b[\s\S]{0,80}\b(?:choose|select|pick|decide|prefer|want|proceed|apply)\b|\bhypothesis\s*[a-z0-9]+\b)/iu.test(
    choiceText,
  )
}

function normalizedVisibleText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
}

function containsVisiblePhrase(value: string, expected: string): boolean {
  const normalizedValue = normalizedVisibleText(value)
  const normalizedExpected = normalizedVisibleText(expected)
  return normalizedExpected.length > 0 && ` ${normalizedValue} `.includes(` ${normalizedExpected} `)
}

const PROCEDURE_STOP_WORDS = new Set(
  "a an and after before but did do does for from had has have how i if in into is it its of on or please so that the then this through to was were what when where which with you your now only actual expected happened following prepared step steps".split(
    " ",
  ),
)

const PROCEDURE_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  added: "subscribe",
  adding: "subscribe",
  adds: "subscribe",
  click: "run",
  clicked: "run",
  clicking: "run",
  clicks: "run",
  changes: "change",
  changed: "change",
  changing: "change",
  created: "create",
  creates: "create",
  creating: "create",
  edit: "change",
  edited: "change",
  editing: "change",
  edits: "change",
  executed: "run",
  executing: "run",
  executes: "run",
  filters: "filter",
  go: "open",
  goes: "open",
  imported: "subscribe",
  importing: "subscribe",
  imports: "subscribe",
  made: "create",
  make: "create",
  makes: "create",
  modify: "change",
  modified: "change",
  modifies: "change",
  modifying: "change",
  navigate: "open",
  navigated: "open",
  navigates: "open",
  navigating: "open",
  opened: "open",
  opening: "open",
  opens: "open",
  redirected: "redirect",
  redirecting: "redirect",
  redirects: "redirect",
  renamed: "rename",
  renames: "rename",
  renaming: "rename",
  repo: "repository",
  repositories: "repository",
  ran: "run",
  refresh: "update",
  refreshed: "update",
  refreshes: "update",
  refreshing: "update",
  remain: "stay",
  remained: "stay",
  remaining: "stay",
  remains: "stay",
  rule: "content",
  rules: "content",
  running: "run",
  runs: "run",
  stayed: "stay",
  stays: "stay",
  subscribed: "subscribe",
  subscribes: "subscribe",
  subscribing: "subscribe",
  trigger: "run",
  triggered: "run",
  triggering: "run",
  triggers: "run",
  unchanged: "stale",
  updated: "update",
  updates: "update",
  updating: "update",
}

function procedureTokenList(value: string): string[] {
  const tokens = normalizedVisibleText(value)
    .split(" ")
    .map((token) => PROCEDURE_TOKEN_ALIASES[token] ?? token)
  return tokens
    .map((token, index) => {
      const context = tokens.slice(Math.max(0, index - 2), index + 3)
      if (token === "change" && context.includes("repository") && context.includes("name")) return "rename"
      if (token === "update" && context.includes("content")) return "change"
      if ((token === "add" || token === "import") && (context.includes("url") || context.includes("filter"))) {
        return "subscribe"
      }
      if (token === "old" && context.includes("content") && !context.includes("raw")) return "stale"
      return token
    })
    .filter((token) => token.length >= 2 && !/^\d+$/u.test(token) && !PROCEDURE_STOP_WORDS.has(token))
}

function procedureActions(tokens: readonly string[]): string[] {
  const actions: string[] = []
  for (const [index, token] of tokens.entries()) {
    const context = tokens.slice(Math.max(0, index - 2), index + 3)
    const belongsToUpdateCheck = token === "run" && context.includes("check") && context.includes("update")
    if (token === "check" && context.includes("update")) {
      actions.push("trigger-update-check")
    } else if (!belongsToUpdateCheck && ["create", "subscribe", "rename", "change", "open", "run"].includes(token)) {
      actions.push(token)
    }
  }
  return actions
}

function orderedActionsCovered(expected: readonly string[], actual: readonly string[]): boolean {
  let cursor = 0
  for (const action of expected) {
    const found = actual.indexOf(action, cursor)
    if (found < 0) return false
    cursor = found + 1
  }
  return true
}

function coversPreparedProcedure(prompt: string, procedure: string): boolean {
  if (containsVisiblePhrase(prompt, procedure)) return true
  const expectedTokens = procedureTokenList(procedure)
  const expected = new Set(expectedTokens)
  if (expected.size === 0) return false
  const actualTokens = procedureTokenList(prompt)
  const actual = new Set(actualTokens)
  let matched = 0
  for (const token of expected) {
    if (actual.has(token)) matched += 1
  }
  if (matched < Math.ceil(expected.size * 0.8)) return false
  if (!orderedActionsCovered(procedureActions(expectedTokens), procedureActions(actualTokens))) return false
  return ["redirect", "stale"].every((signal) => !expected.has(signal) || actual.has(signal))
}

function questionContainsProcedure(question: JsonRecord | undefined, procedure: string | undefined): boolean {
  if (question === undefined || procedure === undefined) return false
  const questions = asArray(question.questions)
  const item = questions.length === 1 ? asRecord(questions[0]) : undefined
  const prompt = asString(item?.question)
  return prompt !== undefined && coversPreparedProcedure(prompt, procedure)
}

function containsSelfContainedMv3Activation(procedure: string | undefined): boolean {
  if (procedure === undefined) return false
  const normalized = procedure.normalize("NFKC").toLowerCase().replace(/\\/gu, "/")
  const commandIndex = normalized.indexOf("pnpm dev chrome-mv3")
  const activationMatch = /\b(?:reload|load)\b[\s\S]{0,80}\b(?:unpacked|extension)\b/iu.exec(normalized)
  const activationIndex = activationMatch?.index ?? -1
  const artifactIndex = normalized.indexOf("build/dev/chrome-mv3")
  const originalSteps = artifactIndex < 0 ? "" : normalized.slice(artifactIndex + "build/dev/chrome-mv3".length)
  const originalActions = procedureActions(procedureTokenList(originalSteps))
  const preservesOriginalSteps = orderedActionsCovered(
    ["create", "subscribe", "rename", "change", "open", "trigger-update-check"],
    originalActions,
  )
  return (
    commandIndex >= 0 && activationIndex > commandIndex && artifactIndex > activationIndex && preservesOriginalSteps
  )
}

function toolReadsCustomFilterLoader(tool: OrderedTool): boolean {
  if (
    !CODE_DISCOVERY_TOOLS.has(tool.name.toLowerCase()) ||
    tool.status !== "completed" ||
    typeof tool.output !== "string"
  ) {
    return false
  }
  return CUSTOM_FILTER_LOADER_PATH.test(`${JSON.stringify(tool.input)}\n${tool.output}`)
}

function customFilterLoaderHypothesisText(hypotheses: JsonRecord[] | undefined): string {
  return (hypotheses ?? [])
    .filter((hypothesis) =>
      /CustomFilterLoader|downloadRulesWithTimeout|custom[\\/]loader(?:\.ts)?/iu.test(JSON.stringify(hypothesis)),
    )
    .map((hypothesis) => JSON.stringify(hypothesis))
    .join("\n")
}

function normalizeQuestionForMatching(value: unknown): JsonRecord | undefined {
  const request = asRecord(value)
  const questions = asArray(request?.questions)
  const item = asRecord(questions[0])
  if (request === undefined || questions.length !== 1 || item === undefined) return request
  if (item.custom !== undefined && item.multiple !== undefined) return request
  return {
    ...request,
    questions: [
      {
        ...item,
        ...(item.multiple === undefined ? { multiple: false } : {}),
        ...(item.custom === undefined ? { custom: false } : {}),
      },
    ],
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  const record = asRecord(value)
  if (record === undefined) return value
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  )
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
}

function stringList(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string")
}

function validHypothesisList(value: unknown): JsonRecord[] | undefined {
  const hypotheses = asArray(value).map(asRecord)
  if (
    hypotheses.length < 2 ||
    hypotheses.length > 4 ||
    hypotheses.some(
      (hypothesis) =>
        hypothesis === undefined ||
        typeof hypothesis.rank !== "number" ||
        typeof hypothesis.id !== "string" ||
        typeof hypothesis.statement !== "string" ||
        asArray(hypothesis.confirmationSignals).length === 0 ||
        asArray(hypothesis.eliminationSignals).length === 0,
    )
  ) {
    return undefined
  }
  return hypotheses as JsonRecord[]
}

function sameHypotheses(left: JsonRecord[], right: JsonRecord[]): boolean {
  const signature = (item: JsonRecord) =>
    JSON.stringify({
      id: item.id,
      rank: item.rank,
      statement: item.statement,
      confirmationSignals: item.confirmationSignals,
      eliminationSignals: item.eliminationSignals,
    })
  return left.map(signature).sort().join("\n") === right.map(signature).sort().join("\n")
}

function visibleHypothesisCount(text: string): number | undefined {
  const lines = text.split(/\r?\n/u)
  const heading = lines.findIndex((line) => /working hypotheses/iu.test(line))
  if (heading < 0) return undefined
  const body: string[] = []
  for (const line of lines.slice(heading + 1)) {
    if (/^\s*#{1,6}\s+/u.test(line) && body.length > 0) break
    body.push(line)
  }

  let count = 0
  for (const line of body) {
    if (/^\s{0,3}(?:\d{1,2}[.)]|(?:[-*]\s+)?(?:\*\*)?(?:H(?:ypothesis)?\s*)\d{1,2}\b)\s*\S/iu.test(line)) count += 1
  }
  if (count > 0) return count

  const table = body
    .map((line) => line.trim())
    .filter((line) => line.includes("|"))
    .map((line) =>
      line
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
  const separatorIndex = table.findIndex(
    (cells) => cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell)),
  )
  if (separatorIndex <= 0) return 0
  const header = table[separatorIndex - 1] ?? []
  const rankColumn = header.findIndex((cell) => /^rank$/iu.test(cell.replace(/[`*_~]/gu, "").trim()))
  if (rankColumn < 0) return 0
  return table
    .slice(separatorIndex + 1)
    .filter((cells) => /^\d{1,2}$/u.test(cells[rankColumn]?.replace(/[`*_~]/gu, "").trim() ?? "")).length
}

function resolvedPermissionAction(fingerprint: FingerprintCapture, permission: string): string | undefined {
  return fingerprint.resolvedAgentPermission
    ?.filter((rule) => rule.permission === "*" || rule.permission === permission)
    .at(-1)?.action
}

export interface InstrumentationFileSnapshot {
  baseline: Buffer | null
  current: Buffer | null
}

type BabelNodeLike = {
  type: string
  start?: number | null
  end?: number | null
  [key: string]: unknown
}

type StatementBoundary = Readonly<{
  node: BabelNodeLike
  offset: number
}>

function babelNode(value: unknown): value is BabelNodeLike {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as JsonRecord).type === "string"
  )
}

function onlyJavaScriptTrivia(value: string): boolean {
  let offset = 0
  while (offset < value.length) {
    const whitespace = /^\s+/u.exec(value.slice(offset))?.[0]
    if (whitespace !== undefined) {
      offset += whitespace.length
      continue
    }
    if (value.startsWith("//", offset)) {
      const ending = /\r\n|\r|\n/u.exec(value.slice(offset + 2))
      offset = ending === null ? value.length : offset + 2 + ending.index + ending[0].length
      continue
    }
    if (value.startsWith("/*", offset)) {
      const end = value.indexOf("*/", offset + 2)
      if (end < 0) return false
      offset = end + 2
      continue
    }
    return false
  }
  return true
}

function parseProbeSource(filename: string, source: string): BabelNodeLike {
  const extension = path.extname(filename).toLowerCase()
  const plugins: Array<"decorators-legacy" | "jsx" | "typescript"> = ["decorators-legacy"]
  if ([".ts", ".tsx"].includes(extension)) plugins.push("typescript")
  if ([".jsx", ".tsx"].includes(extension)) plugins.push("jsx")
  return parse(source, {
    sourceType: "unambiguous",
    sourceFilename: filename,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    plugins,
  }).program as unknown as BabelNodeLike
}

function semanticStatementBoundaries(program: BabelNodeLike): Readonly<{
  statements: StatementBoundary[]
  blocks: BabelNodeLike[]
}> {
  const statements: StatementBoundary[] = []
  const blocks: BabelNodeLike[] = []
  const visit = (node: BabelNodeLike): void => {
    if (["BlockStatement", "StaticBlock", "TSModuleBlock"].includes(node.type)) blocks.push(node)
    const statementArrays: unknown[][] = []
    if (["Program", "BlockStatement", "StaticBlock", "TSModuleBlock"].includes(node.type) && Array.isArray(node.body)) {
      statementArrays.push(node.body)
    }
    if (node.type === "SwitchCase" && Array.isArray(node.consequent)) statementArrays.push(node.consequent)
    for (const values of statementArrays) {
      for (const value of values) {
        if (babelNode(value) && typeof value.start === "number") statements.push({ node: value, offset: value.start })
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        ["loc", "leadingComments", "innerComments", "trailingComments", "comments", "tokens", "errors"].includes(key)
      ) {
        continue
      }
      if (babelNode(value)) visit(value)
      else if (Array.isArray(value)) {
        for (const child of value) if (babelNode(child)) visit(child)
      }
    }
  }
  visit(program)
  return { statements, blocks }
}

function safeClosingBlockBoundary(source: string, offset: number, blocks: BabelNodeLike[]): boolean {
  return blocks.some((block) => {
    if (typeof block.end !== "number" || block.end <= offset || source[block.end - 1] !== "}") return false
    return onlyJavaScriptTrivia(source.slice(offset, block.end - 1))
  })
}

function declaredPatternNames(value: unknown, names: Set<string>): void {
  if (!babelNode(value)) return
  if (value.type === "Identifier" && typeof value.name === "string") {
    names.add(value.name)
    return
  }
  if (value.type === "ObjectProperty") {
    declaredPatternNames(value.value, names)
    return
  }
  if (value.type === "RestElement") {
    declaredPatternNames(value.argument, names)
    return
  }
  if (value.type === "AssignmentPattern") {
    declaredPatternNames(value.left, names)
    return
  }
  if (value.type === "ArrayPattern" && Array.isArray(value.elements)) {
    for (const element of value.elements) declaredPatternNames(element, names)
    return
  }
  if (value.type === "ObjectPattern" && Array.isArray(value.properties)) {
    for (const property of value.properties) declaredPatternNames(property, names)
  }
}

function namesInitializedByStatement(node: BabelNodeLike): Set<string> {
  let declaration = node
  if (["ExportDefaultDeclaration", "ExportNamedDeclaration"].includes(node.type) && babelNode(node.declaration)) {
    declaration = node.declaration
  }
  const names = new Set<string>()
  if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
    for (const item of declaration.declarations) {
      if (babelNode(item)) declaredPatternNames(item.id, names)
    }
  } else if (["ClassDeclaration", "TSEnumDeclaration"].includes(declaration.type) && babelNode(declaration.id)) {
    declaredPatternNames(declaration.id, names)
  }
  return names
}

function captureRoots(probe: JsonRecord): Set<string> {
  const roots = new Set<string>()
  for (const capture of asArray(probe.captures).map(asRecord)) {
    const capturePath = asString(capture?.path)
    const root = capturePath === undefined ? undefined : /^[A-Za-z_$][\w$]*/u.exec(capturePath)?.[0]
    if (root !== undefined) roots.add(root)
  }
  return roots
}

type SemanticOwnedInsertion = Readonly<{
  filename: string
  block: string
  probeId: string
  kind: "probe" | "helper"
}>

function semanticOwnedInsertions(projectRoot: string, probes: JsonRecord[]): SemanticOwnedInsertion[] {
  const insertions: SemanticOwnedInsertion[] = []
  for (const probe of probes) {
    const probeId = asString(probe.id) ?? "unknown"
    const sourceFile = asString(probe.sourceFile)
    const expectedBlock = asString(probe.expectedBlock)
    const filename = sourceFile === undefined ? undefined : relativeProjectPath(projectRoot, sourceFile)
    if (filename !== undefined && expectedBlock !== undefined) {
      insertions.push({ filename, block: expectedBlock, probeId, kind: "probe" })
    }

    const helperSourceFile = asString(probe.helperSourceFile)
    const helperImportBlock = asString(probe.helperImportBlock)
    const helperFilename =
      helperSourceFile === undefined ? undefined : relativeProjectPath(projectRoot, helperSourceFile)
    if (helperFilename !== undefined && helperImportBlock !== undefined) {
      insertions.push({ filename: helperFilename, block: helperImportBlock, probeId, kind: "helper" })
    }
  }
  return insertions
}

function sourceLineAtOffset(source: string, offset: number): number {
  return source.slice(0, Math.max(0, Math.min(offset, source.length))).split(/\r\n|\r|\n/u).length
}

/**
 * Independently validates that every active probe is inserted at an AST statement boundary and cannot read a
 * declaration before the selected source line initializes it. Exact marker-byte ownership is validated separately.
 */
export function validateSemanticProbeBoundaries(input: {
  projectRoot: string
  files: ReadonlyMap<string, InstrumentationFileSnapshot>
  manifest?: JsonRecord
}): { passed: boolean; errors: string[] } {
  const errors: string[] = []
  const activeProbes = asArray(input.manifest?.probes)
    .map(asRecord)
    .filter((probe): probe is JsonRecord => probe !== undefined && probe.status !== "removed")
  const ownedInsertions = semanticOwnedInsertions(input.projectRoot, activeProbes)

  for (const probe of activeProbes) {
    const probeId = asString(probe.id) ?? "unknown"
    const filename =
      typeof probe.sourceFile === "string" ? relativeProjectPath(input.projectRoot, probe.sourceFile) : undefined
    if (filename === undefined) {
      errors.push(`probe ${probeId} source escaped the project`)
      continue
    }
    const file = input.files.get(filename)
    if (file?.baseline === undefined || file.baseline === null || file.current === null) {
      errors.push(`probe ${probeId} baseline or current source was unavailable: ${filename}`)
      continue
    }
    const source = file.baseline.toString("utf8")
    const current = file.current.toString("utf8")
    const fileInsertions = ownedInsertions.filter((insertion) => insertion.filename === filename)
    const located = fileInsertions.flatMap((insertion) => {
      const first = current.indexOf(insertion.block)
      return first >= 0 && current.indexOf(insertion.block, first + insertion.block.length) < 0
        ? [{ ...insertion, offset: first }]
        : []
    })
    if (located.length !== fileInsertions.length) {
      errors.push(`probe ${probeId} owned insertion locations were incomplete or ambiguous: ${filename}`)
      continue
    }
    const overlapping = located.some((left, index) =>
      located.some(
        (right, rightIndex) =>
          index !== rightIndex &&
          left.offset < right.offset + right.block.length &&
          right.offset < left.offset + left.block.length,
      ),
    )
    const target = located.find((insertion) => insertion.probeId === probeId && insertion.kind === "probe")
    if (overlapping || target === undefined) {
      errors.push(`probe ${probeId} owned insertion location was invalid: ${filename}`)
      continue
    }
    let reconstructed = current
    for (const insertion of [...located].sort((left, right) => right.offset - left.offset)) {
      reconstructed =
        reconstructed.slice(0, insertion.offset) + reconstructed.slice(insertion.offset + insertion.block.length)
    }
    if (reconstructed !== source) {
      errors.push(`probe ${probeId} insertion could not be mapped independently to the baseline: ${filename}`)
      continue
    }
    const offset =
      target.offset -
      located
        .filter((insertion) => insertion.offset < target.offset)
        .reduce((removed, insertion) => removed + insertion.block.length, 0)
    const sourceLine = sourceLineAtOffset(source, offset)

    let parsed: BabelNodeLike
    try {
      parsed = parseProbeSource(filename, source)
    } catch (error) {
      const reason = error instanceof Error ? error.message.split(/\r?\n/u)[0] : "unknown parse error"
      errors.push(`probe ${probeId} baseline could not be parsed: ${filename}: ${reason}`)
      continue
    }
    const boundaries = semanticStatementBoundaries(parsed)
    const candidate = boundaries.statements
      .filter((boundary) => boundary.offset >= offset && onlyJavaScriptTrivia(source.slice(offset, boundary.offset)))
      .sort((left, right) => left.offset - right.offset || Number(left.node.end) - Number(right.node.end))[0]
    const atProgramEof = offset === source.length
    const atClosingBlock = safeClosingBlockBoundary(source, offset, boundaries.blocks)
    if (candidate === undefined && !atProgramEof && !atClosingBlock) {
      errors.push(`probe ${probeId} source line is not an executable statement boundary: ${filename}:${sourceLine}`)
      continue
    }

    if (candidate !== undefined) {
      const declared = namesInitializedByStatement(candidate.node)
      const unsafeRoots = [...captureRoots(probe)].filter((root) => declared.has(root))
      if (unsafeRoots.length > 0) {
        errors.push(
          `probe ${probeId} captures ${unsafeRoots.join(", ")} before the selected statement initializes it: ${filename}:${sourceLine}`,
        )
      }
    }
  }

  return { passed: errors.length === 0, errors: [...new Set(errors)] }
}

function occurrenceCount(value: string, needle: string): number {
  return needle === "" ? 0 : value.split(needle).length - 1
}

function removedOwnershipSignatures(
  ownership: JsonRecord,
  block: string,
  markerStart: string,
  markerEnd: string,
): string[] {
  const signatures: string[] = []
  const bodyStart = block.indexOf(markerStart)
  const bodyEnd = block.indexOf(markerEnd, bodyStart + markerStart.length)
  if (bodyStart >= 0 && bodyEnd > bodyStart) {
    const body = block.slice(bodyStart + markerStart.length, bodyEnd).trim()
    if (body.length > 0) signatures.push(body)
  }

  const helperImport = ownership.ownershipKind === "helper import"
  const probeId = asString(ownership.id)
  if (!helperImport && probeId !== undefined) signatures.push(`probeId: ${JSON.stringify(probeId)}`)
  for (const match of block.matchAll(/\b__opencodeDebugEmit_[a-f0-9]{12}\b/gu)) {
    if (match[0] !== undefined) {
      signatures.push(helperImport ? `__opencodeDebugEmit as ${match[0]}` : `void ${match[0]}(`)
    }
  }
  return [...new Set(signatures)]
}

function removeDeclaredPermission(text: string, change: JsonRecord): string | undefined {
  if (change.addedBySession !== true) return text
  const property = asString(change.property)
  const matchPattern = asString(change.matchPattern)
  if ((property !== "permissions" && property !== "host_permissions") || matchPattern === undefined) return undefined
  const errors: ParseError[] = []
  const manifest = asRecord(parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }))
  const values = manifest === undefined ? [] : asArray(manifest[property])
  const indexes = values.flatMap((value, index) => (value === matchPattern ? [index] : []))
  if (errors.length > 0 || indexes.length !== 1) return undefined
  const index = indexes[0]
  if (index === undefined) return undefined
  return applyEdits(
    text,
    modify(text, [property, index], undefined, {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" },
    }),
  )
}

export function validateExactInstrumentationChanges(input: {
  projectRoot: string
  changedFiles: string[]
  untrackedFiles: string[]
  files: ReadonlyMap<string, InstrumentationFileSnapshot>
  manifest?: JsonRecord
}): { passed: boolean; errors: string[] } {
  const errors: string[] = []
  const changed = new Set(input.changedFiles.map(normalizePath))
  const untracked = new Set(input.untrackedFiles.map(normalizePath))
  if (changed.size === 0) errors.push("no instrumentation changes were present")

  const relative = (value: unknown): string | undefined =>
    typeof value === "string" ? relativeProjectPath(input.projectRoot, value) : undefined
  const probes = asArray(input.manifest?.probes)
    .map(asRecord)
    .filter((value): value is JsonRecord => value !== undefined)
  const ownedFiles = asArray(input.manifest?.ownedFiles)
    .map(asRecord)
    .filter((value): value is JsonRecord => value !== undefined)
  const permissions = asArray(input.manifest?.permissionChanges)
    .map(asRecord)
    .filter((value): value is JsonRecord => value !== undefined)

  const probesByFile = new Map<string, JsonRecord[]>()
  const removedProbesByFile = new Map<string, JsonRecord[]>()
  for (const probe of probes) {
    const removed = probe.status === "removed"
    const filename = relative(probe.sourceFile)
    if (filename === undefined) {
      errors.push("probe source escaped the project")
      continue
    }
    const probeMap = removed ? removedProbesByFile : probesByFile
    const entries = probeMap.get(filename) ?? []
    entries.push(probe)
    probeMap.set(filename, entries)
    if (!removed && probe.validationStatus === "validated" && !changed.has(filename)) {
      errors.push(`validated probe file was not changed: ${filename}`)
    }
    const helperFilename = relative(probe.helperSourceFile)
    const helperBlock = asString(probe.helperImportBlock)
    const helperDeclared =
      probe.helperSourceFile !== undefined ||
      probe.helperImportBlock !== undefined ||
      probe.helperImportHash !== undefined
    if (helperDeclared && (helperFilename === undefined || helperBlock === undefined)) {
      errors.push("probe helper import ownership was incomplete")
    } else if (helperFilename !== undefined && helperBlock !== undefined) {
      const helperLines = helperBlock.split(/\r?\n/u)
      const helperMarkerStart = helperLines.find((line) =>
        line.trimStart().startsWith("/* DEBUG-START opencode-debug-mode"),
      )
      const helperMarkerEnd = helperLines.find((line) =>
        line.trimStart().startsWith("/* DEBUG-END opencode-debug-mode"),
      )
      const helperEntry: JsonRecord = {
        ...probe,
        ownershipKind: "helper import",
        sourceFile: probe.helperSourceFile,
        expectedBlock: helperBlock,
        expectedHash: probe.helperImportHash,
        markerStart: helperMarkerStart,
        markerEnd: helperMarkerEnd,
      }
      const helperEntries = probeMap.get(helperFilename) ?? []
      helperEntries.push(helperEntry)
      probeMap.set(helperFilename, helperEntries)
      if (!removed && probe.validationStatus === "validated" && !changed.has(helperFilename)) {
        errors.push(`validated probe helper import was not changed: ${helperFilename}`)
      }
    }
  }

  for (const [filename, removedProbes] of removedProbesByFile) {
    const file = input.files.get(filename)
    if (file === undefined) {
      errors.push(`removed probe file was unavailable for absence validation: ${filename}`)
      continue
    }
    if (file.current === null) continue
    const current = file.current.toString("utf8")
    for (const removedProbe of removedProbes) {
      const block = asString(removedProbe.expectedBlock)
      const expectedHash = asString(removedProbe.expectedHash)
      const markerStart = asString(removedProbe.markerStart)
      const markerEnd = asString(removedProbe.markerEnd)
      const kind = asString(removedProbe.ownershipKind) ?? "probe"
      if (
        block === undefined ||
        expectedHash === undefined ||
        markerStart === undefined ||
        markerEnd === undefined ||
        sha256(block) !== expectedHash
      ) {
        errors.push(`removed ${kind} ownership was incomplete: ${filename}`)
        continue
      }
      if (
        occurrenceCount(current, block) !== 0 ||
        occurrenceCount(current, markerStart) !== 0 ||
        occurrenceCount(current, markerEnd) !== 0 ||
        removedOwnershipSignatures(removedProbe, block, markerStart, markerEnd).some((signature) =>
          current.includes(signature),
        )
      ) {
        errors.push(`removed ${kind} ownership remained in the source: ${filename}`)
      }
    }
  }
  const ownedByFile = new Map<string, JsonRecord>()
  for (const owned of ownedFiles) {
    const filename = relative(owned.path)
    if (filename === undefined) {
      errors.push("owned helper escaped the project")
      continue
    }
    ownedByFile.set(filename, owned)
    if (!changed.has(filename)) errors.push(`owned helper was not present: ${filename}`)
  }
  const permissionsByFile = new Map<string, JsonRecord[]>()
  for (const permission of permissions) {
    const filename = relative(permission.manifestPath)
    if (filename === undefined) {
      errors.push("permission manifest escaped the project")
      continue
    }
    const entries = permissionsByFile.get(filename) ?? []
    entries.push(permission)
    permissionsByFile.set(filename, entries)
    if (permission.addedBySession === true && !changed.has(filename)) {
      errors.push(`declared permission change was not present: ${filename}`)
    }
  }

  for (const filename of changed) {
    const file = input.files.get(filename)
    if (file === undefined || file.current === null) {
      errors.push(`changed file was unavailable or deleted: ${filename}`)
      continue
    }
    const owned = ownedByFile.get(filename)
    if (owned !== undefined) {
      if (!untracked.has(filename) || file.baseline !== null) {
        errors.push(`owned helper was not a newly-created untracked file: ${filename}`)
      }
      if (owned.sha256 !== sha256(file.current) || owned.bytes !== file.current.byteLength) {
        errors.push(`owned helper hash or size did not match: ${filename}`)
      }
      continue
    }
    if (untracked.has(filename) || file.baseline === null) {
      errors.push(`undeclared untracked file was present: ${filename}`)
      continue
    }

    let restored = file.current.toString("utf8")
    const fileProbes = probesByFile.get(filename) ?? []
    const filePermissions = permissionsByFile.get(filename) ?? []
    if (fileProbes.length === 0 && filePermissions.every((change) => change.addedBySession !== true)) {
      errors.push(`changed file was not declared instrumentation: ${filename}`)
      continue
    }
    const blocks = fileProbes
      .map((probe) => ({ probe, block: asString(probe.expectedBlock) }))
      .sort((left, right) => (right.block?.length ?? 0) - (left.block?.length ?? 0))
    for (const { probe, block } of blocks) {
      const expectedHash = asString(probe.expectedHash)
      const markerStart = asString(probe.markerStart)
      const markerEnd = asString(probe.markerEnd)
      if (
        block === undefined ||
        expectedHash === undefined ||
        markerStart === undefined ||
        markerEnd === undefined ||
        sha256(block) !== expectedHash ||
        occurrenceCount(restored, block) !== 1 ||
        occurrenceCount(restored, markerStart) !== 1 ||
        occurrenceCount(restored, markerEnd) !== 1
      ) {
        errors.push(`probe ownership block was incomplete or ambiguous: ${filename}`)
        continue
      }
      restored = restored.replace(block, "")
    }
    for (const permission of filePermissions) {
      const next = removeDeclaredPermission(restored, permission)
      if (next === undefined) errors.push(`permission change was incomplete or ambiguous: ${filename}`)
      else restored = next
    }
    if (!Buffer.from(restored, "utf8").equals(file.baseline)) {
      errors.push(`non-instrumentation edits remained after removing owned changes: ${filename}`)
    }
  }
  for (const filename of untracked) {
    if (!ownedByFile.has(filename)) errors.push(`undeclared untracked file was present: ${filename}`)
  }
  return { passed: errors.length === 0, errors: [...new Set(errors)] }
}

function toolOutputDiagnostics(tool: OrderedTool | undefined): { packageVersion?: string; promptSha256?: string } {
  const plugin = asRecord(parseToolEnvelope(tool).data?.plugin)
  const packageVersion = asString(plugin?.packageVersion)
  const promptSha256 = asString(plugin?.promptSha256)
  return {
    ...(packageVersion === undefined ? {} : { packageVersion }),
    ...(promptSha256 === undefined ? {} : { promptSha256 }),
  }
}

export function evaluateBehavioralAcceptance(snapshot: BehavioralSnapshot): AcceptanceResult {
  const checks: AcceptanceCheck[] = []
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail })
  const tools = snapshot.orderedTools
  const names = tools.map((tool) => tool.name)
  const findSuccessful = (
    name: string,
    after = -1,
    predicate: (tool: OrderedTool, data: JsonRecord | undefined) => boolean = () => true,
  ): number =>
    tools.findIndex((tool, index) => {
      const envelope = parseToolEnvelope(tool)
      return index > after && tool.name === name && envelope.ok && predicate(tool, envelope.data)
    })
  const sessionStartIndex = findSuccessful("debug_session_start")
  const firstMutationIndex = tools.findIndex(isExplicitMutation)
  let questionIndex = -1
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const candidate = tools[index]
    if (candidate?.name === "question" && candidate.status === "running") {
      questionIndex = index
      break
    }
  }
  if (questionIndex < 0) questionIndex = names.indexOf("question")
  const state = snapshot.plugin.state
  const manifest = snapshot.plugin.manifest
  const diagnostics = toolOutputDiagnostics(tools[sessionStartIndex])

  const registered = new Set(snapshot.fingerprint.registeredTools)
  const fingerprintPassed =
    snapshot.fingerprint.opencodeVersion === snapshot.fingerprint.expectedVersion &&
    snapshot.fingerprint.resolvedPluginUrls.includes(snapshot.fingerprint.pluginUrl) &&
    snapshot.fingerprint.resolvedAgentPromptSha256 === snapshot.fingerprint.promptSha256 &&
    REQUIRED_DEBUG_TOOLS.every((name) => registered.has(name)) &&
    diagnostics.packageVersion === snapshot.fingerprint.packageVersion &&
    diagnostics.promptSha256 === snapshot.fingerprint.promptSha256
  check(
    "fresh-plugin-fingerprint",
    fingerprintPassed,
    fingerprintPassed
      ? `OpenCode ${snapshot.fingerprint.opencodeVersion} loaded the local plugin and prompt fingerprint`
      : "OpenCode version, local plugin URL, prompt hash, registered tools, or session diagnostics did not match",
  )

  const debugAgentPermissionPassed =
    resolvedPermissionAction(snapshot.fingerprint, "bash") === "deny" &&
    resolvedPermissionAction(snapshot.fingerprint, "task") === "deny" &&
    resolvedPermissionAction(snapshot.fingerprint, "__unknown_acceptance_tool__") === "ask"
  check(
    "resolved-debug-agent-permission",
    debugAgentPermissionPassed,
    debugAgentPermissionPassed
      ? "Resolved debug agent denies bash/task and asks for unknown tools"
      : "Resolved debug-agent permission did not deny bash/task or default unknown tools to ask",
  )

  check(
    "session-start-before-mutation",
    sessionStartIndex >= 0 && (firstMutationIndex < 0 || sessionStartIndex < firstMutationIndex),
    `session_start=${sessionStartIndex}, first explicit mutation=${firstMutationIndex}`,
  )

  const firstInstrumentationIndex = tools.findIndex(
    (tool) => tool.name === "debug_collector_start" || tool.name === "debug_probe_prepare",
  )
  const firstInstrumentationMessageIndex =
    firstInstrumentationIndex < 0 ? Number.POSITIVE_INFINITY : (tools[firstInstrumentationIndex]?.messageIndex ?? -1)
  const hypothesisCheckpoints = tools
    .map((tool, index) => {
      const state = checkpointState(tool)
      return {
        tool,
        index,
        hypotheses: validHypothesisList(state?.hypotheses),
      }
    })
    .filter(
      ({ tool, index, hypotheses }) =>
        index > sessionStartIndex &&
        (firstMutationIndex < 0 || index < firstMutationIndex) &&
        tool.name === "debug_state_checkpoint" &&
        toolSucceeded(tool) &&
        hypotheses !== undefined,
    )
  const hypothesisCheckpoint = hypothesisCheckpoints.at(-1)
  const hypothesisCheckpointIndex = hypothesisCheckpoint?.index ?? -1
  const checkpointHypotheses = hypothesisCheckpoint?.hypotheses
  const persistedHypotheses = validHypothesisList(state?.hypotheses)
  const finalHypotheses = persistedHypotheses ?? (snapshot.plugin.found ? undefined : checkpointHypotheses)
  const persistedSlateConsistent = snapshot.plugin.found
    ? persistedHypotheses !== undefined &&
      checkpointHypotheses !== undefined &&
      sameHypotheses(checkpointHypotheses, persistedHypotheses)
    : checkpointHypotheses !== undefined
  check(
    "checkpointed-hypotheses",
    hypothesisCheckpointIndex > sessionStartIndex &&
      (firstMutationIndex < 0 || hypothesisCheckpointIndex < firstMutationIndex) &&
      persistedSlateConsistent,
    `checkpoint=${hypothesisCheckpointIndex}, hypotheses=${finalHypotheses?.length ?? 0}`,
  )

  const observedThreeSecondLimitIndex = tools.findIndex(
    (tool) =>
      toolReadsCustomFilterLoader(tool) &&
      typeof tool.output === "string" &&
      /DOWNLOAD_LIMIT_MS\s*=\s*3\s*\*\s*1_?000/iu.test(tool.output),
  )
  const observedThreeSecondLimit = observedThreeSecondLimitIndex >= 0
  const contradictedTenSecondClaim = /(?:\b10\s*(?:s|sec(?:ond)?s?)\b|10\s*\*\s*1_?000)/iu
  const correctThreeSecondClaim = /(?:\b3\s*(?:s|sec(?:ond)?s?)\b|3\s*\*\s*1_?000)/iu
  const earlierSlateClaimedTenSeconds =
    observedThreeSecondLimit &&
    hypothesisCheckpoints.some(({ index, hypotheses }) => {
      const loaderText = customFilterLoaderHypothesisText(hypotheses)
      return (
        index < observedThreeSecondLimitIndex &&
        contradictedTenSecondClaim.test(loaderText) &&
        !correctThreeSecondClaim.test(loaderText)
      )
    })
  const finalLoaderHypothesisText = customFilterLoaderHypothesisText(finalHypotheses)
  const assertsNamedDownloadLimit = /DOWNLOAD_LIMIT_MS/iu.test(finalLoaderHypothesisText)
  const retainsContradictedTenSecondLimit =
    observedThreeSecondLimit &&
    contradictedTenSecondClaim.test(finalLoaderHypothesisText) &&
    !correctThreeSecondClaim.test(finalLoaderHypothesisText)
  const correctedReceipt = asString(parseToolEnvelope(hypothesisCheckpoint?.tool).data?.visibilityReceiptMarkdown)
  const correctedReceiptVisible =
    correctedReceipt !== undefined &&
    snapshot.transcript.some(
      (entry) =>
        entry.role === "assistant" &&
        entry.messageIndex > (hypothesisCheckpoint?.tool.messageIndex ?? Number.POSITIVE_INFINITY) &&
        entry.messageIndex <= firstInstrumentationMessageIndex &&
        entry.text.some((text) => text.includes(correctedReceipt)),
    )
  const correctionHandshakeComplete =
    !earlierSlateClaimedTenSeconds ||
    (hypothesisCheckpointIndex > observedThreeSecondLimitIndex &&
      (firstInstrumentationIndex < 0 || hypothesisCheckpointIndex < firstInstrumentationIndex) &&
      correctedReceiptVisible)
  const hypothesisFactsReconciled =
    !retainsContradictedTenSecondLimit &&
    (!assertsNamedDownloadLimit || observedThreeSecondLimit) &&
    correctionHandshakeComplete
  check(
    "reconciled-hypothesis-facts",
    hypothesisFactsReconciled,
    hypothesisFactsReconciled
      ? "Literal constants asserted by the final hypothesis slate agree with the code read during discovery"
      : retainsContradictedTenSecondLimit
        ? "The final hypothesis slate retained a 10-second limit after discovery read the actual 3-second DOWNLOAD_LIMIT_MS"
        : !correctionHandshakeComplete
          ? "A disproved 10-second hypothesis was not checkpointed and shown again after reading the actual 3-second limit"
          : "The final hypothesis slate asserted DOWNLOAD_LIMIT_MS without reading its definition",
  )

  const visibleCounts = snapshot.transcript.flatMap((entry) =>
    entry.role === "assistant" && entry.messageIndex <= firstInstrumentationMessageIndex
      ? entry.text.map(visibleHypothesisCount).filter((count): count is number => count !== undefined)
      : [],
  )
  const visibleReceiptConsistent = !snapshot.plugin.found || typeof manifest?.visibleHypothesesAt === "string"
  const visibleBeforeInstrumentation =
    checkpointHypotheses !== undefined &&
    visibleReceiptConsistent &&
    visibleCounts.some((count) => count === checkpointHypotheses.length && count >= 2 && count <= 4)
  check(
    "visible-hypothesis-slate",
    visibleBeforeInstrumentation,
    visibleBeforeInstrumentation
      ? "A Working hypotheses update was visible before instrumentation"
      : "No visible Working hypotheses update preceded instrumentation",
  )

  const runStartIndex = findSuccessful(
    "debug_run_start",
    hypothesisCheckpointIndex,
    (tool, data) =>
      asString(toolInput(tool).label) === "pre-fix" &&
      asString(data?.label) === "pre-fix" &&
      typeof data?.runId === "string",
  )
  const runId = asString(parseToolEnvelope(tools[runStartIndex]).data?.runId)
  const collectorIndex = findSuccessful(
    "debug_collector_start",
    runStartIndex,
    (tool, data) =>
      typeof toolInput(tool).transportTargetPath === "string" &&
      data?.status === "ready" &&
      typeof data.collectorId === "string" &&
      typeof data.helperImport === "string" &&
      typeof data.helperPath === "string",
  )
  const collectorId = asString(parseToolEnvelope(tools[collectorIndex]).data?.collectorId)
  const runProbePreparations = tools.flatMap((tool, index) => {
    if (
      index <= runStartIndex ||
      tool.name !== "debug_probe_prepare" ||
      !toolSucceeded(tool) ||
      asString(toolInput(tool).runId) !== runId
    ) {
      return []
    }
    const data = parseToolEnvelope(tool).data
    const input = toolInput(tool)
    const sourceLine = data?.line
    return [
      {
        index,
        probeId: asString(data?.probeId),
        hypothesisId: asString(input.hypothesisId),
        source: asString(data?.source),
        sourceLine: typeof sourceLine === "number" ? sourceLine : undefined,
        sourceLineText: asString(data?.sourceLineText),
        transport: asString(input.transport),
        captures: asArray(input.captures),
        sampling: asRecord(input.sampling),
      },
    ]
  })
  const preparedProbeIds = runProbePreparations.flatMap(({ probeId }) => (probeId === undefined ? [] : [probeId]))
  const preparedProbeIdSet = new Set(preparedProbeIds)
  const preparationsWellFormed =
    runProbePreparations.length > 0 &&
    preparedProbeIds.length === runProbePreparations.length &&
    preparedProbeIdSet.size === preparedProbeIds.length &&
    runProbePreparations.every(
      ({ index, hypothesisId }) =>
        index > collectorIndex &&
        hypothesisId !== undefined &&
        finalHypotheses?.some((hypothesis) => hypothesis.id === hypothesisId) === true,
    )
  const manifestRunProbes = asArray(manifest?.probes)
    .map(asRecord)
    .filter((probe): probe is JsonRecord => probe !== undefined && probe.runId === runId)
  const manifestRunProbeIds = manifestRunProbes.flatMap((probe) => {
    const id = asString(probe.id)
    return id === undefined ? [] : [id]
  })
  const manifestRunProbeIdSet = new Set(manifestRunProbeIds)
  const preparedManifestSetMatches =
    manifestRunProbeIds.length === manifestRunProbes.length &&
    manifestRunProbeIdSet.size === manifestRunProbeIds.length &&
    preparedProbeIdSet.size === manifestRunProbeIdSet.size &&
    [...preparedProbeIdSet].every((probeId) => manifestRunProbeIdSet.has(probeId))
  const activeManifestProbes = manifestRunProbes.filter((probe) => probe.status !== "removed")
  const activeManifestProbeIds = activeManifestProbes.flatMap((probe) => {
    const id = asString(probe.id)
    return id === undefined ? [] : [id]
  })
  const activeManifestProbeIdSet = new Set(activeManifestProbeIds)
  const activePreparations = runProbePreparations.filter(
    ({ probeId }) => probeId !== undefined && activeManifestProbeIdSet.has(probeId),
  )
  const diagnosticBeforeAfterPair = activePreparations.some((upstream) => {
    if (
      upstream.transport === "process" ||
      upstream.source === undefined ||
      upstream.sourceLine === undefined ||
      upstream.sourceLineText === undefined ||
      !/\bawait\s+(?:[A-Za-z_$]|\(|\{|\[)|\bPromise\.race\s*\(/u.test(upstream.sourceLineText) ||
      upstream.captures.length !== 0 ||
      upstream.sampling?.mode !== "every" ||
      upstream.sampling.n !== 1
    ) {
      return false
    }
    const upstreamSourceLine = upstream.sourceLine
    return activePreparations.some(
      (downstream) =>
        downstream.probeId !== upstream.probeId &&
        downstream.transport !== "process" &&
        downstream.source === upstream.source &&
        downstream.sourceLine !== undefined &&
        downstream.sourceLine > upstreamSourceLine &&
        downstream.sourceLine <= upstreamSourceLine + 12 &&
        downstream.captures.length > 0,
    )
  })
  check(
    "diagnostic-before-after-pair",
    diagnosticBeforeAfterPair,
    diagnosticBeforeAfterPair
      ? "A capture-free probe precedes a may-fail await and a discriminating probe observes its continuation"
      : "Prepare a non-process capture-free every/1 probe before a may-fail await and a nearby captured continuation probe in the same source",
  )
  const registrationIndexes = new Map<string, number>()
  let everyProbeMutatedAndRegistered = activePreparations.length === activeManifestProbes.length
  for (const preparation of activePreparations) {
    const probeId = preparation.probeId
    if (probeId === undefined) {
      everyProbeMutatedAndRegistered = false
      continue
    }
    const registerIndex = findSuccessful("debug_probe_register", preparation.index, (tool, data) => {
      return (
        asString(toolInput(tool).probeId) === probeId &&
        asString(data?.probeId) === probeId &&
        data?.status === "registered" &&
        data.validationStatus === "pending"
      )
    })
    const hadOwnedMutation = tools.some(
      (tool, index) => index > preparation.index && index < registerIndex && isExplicitMutation(tool),
    )
    if (registerIndex < 0 || !hadOwnedMutation) everyProbeMutatedAndRegistered = false
    else registrationIndexes.set(probeId, registerIndex)
  }
  const instrumentationCaptures = tools.flatMap((tool, index) => {
    const input = toolInput(tool)
    const data = parseToolEnvelope(tool).data
    if (
      tool.name !== "debug_process_capture" ||
      !toolSucceeded(tool) ||
      input.purpose !== "instrumentation-check" ||
      input.runId !== runId ||
      data?.runId !== runId ||
      typeof data?.processId !== "string" ||
      data.exitCode !== 0
    ) {
      return []
    }
    const rawProbeIds = asArray(input.probeIds)
    const probeIds = rawProbeIds.flatMap((value) => (typeof value === "string" ? [value] : []))
    if (probeIds.length !== rawProbeIds.length || new Set(probeIds).size !== probeIds.length) return []
    return [{ index, probeIds }]
  })
  const capturesOnlyActiveProbes = instrumentationCaptures.every(({ probeIds }) =>
    probeIds.every((probeId) => activeManifestProbeIdSet.has(probeId)),
  )
  const everyProbeCapturedAfterRegistration = activeManifestProbeIds.every((probeId) => {
    const registerIndex = registrationIndexes.get(probeId)
    return (
      registerIndex !== undefined &&
      instrumentationCaptures.some(({ index, probeIds }) => index > registerIndex && probeIds.includes(probeId))
    )
  })
  const lastProcessCaptureIndex = Math.max(-1, ...instrumentationCaptures.map(({ index }) => index))
  const waitingCheckpointIndex = tools.findIndex((tool, index) => {
    const state = checkpointState(tool)
    const checkpointHypotheses = validHypothesisList(state?.hypotheses)
    return (
      index > lastProcessCaptureIndex &&
      (questionIndex < 0 || index < questionIndex) &&
      tool.name === "debug_state_checkpoint" &&
      toolSucceeded(tool) &&
      state?.phase === "waiting_for_reproduction" &&
      checkpointHypotheses !== undefined &&
      finalHypotheses !== undefined &&
      sameHypotheses(checkpointHypotheses, finalHypotheses)
    )
  })
  const manifestRun = asArray(manifest?.runs)
    .map(asRecord)
    .find((run) => run?.id === runId)
  const manifestCollector = asRecord(manifest?.collector)
  const manifestCollectorReady = manifestCollector?.id === collectorId && manifestCollector?.status === "ready"
  const stateRun = asArray(state?.runs)
    .map(asRecord)
    .find((run) => run?.id === runId)
  const activeStateProbes = asArray(state?.probeRefs)
    .map(asRecord)
    .filter((probe): probe is JsonRecord => probe !== undefined && probe.runId === runId && probe.status !== "removed")
  const activeStateProbeIds = activeStateProbes.flatMap((probe) => {
    const id = asString(probe.id)
    return id === undefined ? [] : [id]
  })
  const activeStateProbeIdSet = new Set(activeStateProbeIds)
  const everyManifestProbeValidated =
    activeManifestProbes.length > 0 &&
    activeManifestProbeIds.length === activeManifestProbes.length &&
    activeManifestProbeIdSet.size === activeManifestProbeIds.length &&
    activeManifestProbes.every((probe) => {
      const id = asString(probe.id)
      const hypothesisId = asString(probe.hypothesisId)
      const preparation = runProbePreparations.find((candidate) => candidate.probeId === id)
      const helperOwnershipComplete =
        probe.transport === "process" ||
        (typeof probe.helperSourceFile === "string" &&
          typeof probe.helperImportBlock === "string" &&
          typeof probe.helperImportHash === "string")
      return (
        id !== undefined &&
        hypothesisId !== undefined &&
        preparation?.hypothesisId === hypothesisId &&
        helperOwnershipComplete &&
        probe.validationStatus === "validated" &&
        ["validated", "active"].includes(String(probe.status))
      )
    })
  const hasValidatedBrowserProbe = activeManifestProbes.some(
    (probe) =>
      probe.transport !== "process" &&
      probe.validationStatus === "validated" &&
      ["validated", "active"].includes(String(probe.status)),
  )
  const stateProbeSetMatches =
    activeStateProbeIds.length === activeStateProbes.length &&
    activeStateProbeIdSet.size === activeStateProbeIds.length &&
    activeStateProbeIdSet.size === activeManifestProbeIdSet.size &&
    [...activeManifestProbeIdSet].every((probeId) => activeStateProbeIdSet.has(probeId)) &&
    activeStateProbes.every((probe) => {
      const manifestProbe = activeManifestProbes.find((candidate) => candidate.id === probe.id)
      return (
        manifestProbe?.hypothesisId === probe.hypothesisId && ["validated", "active"].includes(String(probe.status))
      )
    })
  const lifecyclePrepared =
    runStartIndex > hypothesisCheckpointIndex &&
    collectorIndex > runStartIndex &&
    preparationsWellFormed &&
    preparedManifestSetMatches &&
    everyProbeMutatedAndRegistered &&
    instrumentationCaptures.length > 0 &&
    capturesOnlyActiveProbes &&
    everyProbeCapturedAfterRegistration &&
    waitingCheckpointIndex > lastProcessCaptureIndex &&
    questionIndex > waitingCheckpointIndex &&
    manifestCollectorReady &&
    manifestRun?.label === "pre-fix" &&
    manifestRun?.status === "waiting" &&
    everyManifestProbeValidated &&
    hasValidatedBrowserProbe &&
    stateRun?.label === "pre-fix" &&
    stateRun?.status === "waiting" &&
    stateProbeSetMatches
  check(
    "prepared-pre-fix-runtime-run",
    lifecyclePrepared,
    lifecyclePrepared
      ? `A validated collector and all ${activeManifestProbes.length} active probes are waiting in the pre-fix run`
      : `The pre-fix run completeness check failed for ${runProbePreparations.length} prepared and ${activeManifestProbes.length} active probes`,
  )

  const questionTool = tools[questionIndex]
  const questionInput = asRecord(questionTool?.input)
  const questionReceipt = asArray(manifest?.humanCheckpoints)
    .map(asRecord)
    .find(
      (checkpoint): checkpoint is JsonRecord =>
        checkpoint !== undefined &&
        checkpoint.runId === runId &&
        checkpoint.purpose === "reproduction" &&
        checkpoint.status === "asked",
    )
  const preparedProcedure = asString(manifestRun?.reproduction)
  const selfContainedMv3Procedure = containsSelfContainedMv3Activation(preparedProcedure)
  check(
    "self-contained-mv3-reproduction",
    selfContainedMv3Procedure,
    selfContainedMv3Procedure
      ? "The prepared reproduction builds and reloads the instrumented MV3 artifact before the original steps"
      : "The prepared reproduction must run pnpm dev chrome-mv3, reload build/dev/chrome-mv3, then preserve the original steps",
  )
  const questionMatchesTool =
    questionTool?.status === "running" &&
    jsonEquivalent(
      normalizeQuestionForMatching(questionInput)?.questions,
      normalizeQuestionForMatching(snapshot.question)?.questions,
    )
  check(
    "reproduction-question",
    snapshot.stopReason === "question" &&
      strictReproductionQuestion(snapshot.question) &&
      !questionOffersSpeculativeChoice(snapshot.question) &&
      questionContainsProcedure(snapshot.question, preparedProcedure) &&
      questionMatchesTool &&
      questionReceipt !== undefined,
    snapshot.stopReason === "question"
      ? "Question must cover the prepared procedure and offer Reproduced, Did not reproduce, and Could not complete without fix choices"
      : `Stopped because ${snapshot.stopReason}, not a reproduction Question`,
  )

  const manifestWaiting = manifest?.waitingForReproduction === true
  const stateWaiting = state?.phase === "waiting_for_reproduction"
  const pendingQuestion =
    snapshot.pendingQuestions.length === 1 &&
    asRecord(snapshot.pendingQuestions[0])?.id === snapshot.question?.id &&
    jsonEquivalent(asRecord(snapshot.pendingQuestions[0])?.questions, snapshot.question?.questions)
  check(
    "durable-waiting-state",
    manifestWaiting && stateWaiting && pendingQuestion,
    `manifest waiting=${manifestWaiting}, phase=${String(state?.phase)}, pending question=${pendingQuestion}`,
  )

  const exactInstrumentation = snapshot.repository.exactInstrumentation
  check(
    "only-owned-instrumentation-diff",
    exactInstrumentation?.passed === true,
    exactInstrumentation?.passed === true
      ? "Every changed byte was an exact declared marker block, permission, or hash-owned helper"
      : (exactInstrumentation?.errors.join("; ") ?? "exact instrumentation validation was not captured"),
  )

  const semanticProbeBoundaries = snapshot.repository.semanticProbeBoundaries
  check(
    "semantically-safe-probe-boundaries",
    semanticProbeBoundaries?.passed === true,
    semanticProbeBoundaries?.passed === true
      ? "Every active probe was inserted at an executable AST statement boundary after its captures initialized"
      : (semanticProbeBoundaries?.errors.join("; ") ?? "semantic probe-boundary validation was not captured"),
  )

  const mutationsAfterQuestion = questionIndex < 0 ? [] : tools.slice(questionIndex + 1).filter(isExplicitMutation)
  const noFixState =
    stringList(state?.fixedFiles).length === 0 &&
    !["fixing", "verifying", "cleaning", "completed"].includes(String(state?.phase))
  const noCleanup = !names.includes("debug_cleanup")
  check(
    "no-silent-finalization",
    questionIndex >= 0 && mutationsAfterQuestion.length === 0 && noFixState && noCleanup,
    `question=${questionIndex}, later mutations=${mutationsAfterQuestion.length}, phase=${String(state?.phase)}, cleanup=${!noCleanup}`,
  )

  const cleanupPassed =
    snapshot.postCleanup.remainingPluginSessionDirectories.length === 0 &&
    snapshot.postCleanup.repository.changedFiles.length === 0
  check(
    "session-deletion-cleans",
    cleanupPassed,
    `remaining sessions=${snapshot.postCleanup.remainingPluginSessionDirectories.length}, changed files=${snapshot.postCleanup.repository.changedFiles.length}`,
  )

  return { passed: checks.every((item) => item.passed), checks }
}

function hasDiagnosticProbeEvidence(tool: OrderedTool, probeId: string): boolean {
  return asArray(parseToolEnvelope(tool).data?.events).some((value) => {
    const event = asRecord(value)
    if (event?.probeId !== probeId) return false
    return /(?:ENOENT|team\/acme\.json|team%2Facme)/u.test(JSON.stringify(event.data ?? null))
  })
}

function processInvocation(tool: OrderedTool | undefined): JsonRecord {
  const input = toolInput(tool ?? ({ input: {} } as OrderedTool))
  return {
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
  }
}

export function evaluateSyntheticCliAcceptance(snapshot: BehavioralSnapshot): AcceptanceResult {
  const checks: AcceptanceCheck[] = []
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail })
  const tools = snapshot.orderedTools
  const findSuccessful = (
    name: string,
    after = -1,
    predicate: (tool: OrderedTool, data: JsonRecord | undefined) => boolean = () => true,
  ): number =>
    tools.findIndex((tool, index) => {
      const envelope = parseToolEnvelope(tool)
      return index > after && tool.name === name && envelope.ok && predicate(tool, envelope.data)
    })

  const sessionStartIndex = findSuccessful("debug_session_start")
  const diagnostics = toolOutputDiagnostics(tools[sessionStartIndex])
  const fingerprintPassed =
    snapshot.fingerprint.profileId === "synthetic-cli" &&
    snapshot.fingerprint.model === DEFAULT_MODEL &&
    snapshot.fingerprint.variant === DEFAULT_VARIANT &&
    snapshot.fingerprint.sourceRevision.startsWith("fixture-tree:") &&
    snapshot.fingerprint.opencodeVersion === snapshot.fingerprint.expectedVersion &&
    snapshot.fingerprint.resolvedPluginUrls.includes(snapshot.fingerprint.pluginUrl) &&
    snapshot.fingerprint.resolvedAgentPromptSha256 === snapshot.fingerprint.promptSha256 &&
    REQUIRED_DEBUG_TOOLS.every((name) => snapshot.fingerprint.registeredTools.includes(name)) &&
    diagnostics.packageVersion === snapshot.fingerprint.packageVersion &&
    diagnostics.promptSha256 === snapshot.fingerprint.promptSha256
  check(
    "synthetic-fingerprint",
    fingerprintPassed,
    fingerprintPassed
      ? `${snapshot.fingerprint.model}/${snapshot.fingerprint.variant} ran fixture ${snapshot.fingerprint.sourceRevision}`
      : "Profile, DeepSeek Flash model, fixture revision, local plugin, prompt, or tool fingerprint did not match",
  )

  const permissionsPassed =
    resolvedPermissionAction(snapshot.fingerprint, "bash") === "deny" &&
    resolvedPermissionAction(snapshot.fingerprint, "task") === "deny" &&
    resolvedPermissionAction(snapshot.fingerprint, "__unknown_acceptance_tool__") === "ask"
  check(
    "synthetic-agent-permissions",
    permissionsPassed,
    permissionsPassed
      ? "Resolved debug-agent permissions preserve the isolated tool boundary"
      : "Unexpected permissions",
  )

  const firstMutationIndex = tools.findIndex(isExplicitMutation)
  check(
    "synthetic-session-first",
    sessionStartIndex >= 0 && (firstMutationIndex < 0 || sessionStartIndex < firstMutationIndex),
    `session_start=${sessionStartIndex}, first mutation=${firstMutationIndex}`,
  )

  const protocolErrors = tools.flatMap((tool) => {
    const signature = protocolErrorSignature(tool)
    return signature === undefined ? [] : [signature]
  })
  const protocolErrorCounts = new Map<string, number>()
  for (const signature of protocolErrors) {
    protocolErrorCounts.set(signature, (protocolErrorCounts.get(signature) ?? 0) + 1)
  }
  const maxRepeatedProtocolError = Math.max(0, ...protocolErrorCounts.values())
  const noProtocolLoop = protocolErrors.length <= 10 && maxRepeatedProtocolError <= 2
  check(
    "synthetic-no-protocol-loop",
    noProtocolLoop,
    `protocol errors=${protocolErrors.length}, maximum repeated error=${maxRepeatedProtocolError}`,
  )

  const firstProbeIndex = tools.findIndex((tool) => tool.name === "debug_probe_prepare" && toolSucceeded(tool))
  let selectedHypotheses: JsonRecord[] | undefined
  const hypothesisCheckpointIndex = tools.reduce((selected, tool, index) => {
    const state = checkpointState(tool)
    const hypotheses = validHypothesisList(state?.hypotheses)
    const qualifies =
      index > sessionStartIndex &&
      (firstProbeIndex < 0 || index < firstProbeIndex) &&
      tool.name === "debug_state_checkpoint" &&
      toolSucceeded(tool) &&
      hypotheses !== undefined
    if (!qualifies || hypotheses === undefined) return selected
    if (selectedHypotheses !== undefined && sameHypotheses(selectedHypotheses, hypotheses)) return selected
    selectedHypotheses = hypotheses
    return index
  }, -1)
  const hypothesisState = checkpointState(tools[hypothesisCheckpointIndex] ?? ({ input: {} } as OrderedTool))
  const checkpointHypotheses = validHypothesisList(hypothesisState?.hypotheses)
  const firstProbeMessage =
    firstProbeIndex < 0 ? Number.POSITIVE_INFINITY : (tools[firstProbeIndex]?.messageIndex ?? -1)
  const checkpointMessage = tools[hypothesisCheckpointIndex]?.messageIndex ?? -1
  const visibleSlate = snapshot.transcript.some(
    (entry) =>
      entry.role === "assistant" &&
      entry.messageIndex >= checkpointMessage &&
      entry.messageIndex <= firstProbeMessage &&
      entry.text.some((value) => visibleHypothesisCount(value) === checkpointHypotheses?.length),
  )
  check(
    "synthetic-visible-hypotheses",
    checkpointHypotheses !== undefined && visibleSlate,
    `checkpoint=${hypothesisCheckpointIndex}, visible=${visibleSlate}, hypotheses=${checkpointHypotheses?.length ?? 0}`,
  )

  const preStartIndex = findSuccessful(
    "debug_run_start",
    hypothesisCheckpointIndex,
    (tool, data) =>
      asString(toolInput(tool).label) === "pre-fix" &&
      asString(data?.label) === "pre-fix" &&
      typeof data?.runId === "string",
  )
  const preRunId = asString(parseToolEnvelope(tools[preStartIndex]).data?.runId)
  const preparations = tools.flatMap((tool, index) => {
    const input = toolInput(tool)
    const data = parseToolEnvelope(tool).data
    if (
      index <= preStartIndex ||
      tool.name !== "debug_probe_prepare" ||
      !toolSucceeded(tool) ||
      asString(input.runId) !== preRunId ||
      asString(input.transport) !== "process"
    ) {
      return []
    }
    return [
      {
        index,
        id: asString(data?.probeId),
        source: asString(data?.source),
        line: typeof data?.line === "number" ? data.line : undefined,
        sourceLineText: asString(data?.sourceLineText),
        captures: asArray(input.captures),
      },
    ]
  })
  const registeredIds = new Set(
    tools.flatMap((tool) =>
      tool.name === "debug_probe_register" && toolSucceeded(tool)
        ? [asString(parseToolEnvelope(tool).data?.probeId)].filter((value): value is string => value !== undefined)
        : [],
    ),
  )
  const probeLifecycles = preparations
    .filter(
      (item) =>
        item.id !== undefined &&
        item.source === "src/feature-flags.mjs" &&
        item.line !== undefined &&
        item.captures.length > 0 &&
        registeredIds.has(item.id),
    )
    .map((probe) => {
      const probeId = probe.id as string
      const instrumentationIndex = findSuccessful(
        "debug_process_capture",
        probe.index,
        (tool, data) =>
          toolInput(tool).purpose === "instrumentation-check" &&
          toolInput(tool).runId === preRunId &&
          data?.exitCode === 0 &&
          asArray(data.validatedProbeIds).includes(probeId),
      )
      const reproductionIndex = findSuccessful(
        "debug_process_capture",
        instrumentationIndex,
        (tool, data) =>
          toolInput(tool).purpose === "reproduction" &&
          toolInput(tool).runId === preRunId &&
          data?.issueReproduced === true &&
          data?.exitCode === 1 &&
          typeof data?.probeEvents === "number" &&
          data.probeEvents > 0 &&
          asArray(data.probeIds).includes(probeId),
      )
      const evidenceReadIndex = findSuccessful("debug_evidence_read", reproductionIndex, (tool) =>
        hasDiagnosticProbeEvidence(tool, probeId),
      )
      return { probe, instrumentationIndex, reproductionIndex, evidenceReadIndex }
    })
  const lifecycle = probeLifecycles.find(
    (candidate) =>
      candidate.instrumentationIndex > candidate.probe.index &&
      candidate.reproductionIndex > candidate.instrumentationIndex &&
      candidate.evidenceReadIndex > candidate.reproductionIndex,
  )
  const runtimeProbe = lifecycle?.probe
  const runtimeProbeRegistered = runtimeProbe !== undefined
  check(
    "synthetic-runtime-probe",
    runtimeProbeRegistered,
    runtimeProbeRegistered
      ? `Prepared and registered a process probe at the failing readFile boundary on line ${runtimeProbe.line}`
      : "Missing a registered process probe at the failing readFile boundary",
  )

  const instrumentationIndex = lifecycle?.instrumentationIndex ?? -1
  const reproductionIndex = lifecycle?.reproductionIndex ?? -1
  const preFinishIndex = findSuccessful(
    "debug_run_finish",
    reproductionIndex,
    (tool, data) =>
      toolInput(tool).runId === preRunId && toolInput(tool).issueReproduced === true && data?.issueReproduced === true,
  )
  const evidenceReadIndex = lifecycle?.evidenceReadIndex ?? -1
  const baselinePassed =
    preStartIndex >= 0 &&
    instrumentationIndex > preStartIndex &&
    reproductionIndex > instrumentationIndex &&
    preFinishIndex > reproductionIndex &&
    evidenceReadIndex > reproductionIndex
  check(
    "synthetic-reproduced-with-evidence",
    baselinePassed,
    `pre-start=${preStartIndex}, instrumentation=${instrumentationIndex}, reproduction=${reproductionIndex}, evidence=${evidenceReadIndex}, finish=${preFinishIndex}`,
  )

  const baselineCompleteIndex = Math.max(preFinishIndex, evidenceReadIndex)
  const fixingCheckpointIndex = tools.findIndex((tool, index) => {
    if (index <= baselineCompleteIndex || tool.name !== "debug_state_checkpoint" || !toolSucceeded(tool)) return false
    const state = checkpointState(tool)
    return (
      state?.phase === "fixing" &&
      stringList(state.decidingEvidenceIds).length > 0 &&
      stringList(state.fixedFiles).includes("src/feature-flags.mjs")
    )
  })
  const fixMutationIndex = tools.findIndex((tool, index) => index > fixingCheckpointIndex && isAppliedMutation(tool))
  const evidenceDecisionVisible = snapshot.transcript.some(
    (entry) =>
      entry.role === "assistant" &&
      entry.messageIndex > (tools[evidenceReadIndex]?.messageIndex ?? Number.POSITIVE_INFINITY) &&
      entry.messageIndex <= (tools[fixMutationIndex]?.messageIndex ?? -1) &&
      entry.text.some(
        (value) =>
          /(?:evidence|probe)/iu.test(value) &&
          /(?:confirm|root cause)/iu.test(value) &&
          /(?:\bevent_[A-Za-z0-9_-]+|\bH\d+\b|hypothesis|ENOENT|team\/acme\.json|encodeURI)/iu.test(value),
      ),
  )
  check(
    "synthetic-evidence-backed-fix",
    fixingCheckpointIndex > baselineCompleteIndex &&
      fixMutationIndex > fixingCheckpointIndex &&
      evidenceDecisionVisible,
    `fixing checkpoint=${fixingCheckpointIndex}, fix mutation=${fixMutationIndex}, visible decision=${evidenceDecisionVisible}`,
  )

  const postStartIndex = findSuccessful(
    "debug_run_start",
    fixMutationIndex,
    (tool, data) =>
      asString(toolInput(tool).label) === "post-fix" &&
      asString(data?.label) === "post-fix" &&
      typeof data?.runId === "string",
  )
  const postRunId = asString(parseToolEnvelope(tools[postStartIndex]).data?.runId)
  const verificationIndex = findSuccessful(
    "debug_process_capture",
    postStartIndex,
    (tool, data) =>
      toolInput(tool).purpose === "verification" &&
      toolInput(tool).runId === postRunId &&
      data?.issueReproduced === false &&
      data?.exitCode === 0,
  )
  const sameProcessPath = jsonEquivalent(
    processInvocation(tools[reproductionIndex]),
    processInvocation(tools[verificationIndex]),
  )
  const postFinishIndex = findSuccessful(
    "debug_run_finish",
    verificationIndex,
    (tool, data) =>
      toolInput(tool).runId === postRunId &&
      toolInput(tool).issueReproduced === false &&
      data?.issueReproduced === false,
  )
  check(
    "synthetic-same-path-verification",
    postStartIndex > fixMutationIndex &&
      verificationIndex > postStartIndex &&
      sameProcessPath &&
      postFinishIndex > verificationIndex,
    `post-start=${postStartIndex}, verification=${verificationIndex}, same process=${sameProcessPath}, finish=${postFinishIndex}`,
  )

  const cleanupIndex = findSuccessful("debug_cleanup", postFinishIndex, (_tool, data) => data?.status === "complete")
  const noQuestion = snapshot.question === undefined && snapshot.pendingQuestions.length === 0
  check(
    "synthetic-autonomous-completion",
    snapshot.stopReason === "idle" && noQuestion && cleanupIndex > postFinishIndex,
    `stop=${snapshot.stopReason}, pending questions=${snapshot.pendingQuestions.length}, cleanup=${cleanupIndex}`,
  )

  const expectedFile = "src/feature-flags.mjs"
  const patch = snapshot.repository.patch
  const exactBehaviorDiff =
    snapshot.repository.changedFiles.length === 1 &&
    snapshot.repository.changedFiles[0] === expectedFile &&
    snapshot.repository.untrackedFiles.length === 0 &&
    /^-\s*const fileName = `\$\{encodeURI\(accountId\)\}\.json`$/mu.test(patch) &&
    /^\+\s*const fileName = `\$\{encodeURIComponent\(accountId\)\}\.json`$/mu.test(patch) &&
    !/opencode[-_ ]debug|__opencodeDebugEmit/iu.test(patch)
  check(
    "synthetic-minimal-fix",
    exactBehaviorDiff,
    exactBehaviorDiff
      ? "Only encodeURI was replaced with encodeURIComponent"
      : `changed=${snapshot.repository.changedFiles.join(",")}`,
  )

  const cleanupPassed =
    snapshot.postCleanup.remainingPluginSessionDirectories.length === 0 &&
    snapshot.postCleanup.repository.changedFiles.length === 1 &&
    snapshot.postCleanup.repository.changedFiles[0] === expectedFile &&
    snapshot.postCleanup.repository.patch === snapshot.repository.patch &&
    snapshot.postCleanup.repository.untrackedFiles.length === 0
  check(
    "synthetic-cleanup-preserves-only-fix",
    cleanupPassed,
    `remaining sessions=${snapshot.postCleanup.remainingPluginSessionDirectories.length}, changed=${snapshot.postCleanup.repository.changedFiles.join(",")}`,
  )

  return { passed: checks.every((item) => item.passed), checks }
}

export function evaluateAcceptance(snapshot: BehavioralSnapshot): AcceptanceResult {
  return snapshot.fingerprint.profileId === "synthetic-cli"
    ? evaluateSyntheticCliAcceptance(snapshot)
    : evaluateBehavioralAcceptance(snapshot)
}

function unwrapSdkResponse<T>(value: unknown, operation: string): T {
  const record = asRecord(value)
  if (record === undefined || !("data" in record)) return value as T
  if (record.error !== undefined)
    throw new Error(`${operation} failed: ${JSON.stringify(sanitizeForReport(record.error))}`)
  return record.data as T
}

export async function withAbortControllerDeadline<T>(
  operation: string,
  timeoutMs: number,
  controller: AbortController,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`${operation} exceeded its ${timeoutMs}ms deadline`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([invoke(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function withSdkDeadline<T>(
  operation: string,
  timeoutMs: number,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withAbortControllerDeadline(operation, timeoutMs, new AbortController(), invoke)
}

async function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

type OpenCodeClient = ReturnType<typeof createOpencodeClient>

async function abortOpenCodeSession(client: OpenCodeClient, sessionId: string, repository: string): Promise<void> {
  const response = await withSdkDeadline("session.abort", SDK_CLEANUP_TIMEOUT_MS, (signal) =>
    client.session.abort({ sessionID: sessionId, directory: repository }, { signal }),
  )
  unwrapSdkResponse<void>(response, "session.abort")
}

async function deleteOpenCodeSession(client: OpenCodeClient, sessionId: string, repository: string): Promise<void> {
  const response = await withSdkDeadline("session.delete", SDK_CLEANUP_TIMEOUT_MS, (signal) =>
    client.session.delete({ sessionID: sessionId, directory: repository }, { signal }),
  )
  unwrapSdkResponse<void>(response, "session.delete")
}

async function runGit(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<string> {
  const result = await executeFile("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_CAPTURE_BYTES,
    env: environment,
  })
  return result.stdout
}

async function materializeAcceptanceRepository(
  options: HarnessOptions,
  repository: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const source = await realpath(options.source)
  if (!(await stat(source)).isDirectory()) throw new Error(`Acceptance source is not a directory: ${options.source}`)

  if (options.profile === "synthetic-cli") {
    await cp(source, repository, { recursive: true })
    await runGit(repository, ["init", "--initial-branch=master"], environment)
    await runGit(repository, ["config", "user.name", "OpenCode Acceptance"], environment)
    await runGit(repository, ["config", "user.email", "acceptance@localhost"], environment)
    await runGit(repository, ["config", "commit.gpgsign", "false"], environment)
    await runGit(repository, ["add", "--all"], environment)
    await runGit(repository, ["commit", "-m", "Synthetic debugging baseline"], environment)
    return `fixture-tree:${(await runGit(repository, ["rev-parse", "HEAD^{tree}"], environment)).trim()}`
  }

  await executeFile("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", source, repository], {
    env: environment,
    timeout: 300_000,
    maxBuffer: MAX_CAPTURE_BYTES,
  })
  await runGit(repository, ["checkout", "--detach", options.commit], environment, 300_000)
  await runGit(repository, ["remote", "remove", "origin"], environment)
  return (await runGit(repository, ["rev-parse", "HEAD"], environment)).trim()
}

export async function captureRepository(
  repository: string,
  environment: NodeJS.ProcessEnv,
  manifest?: JsonRecord,
): Promise<RepositoryCapture> {
  const canonicalRepository = await realpath(repository)
  const [statusText, patchText, namesText, untrackedText] = await Promise.all([
    runGit(repository, ["status", "--short", "--untracked-files=all"], environment),
    runGit(
      repository,
      ["diff", "HEAD", "--no-renames", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"],
      environment,
    ),
    runGit(repository, ["diff", "HEAD", "--no-renames", "--name-only", "-z"], environment),
    runGit(repository, ["ls-files", "--others", "--exclude-standard", "-z"], environment),
  ])
  const untrackedFiles = untrackedText.split("\0").filter(Boolean).map(normalizePath)
  const changedFiles = new Set(namesText.split("\0").filter(Boolean).map(normalizePath))
  for (const filename of untrackedFiles) changedFiles.add(filename)
  const capture: RepositoryCapture = {
    root: canonicalRepository,
    status: redactText(statusText),
    patch: redactText(patchText),
    changedFiles: [...changedFiles].sort(),
    untrackedFiles: untrackedFiles.sort(),
  }
  if (manifest !== undefined) {
    const files = new Map<string, InstrumentationFileSnapshot>()
    const untracked = new Set(capture.untrackedFiles)
    const snapshotFiles = new Set(capture.changedFiles)
    for (const probe of asArray(manifest.probes).map(asRecord)) {
      if (probe === undefined) continue
      const source = asString(probe.sourceFile)
      const helperSource = asString(probe.helperSourceFile)
      const sourceFile = source === undefined ? undefined : relativeProjectPath(canonicalRepository, source)
      const helperSourceFile =
        helperSource === undefined ? undefined : relativeProjectPath(canonicalRepository, helperSource)
      if (sourceFile !== undefined) snapshotFiles.add(sourceFile)
      if (helperSourceFile !== undefined) snapshotFiles.add(helperSourceFile)
    }
    for (const filename of snapshotFiles) {
      const current = await readFile(path.join(repository, filename)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      })
      const baseline = untracked.has(filename)
        ? null
        : Buffer.from(await runGit(repository, ["show", `HEAD:${filename}`], environment))
      files.set(filename, { baseline, current })
    }
    capture.exactInstrumentation = validateExactInstrumentationChanges({
      projectRoot: canonicalRepository,
      changedFiles: capture.changedFiles,
      untrackedFiles: capture.untrackedFiles,
      files,
      manifest,
    })
    capture.semanticProbeBoundaries = validateSemanticProbeBoundaries({
      projectRoot: canonicalRepository,
      files,
      manifest,
    })
  }
  return capture
}

async function readBounded(filename: string): Promise<string> {
  const info = await stat(filename)
  if (info.size > MAX_CAPTURE_BYTES) throw new Error(`${filename} exceeds the ${MAX_CAPTURE_BYTES}-byte capture limit`)
  return readFile(filename, "utf8")
}

async function readTailBounded(filename: string): Promise<string> {
  const info = await stat(filename)
  const bytes = Math.min(info.size, MAX_CAPTURE_BYTES)
  const buffer = Buffer.alloc(bytes)
  const handle = await open(filename, "r")
  try {
    await handle.read(buffer, 0, bytes, Math.max(0, info.size - bytes))
  } finally {
    await handle.close()
  }
  return `${info.size > bytes ? `[TRUNCATED TO LAST ${bytes} BYTES]\n` : ""}${buffer.toString("utf8")}`
}

async function capturePlugin(tempDirectory: string, repository: string): Promise<PluginCapture> {
  const base = path.join(tempDirectory, "opencode-debug-mode-v1")
  const canonicalRepository = await realpath(repository)
  let directories: string[]
  try {
    directories = (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
      .map((entry) => path.join(base, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { found: false, evidence: [] }
    throw error
  }

  for (const sessionDirectory of directories) {
    try {
      const manifest = asRecord(JSON.parse(await readBounded(path.join(sessionDirectory, "manifest.json"))))
      if (manifest === undefined) continue
      const canonicalManifestRoot = await realpath(String(manifest.projectRoot)).catch(() => undefined)
      if (canonicalManifestRoot !== canonicalRepository) continue
      const state = asRecord(JSON.parse(await readBounded(path.join(sessionDirectory, "investigation-state.json"))))
      const evidenceText = await readBounded(path.join(sessionDirectory, "evidence.ndjson")).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
        throw error
      })
      const evidence = evidenceText
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => sanitizeForReport(JSON.parse(line)))
      return {
        found: true,
        sessionDirectory,
        manifest: sanitizeForReport(manifest) as JsonRecord,
        state: sanitizeForReport(state) as JsonRecord,
        evidence,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
  }
  return { found: false, evidence: [] }
}

async function pluginSessionDirectories(tempDirectory: string): Promise<string[]> {
  const base = path.join(tempDirectory, "opencode-debug-mode-v1")
  try {
    return (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

function extractMessages(messages: unknown[]): { transcript: TranscriptEntry[]; tools: OrderedTool[] } {
  const transcript: TranscriptEntry[] = []
  const tools: OrderedTool[] = []
  for (const [messageIndex, item] of messages.entries()) {
    const message = asRecord(item)
    const info = asRecord(message?.info)
    const role = asString(info?.role) ?? "unknown"
    const texts: string[] = []
    const messageTools: Array<{ name: string; status: string }> = []
    for (const [partIndex, partValue] of asArray(message?.parts).entries()) {
      const part = asRecord(partValue)
      if (part?.type === "text" && typeof part.text === "string") texts.push(redactText(part.text))
      if (part?.type !== "tool" || typeof part.tool !== "string") continue
      const state = asRecord(part.state)
      const time = asRecord(state?.time)
      const status = asString(state?.status) ?? "unknown"
      const record: OrderedTool = {
        index: tools.length,
        messageIndex,
        partIndex,
        name: part.tool,
        status,
        input: sanitizeForReport(state?.input ?? {}),
        ...(asString(state?.output) === undefined ? {} : { output: sanitizeToolOutput(asString(state?.output) ?? "") }),
        ...(typeof time?.start === "number" ? { startedAt: time.start } : {}),
        ...(typeof time?.end === "number" ? { endedAt: time.end } : {}),
      }
      tools.push(record)
      messageTools.push({ name: record.name, status })
    }
    transcript.push({ messageIndex, role, text: texts, tools: messageTools })
  }
  return { transcript, tools }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a loopback port")))
        return
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
    })
  })
}

async function canConnectToLoopback(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    let settled = false
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

async function waitForServerPort(
  port: number,
  childExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await Promise.race([
      canConnectToLoopback(port).then((connected) => ({ type: "connect" as const, connected })),
      childExited.then((exit) => ({ type: "exit" as const, exit })),
    ])
    if (result.type === "exit") {
      throw new Error(
        `OpenCode server exited before accepting connections (code=${String(result.exit.code)}, signal=${String(result.exit.signal)})`,
      )
    }
    if (result.connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode server did not accept a loopback connection within ${timeoutMs}ms`)
}

function parseModel(value: string): { providerID: string; modelID: string } {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`Invalid model ${value}; expected provider/model`)
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}

function eventProperties(event: unknown): JsonRecord | undefined {
  const record = asRecord(event)
  return asRecord(record?.properties) ?? asRecord(record?.data)
}

function eventSessionId(event: unknown): string | undefined {
  return asString(eventProperties(event)?.sessionID)
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function ownedProcessGroupExists(child: import("node:child_process").ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) {
    return child.exitCode === null && child.signalCode === null
  }
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true
    throw error
  }
}

function signalOwnedProcessGroup(child: import("node:child_process").ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      } else if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    return
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}

async function waitForOwnedProcessGroupExit(
  child: import("node:child_process").ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!ownedProcessGroupExists(child)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !ownedProcessGroupExists(child)
}

async function stopChild(child: import("node:child_process").ChildProcess): Promise<void> {
  signalOwnedProcessGroup(child, "SIGTERM")
  if (await waitForOwnedProcessGroupExit(child, 5_000)) return
  signalOwnedProcessGroup(child, "SIGKILL")
  if (!(await waitForOwnedProcessGroupExit(child, 2_000))) {
    throw new Error("OpenCode server process group remained alive after SIGKILL")
  }
}

async function prepareOutput(output: string): Promise<string> {
  const absolute = path.resolve(output)
  try {
    await lstat(absolute)
    throw new Error(`Output directory already exists: ${absolute}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await mkdir(path.dirname(absolute), { recursive: true })
  await mkdir(absolute, { mode: 0o700 })
  return absolute
}

function assertNoExactSecret(value: string, sensitiveValues: readonly string[]): void {
  const leaked = exactSecretValues(sensitiveValues).find((secret) => value.includes(secret))
  if (leaked !== undefined) throw new Error("A sensitive value remained in a behavioral acceptance artifact")
}

function artifactText(value: string, sensitiveValues: readonly string[]): string {
  const sanitized = redactText(value, sensitiveValues)
  assertNoExactSecret(sanitized, sensitiveValues)
  return sanitized
}

async function writeJson(filename: string, value: unknown, sensitiveValues: readonly string[] = []): Promise<void> {
  const serialized = `${JSON.stringify(sanitizeForReport(value, sensitiveValues), null, 2)}\n`
  assertNoExactSecret(serialized, sensitiveValues)
  await writeFile(filename, serialized, { mode: 0o600 })
}

async function writeArtifacts(
  output: string,
  snapshot: BehavioralSnapshot,
  acceptance: AcceptanceResult,
  serverLog: string,
  sensitiveValues: readonly string[],
): Promise<void> {
  const evidence =
    snapshot.plugin.evidence.map((event) => JSON.stringify(sanitizeForReport(event, sensitiveValues))).join("\n") +
    (snapshot.plugin.evidence.length === 0 ? "" : "\n")
  assertNoExactSecret(evidence, sensitiveValues)
  await Promise.all([
    writeJson(path.join(output, "report.json"), { acceptance, snapshot }, sensitiveValues),
    writeJson(path.join(output, "ordered-tools.json"), snapshot.orderedTools, sensitiveValues),
    writeJson(path.join(output, "transcript.json"), snapshot.transcript, sensitiveValues),
    writeJson(path.join(output, "session-diff.json"), snapshot.sessionDiff, sensitiveValues),
    writeJson(path.join(output, "plugin-manifest.json"), snapshot.plugin.manifest ?? null, sensitiveValues),
    writeJson(path.join(output, "investigation-state.json"), snapshot.plugin.state ?? null, sensitiveValues),
    writeFile(path.join(output, "evidence.ndjson"), evidence, { mode: 0o600 }),
    writeFile(path.join(output, "git-status.txt"), artifactText(snapshot.repository.status, sensitiveValues), {
      mode: 0o600,
    }),
    writeFile(path.join(output, "git-diff.patch"), artifactText(snapshot.repository.patch, sensitiveValues), {
      mode: 0o600,
    }),
    writeFile(path.join(output, "server.log"), artifactText(serverLog, sensitiveValues), { mode: 0o600 }),
  ])
  const rows = acceptance.checks.map((check) => `- ${check.passed ? "PASS" : "FAIL"} \`${check.id}\`: ${check.detail}`)
  await writeFile(
    path.join(output, "summary.md"),
    artifactText(
      `# OpenCode behavioral acceptance\n\nResult: **${acceptance.passed ? "PASS" : "FAIL"}**\n\n${rows.join("\n")}\n`,
      sensitiveValues,
    ),
    { mode: 0o600 },
  )
}

async function resolvePrompt(prompt: string): Promise<string> {
  if (!prompt.startsWith("@file:")) return prompt
  return readBounded(path.resolve(prompt.slice("@file:".length)))
}

async function runBehavioralAcceptance(
  options: HarnessOptions,
): Promise<{ output: string; acceptance: AcceptanceResult }> {
  const output = await prepareOutput(options.output)
  const ownedRoot = await mkdtemp(path.join(tmpdir(), "opencode-debug-acceptance-"))
  const repository = path.join(ownedRoot, "repo")
  const directories = {
    home: path.join(ownedRoot, "home"),
    config: path.join(ownedRoot, "config", "opencode"),
    data: path.join(ownedRoot, "data"),
    state: path.join(ownedRoot, "state"),
    cache: path.join(ownedRoot, "cache"),
    temp: path.join(ownedRoot, "tmp"),
  }
  const rawServerLog = path.join(ownedRoot, "server.raw.log")
  let child: import("node:child_process").ChildProcess | undefined
  let client: OpenCodeClient | undefined
  let sessionId: string | undefined
  let sseAbort: AbortController | undefined
  let serverLogStream: ReturnType<typeof createWriteStream> | undefined
  let snapshot: BehavioralSnapshot | undefined
  let sensitiveValues = collectSensitiveValues(process.env, {})
  let interrupt: ((stop: HarnessStop) => void) | undefined
  const interruptPromise = new Promise<HarnessStop>((resolve) => {
    interrupt = resolve
  })
  const onSignal = (signal: NodeJS.Signals) => {
    interrupt?.({ reason: "infrastructure", error: new Error(`Acceptance interrupted by ${signal}`) })
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  try {
    await executeFile("npm", ["run", "build"], {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeout: 300_000,
      maxBuffer: MAX_CAPTURE_BYTES,
    })
    const pluginEntry = await realpath(path.join(PROJECT_ROOT, "dist", "index.js"))
    const pluginUrl = pathToFileURL(pluginEntry).href
    const promptFile = path.join(PROJECT_ROOT, "assets", "debug-agent.md")
    const promptText = await readBounded(promptFile)
    const packageJson = asRecord(JSON.parse(await readBounded(path.join(PROJECT_ROOT, "package.json"))))
    const packageVersion = asString(packageJson?.version)
    if (packageVersion === undefined) throw new Error("package.json has no version")
    const prompt = await resolvePrompt(options.prompt)
    const selectedModel = parseModel(options.model)
    const environment = createIsolatedEnvironment(process.env, directories)
    const executable = await realpath(options.opencode)
    const versionResult = await executeFile(executable, ["--version"], { env: environment, timeout: 10_000 })
    const opencodeVersion = versionResult.stdout.trim()
    if (opencodeVersion !== options.expectedVersion) {
      throw new Error(`Expected OpenCode ${options.expectedVersion}, found ${opencodeVersion}`)
    }
    if (!(await stat(options.authFile)).isFile())
      throw new Error(`OpenCode auth file is unavailable: ${options.authFile}`)
    if (!(await stat(options.baseConfig)).isFile())
      throw new Error(`Base OpenCode config is unavailable: ${options.baseConfig}`)
    const isolatedConfig = createSelectedProviderConfig(
      parseBaseConfig(await readBounded(options.baseConfig)),
      selectedModel.providerID,
      pluginUrl,
    )

    await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
    const authDestination = path.join(directories.data, "opencode", "auth.json")
    await mkdir(path.dirname(authDestination), { recursive: true, mode: 0o700 })
    const auth = asRecord(JSON.parse(await readBounded(options.authFile)))
    if (auth === undefined) throw new Error("OpenCode auth file must contain an object")
    const isolatedAuth = createSelectedProviderAuth(auth, selectedModel.providerID)
    sensitiveValues = collectSensitiveValues(process.env, isolatedAuth)
    await writeFile(authDestination, `${JSON.stringify(isolatedAuth, null, 2)}\n`, { mode: 0o600 })
    await chmod(authDestination, 0o600)
    await writeFile(path.join(directories.config, "opencode.json"), `${JSON.stringify(isolatedConfig, null, 2)}\n`, {
      mode: 0o600,
    })

    const sourceRevision = await materializeAcceptanceRepository(options, repository, environment)
    if (options.prepareCommand.trim() !== "") {
      try {
        await executeFile("/bin/sh", ["-c", options.prepareCommand], {
          cwd: repository,
          env: environment,
          timeout: PREPARE_TIMEOUT_MS,
          maxBuffer: MAX_CAPTURE_BYTES,
        })
      } catch (error) {
        const stderr = asString(asRecord(error)?.stderr)
        throw new Error(
          `Disposable project preparation failed${stderr === undefined || stderr.trim() === "" ? "" : `: ${redactText(stderr.trim())}`}`,
        )
      }
    }
    if ((await captureRepository(repository, environment)).changedFiles.length > 0)
      throw new Error("Fresh acceptance clone is not clean")

    const port = await reserveLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    serverLogStream = createWriteStream(rawServerLog, { flags: "a", mode: 0o600 })
    child = (await import("node:child_process")).spawn(
      executable,
      ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG"],
      {
        cwd: repository,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    )
    child.stdout?.on("data", (chunk: Buffer) => serverLogStream?.write(`[stdout] ${chunk.toString("utf8")}`))
    child.stderr?.on("data", (chunk: Buffer) => serverLogStream?.write(`[stderr] ${chunk.toString("utf8")}`))
    const childExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child?.once("exit", (code, signal) => resolve({ code, signal }))
    })
    await waitForServerPort(port, childExited)
    client = createOpencodeClient({ baseUrl, directory: repository })
    const openCode = client

    const [configResponse, agentsResponse, toolsResponse] = await Promise.all([
      withSdkDeadline("config.get", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.config.get({ directory: repository }, { signal }),
      ),
      withSdkDeadline("app.agents", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.app.agents({ directory: repository }, { signal }),
      ),
      withSdkDeadline("tool.ids", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.tool.ids({ directory: repository }, { signal }),
      ),
    ])
    const resolvedConfig = unwrapSdkResponse<JsonRecord>(configResponse, "config.get")
    const agents = unwrapSdkResponse<unknown[]>(agentsResponse, "app.agents")
    const registeredTools = unwrapSdkResponse<string[]>(toolsResponse, "tool.ids")
    const resolvedPluginUrls = asArray(resolvedConfig.plugin)
      .map((entry) => (Array.isArray(entry) ? asString(entry[0]) : asString(entry)))
      .filter((entry): entry is string => entry !== undefined)
    const debugAgent = agents.map(asRecord).find((agent) => agent?.name === "debug")
    const resolvedAgentPrompt = asString(debugAgent?.prompt)
    const resolvedAgentPermission = asArray(debugAgent?.permission).flatMap((value) => {
      const rule = asRecord(value)
      const permission = asString(rule?.permission)
      const pattern = asString(rule?.pattern)
      const action = asString(rule?.action)
      return permission === undefined || pattern === undefined || action === undefined
        ? []
        : [{ permission, pattern, action }]
    })
    const fingerprint: FingerprintCapture = {
      profileId: options.profile,
      model: options.model,
      variant: options.variant,
      sourceRevision,
      opencodeVersion,
      expectedVersion: options.expectedVersion,
      packageVersion,
      pluginUrl,
      distSha256: sha256(await readFile(pluginEntry)),
      promptSha256: sha256(promptText),
      resolvedPluginUrls,
      ...(resolvedAgentPrompt === undefined ? {} : { resolvedAgentPromptSha256: sha256(resolvedAgentPrompt) }),
      resolvedAgentPermission,
      registeredTools: [...registeredTools].sort(),
    }
    if (
      !resolvedPluginUrls.includes(pluginUrl) ||
      fingerprint.resolvedAgentPromptSha256 !== fingerprint.promptSha256 ||
      !REQUIRED_DEBUG_TOOLS.every((name) => registeredTools.includes(name)) ||
      resolvedPermissionAction(fingerprint, "bash") !== "deny" ||
      resolvedPermissionAction(fingerprint, "task") !== "deny" ||
      resolvedPermissionAction(fingerprint, "__unknown_acceptance_tool__") !== "ask"
    ) {
      throw new Error(
        "Fresh server did not resolve the expected local debug plugin, prompt, tools, and deny-by-default agent permission",
      )
    }

    const created = unwrapSdkResponse<JsonRecord>(
      await withSdkDeadline("session.create", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.session.create(
          {
            directory: repository,
            title: acceptanceProfile(options.profile).title,
            agent: "debug",
            model: {
              id: selectedModel.modelID,
              providerID: selectedModel.providerID,
              variant: options.variant,
            },
          },
          { signal },
        ),
      ),
      "session.create",
    )
    sessionId = asString(created.id)
    if (sessionId === undefined) throw new Error("OpenCode did not return a session id")
    const activeSessionId = sessionId

    let settleStop: ((value: HarnessStop) => void) | undefined
    let stopped = false
    const stopPromise = new Promise<HarnessStop>((resolve) => {
      settleStop = (value) => {
        if (stopped) return
        stopped = true
        resolve(value)
      }
    })
    const observedEvents: Array<{ index: number; type: string }> = []
    let promptSubmitted = false
    sseAbort = new AbortController()
    const subscription = await withAbortControllerDeadline(
      "event.subscribe",
      SDK_REQUEST_TIMEOUT_MS,
      sseAbort,
      (signal) => openCode.event.subscribe({ directory: repository }, { signal, sseMaxRetryAttempts: 1 }),
    )
    const eventPump = (async () => {
      try {
        for await (const event of subscription.stream) {
          const eventRecord = asRecord(event)
          const type = asString(eventRecord?.type) ?? "unknown"
          if (eventSessionId(event) !== activeSessionId) continue
          observedEvents.push({ index: observedEvents.length, type })
          const properties = eventProperties(event)
          if (!promptSubmitted) continue
          if (type === "question.asked") {
            settleStop?.({ reason: "question", ...(properties === undefined ? {} : { question: properties }) })
          } else if (type === "permission.asked" || type === "permission.updated") {
            settleStop?.({ reason: "permission", error: properties })
          } else if (type === "session.error") settleStop?.({ reason: "error", error: properties?.error })
          else if (type === "session.idle") settleStop?.({ reason: "idle" })
        }
      } catch (error) {
        if (!sseAbort?.signal.aborted) settleStop?.({ reason: "infrastructure", error })
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 250))
    promptSubmitted = true
    unwrapSdkResponse<void>(
      await withSdkDeadline("session.promptAsync", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.session.promptAsync(
          {
            sessionID: activeSessionId,
            directory: repository,
            agent: "debug",
            model: selectedModel,
            variant: options.variant,
            parts: [{ type: "text", text: prompt }],
          },
          { signal },
        ),
      ),
      "session.promptAsync",
    )
    const serverExitPromise = childExited.then<HarnessStop>(({ code, signal }) => ({
      reason: "infrastructure",
      error: new Error(`OpenCode server exited during the agent run (code=${String(code)}, signal=${String(signal)})`),
    }))
    const stop = await Promise.race<HarnessStop>([stopPromise, serverExitPromise, interruptPromise])
    if (stop.reason === "infrastructure") {
      await abortOpenCodeSession(openCode, activeSessionId, repository).catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))

    const [messagesResponse, sessionDiffResponse, statusResponse, questionsResponse] = await Promise.all([
      withSdkDeadline("session.messages", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.session.messages({ sessionID: activeSessionId, directory: repository }, { signal }),
      ),
      withSdkDeadline("session.diff", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.session.diff({ sessionID: activeSessionId, directory: repository }, { signal }),
      ),
      withSdkDeadline("session.status", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.session.status({ directory: repository }, { signal }),
      ),
      withSdkDeadline("question.list", SDK_REQUEST_TIMEOUT_MS, (signal) =>
        openCode.question.list({ directory: repository }, { signal }),
      ),
    ])
    const messages = unwrapSdkResponse<unknown[]>(messagesResponse, "session.messages")
    const extracted = extractMessages(messages)
    const sessionDiff = unwrapSdkResponse<unknown[]>(sessionDiffResponse, "session.diff")
    const statuses = unwrapSdkResponse<JsonRecord>(statusResponse, "session.status")
    const pendingQuestions = unwrapSdkResponse<unknown[]>(questionsResponse, "question.list")
    const plugin = await capturePlugin(directories.temp, repository)
    const rawManifest =
      plugin.sessionDirectory === undefined
        ? undefined
        : asRecord(JSON.parse(await readBounded(path.join(plugin.sessionDirectory, "manifest.json"))))
    const repositoryBeforeCleanup = await captureRepository(repository, environment, rawManifest)
    fingerprint.debugSessionStart = toolOutputDiagnostics(
      extracted.tools.find((tool) => tool.name === "debug_session_start"),
    )

    await abortOpenCodeSession(openCode, activeSessionId, repository).catch(() => undefined)
    await deleteOpenCodeSession(openCode, activeSessionId, repository)
    await waitUntil(async () => (await pluginSessionDirectories(directories.temp)).length === 0, 10_000)
    const postCleanupRepository = await captureRepository(repository, environment)
    const remainingPluginSessionDirectories = await pluginSessionDirectories(directories.temp)
    sseAbort.abort()
    await waitForPromise(
      eventPump.catch(() => undefined),
      2_000,
    )

    snapshot = {
      fingerprint,
      stopReason: stop.reason,
      ...(stop.question === undefined ? {} : { question: sanitizeForReport(stop.question) as JsonRecord }),
      pendingQuestions: sanitizeForReport(pendingQuestions) as unknown[],
      openCodeSessionStatus: sanitizeForReport(statuses[activeSessionId]),
      orderedTools: extracted.tools,
      transcript: extracted.transcript,
      sessionDiff: sanitizeForReport(sessionDiff) as unknown[],
      repository: repositoryBeforeCleanup,
      plugin,
      postCleanup: { remainingPluginSessionDirectories, repository: postCleanupRepository },
    }
    const acceptance = evaluateAcceptance(snapshot)
    await stopChild(child)
    child = undefined
    await new Promise<void>((resolve) => serverLogStream?.end(resolve))
    serverLogStream = undefined
    const serverLog = await readTailBounded(rawServerLog).catch(() => "")
    await writeArtifacts(output, snapshot, acceptance, serverLog, sensitiveValues)
    return { output, acceptance }
  } catch (error) {
    const infrastructure = {
      passed: false,
      checks: [
        {
          id: "harness-infrastructure",
          passed: false,
          detail: error instanceof Error ? redactText(error.message) : "Unknown harness failure",
        },
      ],
    }
    await writeJson(path.join(output, "infrastructure-error.json"), infrastructure, sensitiveValues)
    if (client !== undefined && sessionId !== undefined) {
      await abortOpenCodeSession(client, sessionId, repository).catch(() => undefined)
      await deleteOpenCodeSession(client, sessionId, repository).catch(() => undefined)
      sessionId = undefined
    }
    if (child !== undefined) {
      await stopChild(child).catch(() => undefined)
      child = undefined
    }
    if (serverLogStream !== undefined) {
      await new Promise<void>((resolve) => serverLogStream?.end(resolve))
      serverLogStream = undefined
    }
    const serverLog = await readTailBounded(rawServerLog).catch(() => "")
    await writeFile(path.join(output, "server.log"), artifactText(serverLog, sensitiveValues), { mode: 0o600 })
    throw error
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
    sseAbort?.abort()
    if (client !== undefined && sessionId !== undefined && snapshot === undefined) {
      await abortOpenCodeSession(client, sessionId, repository).catch(() => undefined)
      await deleteOpenCodeSession(client, sessionId, repository).catch(() => undefined)
    }
    if (child !== undefined) await stopChild(child).catch(() => undefined)
    if (serverLogStream !== undefined) await new Promise<void>((resolve) => serverLogStream?.end(resolve))
    await rm(ownedRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  let options: HarnessOptions
  try {
    options = parseHarnessOptions(process.argv.slice(2))
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(usage())
      return
    }
    throw error
  }
  const result = await runBehavioralAcceptance(options)
  process.stdout.write(`Behavioral acceptance ${result.acceptance.passed ? "passed" : "failed"}: ${result.output}\n`)
  if (!result.acceptance.passed) process.exitCode = 1
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? redactText(error.message) : "Unknown behavioral acceptance failure"
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
