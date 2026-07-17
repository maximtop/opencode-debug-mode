import { execFile } from "node:child_process"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, onTestFinished } from "vitest"

const execFileAsync = promisify(execFile)
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm"

interface TestResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runFixtureTest(cwd: string): Promise<TestResult> {
  try {
    const result = await execFileAsync(npmExecutable, ["test"], { cwd })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string }
    return {
      exitCode: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    }
  }
}

describe("feature flag debugging fixture", () => {
  it("fails before the encoding fix and passes after the one-token correction", async () => {
    const container = await mkdtemp(path.join(tmpdir(), "opencode-debug-feature-flag-fixture-"))
    const projectRoot = path.join(container, "project")
    await cp(path.resolve("fixtures/feature-flag-bug"), projectRoot, { recursive: true })
    onTestFinished(() => rm(container, { recursive: true, force: true }))

    const baseline = await runFixtureTest(projectRoot)
    expect(baseline.exitCode).toBe(1)
    expect(`${baseline.stdout}\n${baseline.stderr}`).toContain(
      "loads beta flags for account identifiers containing slashes",
    )

    const sourcePath = path.join(projectRoot, "src", "feature-flags.mjs")
    const source = await readFile(sourcePath, "utf8")
    expect(source.match(/encodeURI\(accountId\)/gu)).toHaveLength(1)
    await writeFile(sourcePath, source.replace("encodeURI(accountId)", "encodeURIComponent(accountId)"))

    const verification = await runFixtureTest(projectRoot)
    expect(verification).toMatchObject({ exitCode: 0, stderr: "" })
    expect(verification.stdout).toContain("pass 1")
  })
})
