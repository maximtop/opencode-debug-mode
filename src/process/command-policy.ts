import path from "node:path"
import { DebugModeError } from "../core/errors.js"

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])
const PACKAGE_SCRIPT = /^(?:test|lint|check|typecheck|build)(?::[A-Za-z0-9._-]+)*$/u
const SCRIPT_PATH = /\.(?:c|m)?(?:j|t)sx?$/iu

const READ_ONLY_GIT_COMMANDS = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "diff-tree",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
])

const DIRECT_CHECK_TOOLS = new Set(["ava", "eslint", "jest", "mocha", "oxlint", "stylelint"])

const TRUSTED_POSIX_EXECUTABLE_DIRECTORIES = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"])
const SAFE_ENVIRONMENT_VALUES: Readonly<Record<string, RegExp>> = {
  CI: /^(?:0|1|false|true)$/iu,
  FORCE_COLOR: /^(?:0|1|2|3|false|true)$/iu,
  NODE_ENV: /^test$/u,
  NO_COLOR: /^(?:0|1|false|true)$/iu,
}

const WRITE_FLAG =
  /^(?:-[ouw]|--(?:cache(?:-location)?|coverage(?:-directory)?|declaration(?:dir)?|emit(?:declarationonly)?|fix(?:-dry-run)?|generate(?:-[a-z0-9-]+)?|incremental|init|out(?:-?dir|put(?:-?file)?|file)?|snapshot-update|test-reporter-destination|test-update-snapshots|tsbuildinfofile|update(?:snapshot|snapshots)?|watch(?:all)?|write(?:-file)?))(?:=|$)/iu

const GIT_EXTERNAL_OR_OUTPUT_FLAG =
  /^(?:-o(?:$|[^-])|-c(?:$|[^a-z])|--(?:config|config-env|exec|ext-diff|filters|git-dir|namespace|no-index|open-files-in-pager|output|paginate|textconv|work-tree)(?:=|$))/iu

const EXTERNAL_CODE_OR_SERVER_FLAG =
  /^(?:-[cr]|--(?:api|browser|config|environment|extension|format|formatter|global-setup|global-teardown|host|import|inspect(?:-brk)?|loader|open|plugin|plugins|port|preset|processor|require|resolver|rule-path|rulesdir|runner|setup-files|setupfiles(?:afterenv)?|snapshotresolver|testenvironment|testsequencer|transform|ui))(?:=|$)/iu

const SHELL_META = /[;&|><`$()\r\n]/u

function reject(message: string, action: string): never {
  throw new DebugModeError("INVALID_PHASE", message, false, { action })
}

function executableName(executable: string): string {
  const name = (executable.includes("\\") ? path.win32.basename(executable) : path.basename(executable)).toLowerCase()
  return name.replace(/\.(?:cmd|exe|bat)$/u, "")
}

function hasPathComponent(executable: string): boolean {
  return executable.includes("/") || executable.includes("\\")
}

function sameExecutablePath(left: string, right: string): boolean {
  if (process.platform === "win32" || path.win32.isAbsolute(left) || path.win32.isAbsolute(right)) {
    return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
  }
  return path.resolve(left) === path.resolve(right)
}

function addWindowsTrustedDirectory(directories: Set<string>, root: string | undefined, ...segments: string[]): void {
  if (root === undefined || !path.win32.isAbsolute(root)) return
  directories.add(path.win32.normalize(path.win32.join(root, ...segments)).toLowerCase())
}

function trustedWindowsExecutable(executable: string, command: string): boolean {
  if (!path.win32.isAbsolute(executable)) return false
  const normalized = path.win32.normalize(executable).toLowerCase()
  const segments = normalized.split("\\")
  const executableFile = segments.at(-1) ?? ""
  if (executableName(executableFile) !== command) return false
  const parent = segments.slice(0, -1).join("\\")
  const trusted = new Set<string>()
  for (const systemRoot of [process.env.SystemRoot, process.env.SYSTEMROOT, process.env.WINDIR, "C:\\Windows"]) {
    addWindowsTrustedDirectory(trusted, systemRoot, "System32")
  }
  for (const programFiles of [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ]) {
    addWindowsTrustedDirectory(trusted, programFiles, "nodejs")
    addWindowsTrustedDirectory(trusted, programFiles, "Git", "cmd")
    addWindowsTrustedDirectory(trusted, programFiles, "Git", "bin")
  }
  return trusted.has(parent)
}

function assertTrustedExecutable(executable: string, command: string): void {
  if (!hasPathComponent(executable)) return
  if (command === "node" && sameExecutablePath(executable, process.execPath)) return
  if (trustedWindowsExecutable(executable, command)) return
  if (
    path.isAbsolute(executable) &&
    TRUSTED_POSIX_EXECUTABLE_DIRECTORIES.has(path.dirname(path.normalize(executable)))
  ) {
    return
  }
  reject(
    `Executable path for ${command || "<missing>"} is outside trusted system locations`,
    "Use the bare allowlisted executable name, the current Node executable, or a known system installation",
  )
}

function assertWellFormed(executable: string, args: readonly string[]): void {
  if (executable.trim().length === 0 || executable.includes("\0")) {
    reject("The supervised executable is invalid", "Choose a direct allowlisted project check executable")
  }
  if (args.some((argument) => argument.includes("\0") || /[\r\n]/u.test(argument))) {
    reject(
      "Supervised command arguments cannot contain control characters",
      "Pass each ordinary command argument as a separate array item",
    )
  }
}

function assertNoWriteFlags(args: readonly string[]): void {
  const denied = args.find((argument) => WRITE_FLAG.test(argument.toLowerCase()))
  if (denied !== undefined) {
    reject(
      "The supervised command includes a write, output, update, cache, or watch flag",
      "Use a one-shot read-only check without output, update, fix, cache, coverage, or watch flags",
    )
  }
}

function assertNoExternalCodeOrServerFlags(args: readonly string[]): void {
  const denied = args.find((argument) => EXTERNAL_CODE_OR_SERVER_FLAG.test(argument.toLowerCase()))
  if (denied !== undefined) {
    reject(
      "The supervised command can load external code or start a server",
      "Use the checked-in default test or check configuration without plugins, loaders, inspectors, UI, or servers",
    )
  }
}

function isSafeProjectPath(value: string): boolean {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false
  return !value.split(/[\\/]/u).includes("..")
}

function assertProjectOperands(args: readonly string[]): void {
  const denied = args.find((argument) => !argument.startsWith("-") && !isSafeProjectPath(argument))
  if (denied !== undefined) {
    reject(
      "The supervised command references a path outside the project",
      "Use checked-in project-relative test, source, and selector paths only",
    )
  }
}

function assertSafeDirectArguments(command: string, args: readonly string[]): void {
  const exact = new Set([
    "--",
    "--allow-only",
    "--allowonly",
    "--bail",
    "--check-leaks",
    "--color",
    "--detect-open-handles",
    "--detectopenhandles",
    "--disable-console-intercept",
    "--disableconsoleintercept",
    "--dry-run",
    "--error-on-warnings",
    "--force-exit",
    "--forceexit",
    "--hide-skipped-tests",
    "--hideskippedtests",
    "--ignore-unknown",
    "--invert",
    "--list-different",
    "--list-tests",
    "--listtests",
    "--no-color",
    "--no-error-on-unmatched-pattern",
    "--no-errors-on-unmatched",
    "--no-warn-ignored",
    "--pass-with-no-tests",
    "--passwithnotests",
    "--quiet",
    "--run",
    "--run-in-band",
    "--runinband",
    "--silent",
    "--verbose",
  ])
  const safeValue = [
    /^--(?:bail|hook-?timeout|max-?diagnostics|max-?workers|min-?workers|retry|test-?timeout|timeout)=\d+$/u,
    /^--max-warnings=-?\d+$/u,
    /^--shard=\d+\/\d+$/u,
    /^--(?:color|colors|files-ignore-unknown|silent|verbose)=(?:false|true)$/u,
    /^--diagnostic-level=(?:error|info|warn)$/u,
    /^--log-level=(?:debug|error|log|silent|warn)$/u,
    /^--pool=(?:forks|threads|vmforks|vmthreads)$/u,
    /^--reporter=(?:basic|default|dot|github-actions|json|junit|spec|tap|verbose)$/u,
    /^--report-unused-disable-directives(?:-severity=(?:error|off|warn))?$/u,
    /^--(?:fgrep|grep|test-?name-?pattern)=[^\r\n]{1,512}$/u,
  ]
  const modeOffset =
    (command === "vitest" && args[0] === "run") ||
    (command === "biome" && (args[0] === "check" || args[0] === "lint")) ||
    ((command === "prettier" || command === "dprint") && (args[0] === "--check" || args[0] === "check"))
      ? 1
      : 0
  const denied = args.slice(modeOffset).find((argument) => {
    if (!argument.startsWith("-")) return false
    const normalized = argument.toLowerCase()
    return !exact.has(normalized) && !safeValue.some((pattern) => pattern.test(normalized))
  })
  if (denied !== undefined) {
    reject(
      `The ${command} option ${denied} is outside the supervised read-only grammar`,
      "Use project-relative selectors and explicitly allowlisted one-shot check options only",
    )
  }
}

function validateGitInspection(args: readonly string[]): void {
  const command = args[0]?.toLowerCase()
  if (command === undefined || !READ_ONLY_GIT_COMMANDS.has(command)) {
    reject(
      "Only explicitly read-only Git inspection subcommands are accepted by supervised capture",
      "Use git status, diff, show, log, rev-parse, ls-files, or another allowlisted inspection command",
    )
  }
  const denied = args.slice(1).find((argument) => GIT_EXTERNAL_OR_OUTPUT_FLAG.test(argument.toLowerCase()))
  if (denied !== undefined) {
    reject(
      "Git inspection cannot write output or invoke external helpers",
      "Remove output, pager, no-index, text conversion, filter, and external diff options",
    )
  }
}

function packageScript(args: readonly string[], manager: string): { name: string; remaining: readonly string[] } {
  const first = args[0]?.toLowerCase()
  if (first === undefined) {
    reject(
      "A package manager requires an allowlisted script",
      "Run an existing test, lint, check, typecheck, or build script",
    )
  }

  if (first === "run" || first === "run-script") {
    const name = args[1]
    if (name === undefined) {
      reject(
        "A package-manager run command requires an explicit script name",
        "Name an existing test, lint, check, typecheck, or build script",
      )
    }
    return { name, remaining: args.slice(2) }
  }

  if (manager === "npm") {
    if (["test", "t", "tst"].includes(first)) return { name: "test", remaining: args.slice(1) }
    reject(
      "npm accepts only its test shorthand outside an explicit run command",
      "Use npm run followed by an allowlisted script name, or npm test",
    )
  }
  if (manager === "bun" && first !== "test") {
    reject(
      "Bun package scripts require an explicit run command",
      "Use bun run followed by an allowlisted script name, or bun test",
    )
  }
  return { name: args[0] ?? "", remaining: args.slice(1) }
}

function validatePackageScript(manager: string, args: readonly string[]): void {
  const script = packageScript(args, manager)
  if (!PACKAGE_SCRIPT.test(script.name)) {
    reject(
      "The package script is outside the supervised check allowlist",
      "Use a script named test, lint, check, typecheck, build, or a colon-delimited variant",
    )
  }
  if (script.remaining.some((argument) => SHELL_META.test(argument))) {
    reject(
      "Package-script arguments cannot contain shell operators or substitutions",
      "Pass only ordinary test or check selectors and flags",
    )
  }
  assertSafeDirectArguments("package script", script.remaining)
  assertNoWriteFlags(script.remaining)
  assertNoExternalCodeOrServerFlags(script.remaining)
  assertProjectOperands(script.remaining)
}

function validateNode(args: readonly string[]): void {
  const first = args[0]
  if (
    (first === "--check" || first === "-c") &&
    args.length === 2 &&
    SCRIPT_PATH.test(args[1] ?? "") &&
    isSafeProjectPath(args[1] ?? "")
  ) {
    return
  }

  if (first !== "--test") {
    reject(
      "Node is accepted only for syntax checking or its built-in test runner",
      "Use node --check <file> or node --test with checked-in JavaScript or TypeScript tests",
    )
  }
  for (const argument of args.slice(1)) {
    if (!argument.startsWith("-") && SCRIPT_PATH.test(argument) && isSafeProjectPath(argument)) continue
    if (/^--test-(?:concurrency|timeout)=\d+$/u.test(argument)) continue
    if (/^--test-(?:name|skip)-pattern=[^\r\n]{1,512}$/u.test(argument)) continue
    if (/^--test-reporter=(?:dot|junit|lcov|spec|tap)$/u.test(argument)) continue
    if (/^--test-shard=\d+\/\d+$/u.test(argument) || argument === "--test-only") {
      continue
    }
    if (/^[A-Za-z0-9_./*?{},@:+-]+$/u.test(argument) && !argument.startsWith("-") && isSafeProjectPath(argument)) {
      continue
    }
    reject(
      "A Node test argument is outside the supervised allowlist",
      "Use checked-in test paths and Node test-runner selection options only",
    )
  }
  assertNoWriteFlags(args)
  assertNoExternalCodeOrServerFlags(args)
  assertProjectOperands(args)
}

function validateTypeScript(args: readonly string[]): void {
  if (!args.some((argument) => argument.toLowerCase() === "--noemit")) {
    reject("TypeScript compilation must disable emit", "Add --noEmit and run a typecheck-only command")
  }

  const optionsWithValue = new Set(["-p", "--project", "--pretty", "--incremental", "--composite"])
  const switches = new Set(["--noemit", "--skiplibcheck"])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined || (SCRIPT_PATH.test(argument) && isSafeProjectPath(argument))) continue
    const normalized = argument.toLowerCase()
    if (switches.has(normalized) || /^(?:--pretty|--incremental|--composite)=(?:true|false)$/u.test(normalized))
      continue
    if (optionsWithValue.has(normalized)) {
      const value = args[index + 1]
      if (
        value === undefined ||
        value.startsWith("-") ||
        SHELL_META.test(value) ||
        ((normalized === "-p" || normalized === "--project") && !isSafeProjectPath(value))
      ) {
        reject("A TypeScript option requires a safe value", "Pass a project path or boolean as a separate argument")
      }
      index += 1
      continue
    }
    reject(
      "A TypeScript argument is outside the no-emit allowlist",
      "Use --noEmit with project, pretty, incremental=false, composite=false, or source-file arguments only",
    )
  }
  assertNoWriteFlags(args)
  assertNoExternalCodeOrServerFlags(args)
  assertProjectOperands(args)
}

function validateDirectCheckTool(command: string, args: readonly string[]): void {
  if (command === "vitest") {
    if (args[0] !== "run") {
      reject("Vitest must run once without watch mode", "Use vitest run with test selectors and read-only flags")
    }
  } else if (command === "biome") {
    if (args[0] !== "check" && args[0] !== "lint") {
      reject("Biome is accepted only in check or lint mode", "Use biome check or biome lint without --write or --fix")
    }
  } else if (command === "prettier" || command === "dprint") {
    if (args[0] !== "--check" && args[0] !== "check") {
      reject(`The ${command} formatter is accepted only in check mode`, `Use ${command} check without write flags`)
    }
  }
  assertSafeDirectArguments(command, args)
  assertNoWriteFlags(args)
  assertNoExternalCodeOrServerFlags(args)
  assertProjectOperands(args)
}

/**
 * Validates the executable and argument vector used for a supervised runtime capture.
 * The policy deliberately accepts only read-only Git inspection and declared JS/TS checks.
 */
export function validateRuntimeCaptureCommand(executable: string, args: readonly string[]): void {
  assertWellFormed(executable, args)
  const command = executableName(executable)
  assertTrustedExecutable(executable, command)

  if (command === "git") {
    validateGitInspection(args)
    return
  }
  if (PACKAGE_MANAGERS.has(command)) {
    validatePackageScript(command, args)
    return
  }
  if (command === "node") {
    validateNode(args)
    return
  }
  if (command === "tsc" || command === "tsgo") {
    validateTypeScript(args)
    return
  }
  if (
    DIRECT_CHECK_TOOLS.has(command) ||
    command === "vitest" ||
    command === "biome" ||
    command === "prettier" ||
    command === "dprint"
  ) {
    validateDirectCheckTool(command, args)
    return
  }

  reject(
    `Executable ${command || "<missing>"} is outside the supervised runtime allowlist`,
    "Use read-only Git inspection, a direct JS/TS check tool, or an allowlisted package script",
  )
}

/** Rejects process-environment overrides except a small non-executable test-output allowlist. */
export function validateRuntimeCaptureEnvironment(env: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(env)) {
    const accepted = SAFE_ENVIRONMENT_VALUES[name.toUpperCase()]
    if (accepted === undefined || !accepted.test(value)) {
      reject(
        `Environment override ${name} is outside the supervised allowlist`,
        "Omit environment overrides or use only CI, FORCE_COLOR, NO_COLOR, and NODE_ENV=test",
      )
    }
  }
}

const CLEAN_STATUS_OPTIONS = new Set([
  "--porcelain",
  "--porcelain=v1",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--show-stash",
  "--ahead-behind",
  "--no-ahead-behind",
  "--renames",
  "--no-renames",
  "--untracked-files=no",
  "--untracked-files=normal",
  "--untracked-files=all",
  "-uno",
  "-unormal",
  "-uall",
  "--ignored=no",
  "--ignored=matching",
  "--ignored=traditional",
  "--ignore-submodules=none",
  "--ignore-submodules=untracked",
  "--ignore-submodules=dirty",
  "--ignore-submodules=all",
])

const CLEAN_DIFF_OPTIONS = new Set([
  "--quiet",
  "--exit-code",
  "--check",
  "--cached",
  "--staged",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules",
  "--ignore-submodules=none",
  "--ignore-submodules=untracked",
  "--ignore-submodules=dirty",
  "--ignore-submodules=all",
  "head",
  "--",
])

function validateCleanStatus(args: readonly string[]): void {
  const options = args.slice(1).map((argument) => argument.toLowerCase())
  if (!options.some((option) => option === "--porcelain" || option.startsWith("--porcelain="))) {
    reject("Cleanup git status must use porcelain output", "Use git status --porcelain or --porcelain=v2")
  }
  const denied = options.find(
    (option) => !CLEAN_STATUS_OPTIONS.has(option) && !/^--find-renames(?:=\d+%?)?$/u.test(option),
  )
  if (denied !== undefined) {
    reject(
      "A cleanup git status option is outside the allowlist",
      "Use porcelain status for the whole worktree without pathspecs, output files, or helpers",
    )
  }
}

function validateCleanDiff(args: readonly string[]): void {
  const options = args.slice(1).map((argument) => argument.toLowerCase())
  if (!options.some((option) => option === "--quiet" || option === "--exit-code" || option === "--check")) {
    reject(
      "Cleanup git diff requires --quiet, --exit-code, or --check",
      "Use a bounded whole-worktree diff check without output files or external helpers",
    )
  }
  const denied = options.find((option) => !CLEAN_DIFF_OPTIONS.has(option))
  if (denied !== undefined) {
    reject(
      "A cleanup git diff option is outside the allowlist",
      "Use only --quiet, --exit-code, --check, index selection, HEAD, and no-helper options",
    )
  }
  const separator = options.indexOf("--")
  if (separator >= 0 && separator !== options.length - 1) {
    reject("Cleanup git diff cannot narrow the path scope", "Check the complete worktree without a pathspec")
  }
}

/** Validates the optional command that confirms cleanup left no debug changes. */
export function validateCleanupCleanCheckCommand(executable: string, args: readonly string[]): void {
  assertWellFormed(executable, args)
  const commandName = executableName(executable)
  assertTrustedExecutable(executable, commandName)
  if (commandName !== "git") {
    reject("Cleanup checks accept only Git", "Use git status --porcelain or git diff with a check-only option")
  }
  const command = args[0]?.toLowerCase()
  if (command === "status") {
    validateCleanStatus(args)
    return
  }
  if (command === "diff") {
    validateCleanDiff(args)
    return
  }
  reject(
    "Cleanup checks accept only porcelain status or check-only diff",
    "Use git status --porcelain or git diff --quiet, --exit-code, or --check",
  )
}
