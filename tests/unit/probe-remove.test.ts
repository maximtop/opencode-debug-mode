import { createHash } from "node:crypto"
import { readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { removeOwnedProbe } from "../../src/probes/remove.js"
import { markerFileFixture } from "../helpers/factories.js"

describe("owned marker removal", () => {
  it("removes an exact block while preserving edits around it", async () => {
    const fixture = await markerFileFixture({ before: "const before = 2\n", after: "const after = 3\n" })
    const result = await removeOwnedProbe(fixture.manifestProbe)
    expect(result.status, JSON.stringify(result)).toBe("success")
    expect(await fixture.read()).toBe("const before = 2\nconst after = 3\n")
  })

  it("cleans an exact planned marker when instrumentation is interrupted before registration", async () => {
    const fixture = await markerFileFixture({ before: "const before = 2\n" })
    const result = await removeOwnedProbe({ ...fixture.manifestProbe, status: "planned" })
    expect(result.status).toBe("success")
    expect(await fixture.read()).toBe("const before = 2\n")
  })

  it("removes an owned adjacent whitespace separator with the marker", async () => {
    const fixture = await markerFileFixture({ before: "const before = 2\n", after: "const after = 3\n" })
    const originalBlock = fixture.manifestProbe.expectedBlock
    if (originalBlock === undefined) throw new Error("missing fixture block")
    const ownedBlock = `\n${originalBlock}\n`
    await writeFile(fixture.manifestProbe.sourceFile, `const before = 2\n${ownedBlock}const after = 3\n`)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      expectedBlock: ownedBlock,
      expectedHash: createHash("sha256").update(ownedBlock).digest("hex"),
    })

    expect(result.status).toBe("success")
    expect(await fixture.read()).toBe("const before = 2\nconst after = 3\n")
  })

  it("preserves a changed owned block as ambiguous", async () => {
    const fixture = await markerFileFixture({ mutateInsideMarker: true })
    const result = await removeOwnedProbe(fixture.manifestProbe)
    expect(result.status).toBe("failed")
    expect(result.reason).toBe("marker-content-mismatch")
    expect(await fixture.read()).toContain("DEBUG-START")
  })

  it("fails closed when marker comments are removed but unique probe code remains", async () => {
    const fixture = await markerFileFixture({ before: "const before = true\n" })
    const expectedBlock = (fixture.manifestProbe.expectedBlock ?? "").replace("void 0", 'void emit("probe_A")')
    const source = 'const before = true\nvoid emit("probe_A")\n'
    await writeFile(fixture.manifestProbe.sourceFile, source)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      expectedBlock,
      expectedHash: createHash("sha256").update(expectedBlock).digest("hex"),
    })

    expect(result).toMatchObject({ status: "failed", reason: "marker-content-mismatch", line: 2 })
    expect(await fixture.read()).toBe(source)
  })

  it("never follows a source symlink during cleanup", async () => {
    const fixture = await markerFileFixture({})
    const projectRoot = path.dirname(fixture.manifestProbe.sourceFile)
    const target = path.join(projectRoot, "outside-target.ts")
    const ownedContent = fixture.manifestProbe.expectedBlock ?? ""
    await writeFile(target, ownedContent)
    await rm(fixture.manifestProbe.sourceFile)
    await symlink(target, fixture.manifestProbe.sourceFile)

    const result = await removeOwnedProbe(fixture.manifestProbe, projectRoot)

    expect(result).toMatchObject({ status: "failed", reason: "source-path-unsafe" })
    expect(await readFile(target, "utf8")).toBe(ownedContent)
  })

  it("preserves a changed helper import block when its ownership markers remain", async () => {
    const fixture = await markerFileFixture({})
    const originalProbeSource = await fixture.read()
    const helperSourceFile = path.join(path.dirname(fixture.manifestProbe.sourceFile), "background.ts")
    const ownership =
      "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
    const helperImportBlock =
      `/* DEBUG-START ${ownership} */\n` +
      'import { __opencodeDebugEmit as emitProbe } from "./debug-transport.mjs"\n' +
      `/* DEBUG-END ${ownership} */`
    const changedHelperImport = helperImportBlock.replace("emitProbe", "formattedEmitProbe")
    await writeFile(helperSourceFile, `const before = true\n${changedHelperImport}\nconst after = true\n`)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      transport: "extension-background",
      helperSourceFile,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
    })

    expect(result).toMatchObject({
      status: "failed",
      file: helperSourceFile,
      reason: "helper-import-content-mismatch",
      line: 2,
    })
    expect(await readFile(helperSourceFile, "utf8")).toBe(
      `const before = true\n${changedHelperImport}\nconst after = true\n`,
    )
    expect(await fixture.read()).toBe(originalProbeSource)
  })

  it("fails closed when helper markers are removed but the owned import remains", async () => {
    const fixture = await markerFileFixture({})
    const originalProbeSource = await fixture.read()
    const helperSourceFile = path.join(path.dirname(fixture.manifestProbe.sourceFile), "background.ts")
    const ownership =
      "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
    const importStatement = 'import { __opencodeDebugEmit as __opencodeDebugEmit_probe_A } from "./debug-transport.mjs"'
    const helperImportBlock = `/* DEBUG-START ${ownership} */\n${importStatement}\n/* DEBUG-END ${ownership} */`
    const helperSource = `const before = true\n${importStatement}\nconst after = true\n`
    await writeFile(helperSourceFile, helperSource)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      transport: "extension-background",
      helperSourceFile,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
    })

    expect(result).toMatchObject({
      status: "failed",
      file: helperSourceFile,
      reason: "helper-import-content-mismatch",
      line: 2,
    })
    expect(await readFile(helperSourceFile, "utf8")).toBe(helperSource)
    expect(await fixture.read()).toBe(originalProbeSource)
  })

  it("removes an exact helper import block while preserving surrounding source", async () => {
    const fixture = await markerFileFixture({})
    const helperSourceFile = path.join(path.dirname(fixture.manifestProbe.sourceFile), "background.ts")
    const ownership =
      "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
    const helperImportBlock =
      `/* DEBUG-START ${ownership} */\n` +
      'import { __opencodeDebugEmit as emitProbe } from "./debug-transport.mjs"\n' +
      `/* DEBUG-END ${ownership} */`
    await writeFile(helperSourceFile, `const before = true\n${helperImportBlock}\nconst after = true\n`)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      transport: "extension-background",
      helperSourceFile,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
    })

    expect(result).toMatchObject({ status: "success" })
    expect(await readFile(helperSourceFile, "utf8")).toBe("const before = true\n\nconst after = true\n")
    expect(await fixture.read()).toBe("")
  })

  it("removes a same-file marker and helper import together", async () => {
    const fixture = await markerFileFixture({})
    const sourceFile = fixture.manifestProbe.sourceFile
    const ownership =
      "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
    const helperImportBlock =
      `/* DEBUG-START ${ownership} */\n` +
      'import { __opencodeDebugEmit as emitProbe } from "./debug-transport.mjs"\n' +
      `/* DEBUG-END ${ownership} */`
    const probeBlock = fixture.manifestProbe.expectedBlock ?? ""
    await writeFile(sourceFile, `${helperImportBlock}\n${probeBlock}`)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      transport: "extension-background",
      helperSourceFile: sourceFile,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
    })

    expect(result).toMatchObject({ status: "success", file: sourceFile })
    expect(await fixture.read()).toBe("\n")
  })

  it("preserves both same-file blocks when helper import preflight fails", async () => {
    const fixture = await markerFileFixture({})
    const sourceFile = fixture.manifestProbe.sourceFile
    const ownership =
      "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
    const helperImportBlock =
      `/* DEBUG-START ${ownership} */\n` +
      'import { __opencodeDebugEmit as emitProbe } from "./debug-transport.mjs"\n' +
      `/* DEBUG-END ${ownership} */`
    const changedHelperImport = helperImportBlock.replace("emitProbe", "changedEmitProbe")
    const probeBlock = fixture.manifestProbe.expectedBlock ?? ""
    const source = `${changedHelperImport}\n${probeBlock}`
    await writeFile(sourceFile, source)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      transport: "extension-background",
      helperSourceFile: sourceFile,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
    })

    expect(result).toMatchObject({ status: "failed", reason: "helper-import-content-mismatch" })
    expect(await fixture.read()).toBe(source)
  })

  it("preserves a helper import whose owned marker formatting was changed", async () => {
    const fixture = await markerFileFixture({})
    const helperSourceFile = path.join(path.dirname(fixture.manifestProbe.sourceFile), "background.ts")
    const ownership =
      "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
    const helperImportBlock =
      `/* DEBUG-START ${ownership} */\n` +
      'import { __opencodeDebugEmit as emitProbe } from "./debug-transport.mjs"\n' +
      `/* DEBUG-END ${ownership} */`
    const changedHelperImport = helperImportBlock
      .replace("DEBUG-START ", "DEBUG-START  ")
      .replace("DEBUG-END ", "DEBUG-END  ")
    await writeFile(helperSourceFile, changedHelperImport)

    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      transport: "extension-background",
      helperSourceFile,
      helperImportBlock,
      helperImportHash: createHash("sha256").update(helperImportBlock).digest("hex"),
    })

    expect(result).toMatchObject({ status: "failed", reason: "helper-import-content-mismatch" })
    expect(await readFile(helperSourceFile, "utf8")).toBe(changedHelperImport)
  })

  it("fails closed when non-process helper-import ownership is incomplete", async () => {
    const fixture = await markerFileFixture({})
    const result = await removeOwnedProbe({
      ...fixture.manifestProbe,
      transport: "http-web",
    })

    expect(result).toMatchObject({ status: "failed", reason: "helper-import-ownership-incomplete" })
  })

  it("fails closed for missing ownership, ambiguous markers, and missing files", async () => {
    const incomplete = await markerFileFixture({})
    expect(
      await removeOwnedProbe({ ...incomplete.manifestProbe, expectedBlock: undefined, expectedHash: undefined }),
    ).toMatchObject({ status: "failed", reason: "marker-ownership-incomplete" })

    const ambiguous = await markerFileFixture({})
    const original = await ambiguous.read()
    await writeFile(ambiguous.manifestProbe.sourceFile, original + original)
    expect(await removeOwnedProbe(ambiguous.manifestProbe)).toMatchObject({
      status: "failed",
      reason: "marker-ambiguous",
    })

    const missing = await markerFileFixture({})
    await rm(missing.manifestProbe.sourceFile)
    expect(await removeOwnedProbe(missing.manifestProbe)).toMatchObject({ status: "already-clean" })

    const alreadyClean = await markerFileFixture({})
    await writeFile(alreadyClean.manifestProbe.sourceFile, "const preserved = true\n")
    expect(await removeOwnedProbe(alreadyClean.manifestProbe)).toMatchObject({ status: "already-clean" })
  })
})
