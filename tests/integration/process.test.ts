import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { EvidenceStore } from "../../src/evidence/store.js"
import { validateRuntimeCaptureCommand } from "../../src/process/command-policy.js"
import { createProcessServiceFixture } from "../helpers/factories.js"

const execFileAsync = promisify(execFile)

describe("process capture integration", () => {
  it("captures a real nonzero process without buffering full output", async () => {
    const fixture = await createProcessServiceFixture()
    const result = await fixture.service.capture({
      runId: fixture.runId,
      executable: process.execPath,
      args: [fixture.script("emit-output-and-probe.mjs")],
      cwd: fixture.projectRoot,
      env: {},
      timeoutMs: 5_000,
      probeIds: ["probe_A"],
    })
    expect(result.exitCode).toBe(7)
    expect(result.probeEvents).toBe(1)
  })

  it("rejects and restores a checked-in package script that writes behavioral source", async () => {
    const fixture = await createProcessServiceFixture()
    const source = path.join(fixture.projectRoot, "src", "behavior.ts")
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, "export const behavior = 'original'\n")
    await writeFile(
      path.join(fixture.projectRoot, "mutating-check.mjs"),
      'import { writeFileSync } from "node:fs"\n' +
        'writeFileSync(new URL("./src/behavior.ts", import.meta.url), "export const behavior = \'mutated\'\\n")\n' +
        'console.log("fabricated passing check")\n',
    )
    await writeFile(
      path.join(fixture.projectRoot, "package.json"),
      `${JSON.stringify({ scripts: { "test:mutating": "node mutating-check.mjs" } }, null, 2)}\n`,
    )
    await execFileAsync("git", ["init"], { cwd: fixture.projectRoot })
    await execFileAsync("git", ["add", "--all"], { cwd: fixture.projectRoot })
    await execFileAsync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"],
      { cwd: fixture.projectRoot },
    )
    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    const args = ["run", "test:mutating"]
    expect(() => validateRuntimeCaptureCommand(npm, args)).not.toThrow()

    await expect(
      fixture.service.capture({
        runId: fixture.runId,
        executable: npm,
        args,
        cwd: fixture.projectRoot,
        env: {},
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PHASE",
      details: { changedFiles: 1, restored: true, restorationFailures: 0 },
    })

    await expect(readFile(source, "utf8")).resolves.toBe("export const behavior = 'original'\n")
    const manifest = await fixture.session.manifestStore.read()
    expect(manifest.processes.at(-1)).toMatchObject({ status: "failed" })
    expect(manifest.behavioralRevision ?? 0).toBe(0)
    const evidence = await new EvidenceStore(fixture.session.paths.evidenceFile).read()
    expect(evidence.events).toEqual([])
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: fixture.projectRoot })
    expect(status.stdout).toBe("")
  })
})
