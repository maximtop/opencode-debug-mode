import { describe, expect, it } from "vitest"
import {
  validateCleanupCleanCheckCommand,
  validateRuntimeCaptureCommand,
  validateRuntimeCaptureEnvironment,
} from "../../src/process/command-policy.js"

function invalidRuntime(executable: string, args: string[]): void {
  expect(() => validateRuntimeCaptureCommand(executable, args)).toThrowError(
    expect.objectContaining({ code: "INVALID_PHASE", action: expect.any(String) }),
  )
}

function invalidCleanup(executable: string, args: string[]): void {
  expect(() => validateCleanupCleanCheckCommand(executable, args)).toThrowError(
    expect.objectContaining({ code: "INVALID_PHASE", action: expect.any(String) }),
  )
}

describe("supervised runtime command policy", () => {
  it.each([
    ["cp", ["source.ts", "copy.ts"]],
    ["rm", ["-rf", "src"]],
    ["touch", ["src/written.ts"]],
    ["curl", ["https://example.test/file", "-o", "src/written.ts"]],
    ["bash", ["-lc", "npm test"]],
    ["python3", ["writer.py"]],
    ["node", ["writer.js"]],
    ["node", ["--check", "/tmp/writer.js"]],
    ["node", ["--eval", "require('node:fs').writeFileSync('x', 'y')"]],
    ["git", ["switch", "other"]],
    ["git", ["config", "core.pager", "writer"]],
    ["git", ["diff", "--output=changes.patch"]],
    ["git", ["show", "--textconv", "HEAD:file.ts"]],
    ["npm", ["run", "resources"]],
    ["npm", ["build"]],
    ["npm", ["run", "test", "--", "--updateSnapshot"]],
    ["pnpm", ["install"]],
    ["yarn", ["publish"]],
    ["bun", ["run", "deploy"]],
    ["bun", ["build"]],
    ["npx", ["vitest", "run"]],
    ["eslint", ["src", "--fix"]],
    ["eslint", ["src", "--config", "/tmp/writer.js"]],
    ["biome", ["check", "src", "--write"]],
    ["vitest", ["--watch"]],
    ["vitest", ["run", "--api", "--host=0.0.0.0"]],
    ["jest", ["--setupFilesAfterEnv=/tmp/writer.js"]],
    ["jest", ["/tmp/writer.test.js"]],
    ["mocha", ["../writer.test.js"]],
    ["npm", ["test", "--", "/tmp/writer.test.js"]],
    ["npm", ["test", "--", "--root=/tmp"]],
    ["tsc", ["-p", "tsconfig.json"]],
    ["/tmp/node", ["--check", "src/index.js"]],
    ["/tmp/git", ["status", "--short"]],
    ["D:\\repo\\Windows\\System32\\node.exe", ["--check", "src/index.js"]],
    ["D:\\tmp\\Program Files\\nodejs\\node.exe", ["--check", "src/index.js"]],
    ["D:\\tmp\\Program Files\\Git\\cmd\\git.exe", ["status", "--short"]],
    ["C:\\Program Files\\Git\\cmd\\nested\\git.exe", ["status", "--short"]],
    ["vitest", ["run", "--root=/tmp"]],
    ["eslint", ["src", "--cwd=../outside"]],
    ["node", ["--test", "--test-reporter=./writer.mjs", "tests/unit/example.test.ts"]],
  ])("rejects %s %j", (executable, args) => invalidRuntime(executable, args))

  it.each([
    ["git", ["status", "--short"]],
    ["git", ["diff", "--stat", "HEAD"]],
    ["git", ["show", "--no-ext-diff", "HEAD:src/index.ts"]],
    ["node", ["--check", "src/index.js"]],
    [process.execPath, ["--check", "src/index.js"]],
    ["C:\\Program Files\\nodejs\\node.exe", ["--check", "src/index.js"]],
    ["node", ["--test", "tests/unit/example.test.ts", "--test-concurrency=1"]],
    ["tsc", ["--noEmit", "-p", "tsconfig.json", "--pretty", "false"]],
    ["eslint", ["src/**/*.ts", "--max-warnings=0"]],
    ["biome", ["check", "src", "tests"]],
    ["vitest", ["run", "tests/unit"]],
    ["prettier", ["--check", "src/**/*.ts"]],
    ["npm", ["test", "--", "--run"]],
    ["npm", ["run", "test:unit", "--", "--runInBand"]],
    ["npm.cmd", ["tst"]],
    ["pnpm", ["run", "lint:ci"]],
    ["yarn", ["typecheck"]],
    ["bun", ["run", "build"]],
  ])("allows %s %j", (executable, args) => {
    expect(() => validateRuntimeCaptureCommand(executable, args)).not.toThrow()
  })
})

describe("cleanup clean-check command policy", () => {
  it.each([
    ["node", ["--check", "src/index.js"]],
    ["git", ["status", "--short"]],
    ["git", ["status", "--porcelain", "src"]],
    ["git", ["diff"]],
    ["git", ["diff", "--quiet", "--output=clean.patch"]],
    ["git", ["diff", "--exit-code", "--ext-diff"]],
    ["git", ["diff", "--check", "--", "src"]],
    ["git", ["config", "--get", "core.hooksPath"]],
    ["/tmp/git", ["status", "--porcelain"]],
  ])("rejects cleanup command %s %j", (executable, args) => invalidCleanup(executable, args))

  it.each([
    ["git", ["status", "--porcelain"]],
    ["/usr/bin/git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"]],
    ["git.exe", ["diff", "--quiet", "--no-ext-diff", "--no-textconv"]],
    ["C:\\Program Files\\Git\\cmd\\git.exe", ["status", "--porcelain"]],
    ["git", ["diff", "--exit-code", "HEAD", "--"]],
    ["git", ["diff", "--check", "--cached", "--ignore-submodules=dirty"]],
  ])("allows cleanup command %s %j", (executable, args) => {
    expect(() => validateCleanupCleanCheckCommand(executable, args)).not.toThrow()
  })
})

describe("supervised runtime environment policy", () => {
  it.each([
    [{ NODE_OPTIONS: "--import=/tmp/writer.mjs" }],
    [{ PATH: "/tmp/bin" }],
    [{ npm_config_userconfig: "/tmp/npmrc" }],
    [{ VITEST_CONFIG: "/tmp/vitest.config.ts" }],
    [{ NODE_ENV: "production" }],
  ])("rejects executable or arbitrary environment overrides %j", (env) => {
    expect(() => validateRuntimeCaptureEnvironment(env)).toThrowError(
      expect.objectContaining({ code: "INVALID_PHASE", action: expect.any(String) }),
    )
  })

  it("allows only inert output/test-mode overrides", () => {
    expect(() =>
      validateRuntimeCaptureEnvironment({ CI: "true", FORCE_COLOR: "0", NO_COLOR: "1", NODE_ENV: "test" }),
    ).not.toThrow()
  })
})
