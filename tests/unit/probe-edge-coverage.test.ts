import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  addLoopbackPermission,
  type PermissionChange,
  removeLoopbackPermission,
} from "../../src/probes/extension-permissions.js"
import { ProbeRegistry } from "../../src/probes/registry.js"
import { removeOwnedProbe } from "../../src/probes/remove.js"
import {
  createCanonicalProjectFile,
  ProjectFileRewriteRollbackError,
  rewriteCanonicalProjectFile,
} from "../../src/probes/source-safety.js"
import type { ProbePlanInput } from "../../src/probes/types.js"
import { createInitialManifest, ManifestStore } from "../../src/session/manifest-store.js"
import type { ManifestProbe } from "../../src/session/types.js"
import { extensionManifestFixture, markerFileFixture } from "../helpers/factories.js"
import { type TempProject, withTempProject } from "../helpers/temp-project.js"

const fingerprintA = "a".repeat(64)
const fingerprintB = "b".repeat(64)

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function processPlan(overrides: Partial<ProbePlanInput> = {}): ProbePlanInput {
  return {
    runId: "run_A",
    hypothesisId: "hyp_A",
    sourceFile: "source.ts",
    sourceLine: 1,
    message: "edge coverage",
    captures: [],
    transport: "process",
    sampling: { mode: "every", n: 1 },
    ...overrides,
  }
}

async function registryHarness(paths: TempProject["paths"], withHelper = false) {
  const source = path.join(paths.projectRoot, "source.ts")
  const helper = path.join(paths.projectRoot, "debug-transport.mjs")
  const sourceText = "export const value = 1\n"
  const helperText = "export function __opencodeDebugEmit() {}\n"
  await writeFile(source, sourceText)
  if (withHelper) await writeFile(helper, helperText)

  const store = new ManifestStore(paths.manifestFile)
  const initial = createInitialManifest({
    sessionId: "session_A",
    trustedSessionHash: fingerprintA,
    projectRoot: paths.projectRoot,
    sessionDir: paths.sessionDir,
    now: "2026-07-13T00:00:00.000Z",
  })
  await store.create({
    ...initial,
    runs: [
      {
        id: "run_A",
        label: "pre-fix",
        reproduction: "test",
        status: "running",
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    ],
    ownedFiles: withHelper
      ? [{ path: helper, sha256: sha256(helperText), bytes: Buffer.byteLength(helperText), kind: "transport-helper" }]
      : [],
  })

  let fingerprint = fingerprintA
  return {
    source,
    sourceText,
    store,
    registry: new ProbeRegistry(store, paths.projectRoot, async () => fingerprint),
    setFingerprint: (value: string) => {
      fingerprint = value
    },
  }
}

function helperOwnershipBlock(
  importStatement = 'import { __opencodeDebugEmit as emitProbe } from "./debug-transport.mjs"',
) {
  const ownership =
    "opencode-debug-mode session=session_A run=run_A hypothesis=hyp_A probe=probe_A resource=transport-import"
  return `/* DEBUG-START ${ownership} */\n${importStatement}\n/* DEBUG-END ${ownership} */`
}

function withHelperOwnership(probe: ManifestProbe, helperSourceFile: string, helperImportBlock: string): ManifestProbe {
  return {
    ...probe,
    transport: "extension-background",
    helperSourceFile,
    helperImportBlock,
    helperImportHash: sha256(helperImportBlock),
  }
}

describe("probe edge coverage", () => {
  it("fails closed for missing manifests and creates an absent permission property", async () => {
    const missing = await extensionManifestFixture({ manifestVersion: 3 })
    await rm(missing.path)
    await expect(addLoopbackPermission(missing.root, missing.path, missing.matchPattern)).rejects.toMatchObject({
      code: "PERMISSION_MISMATCH",
    })
    const missingChange: PermissionChange = {
      manifestPath: missing.path,
      property: "host_permissions",
      matchPattern: missing.matchPattern,
      addedBySession: true,
    }
    await expect(removeLoopbackPermission(missing.root, missing.path, missingChange)).resolves.toEqual({
      status: "already-clean",
    })

    const absentProperty = await extensionManifestFixture({ manifestVersion: 3 })
    await writeFile(absentProperty.path, '{"manifest_version":3,"name":"Fixture","version":"1"}\n')
    const added = await addLoopbackPermission(absentProperty.root, absentProperty.path, absentProperty.matchPattern)
    expect(added).toMatchObject({ property: "host_permissions", addedBySession: true })
    expect(JSON.parse(await absentProperty.read())).toMatchObject({ host_permissions: [absentProperty.matchPattern] })

    await writeFile(absentProperty.path, '{"manifest_version":3,"name":"Fixture","version":"1"}\n')
    await expect(removeLoopbackPermission(absentProperty.root, absentProperty.path, added)).resolves.toEqual({
      status: "already-clean",
    })
  })

  it("rejects non-object manifests and preserves a concurrent permission edit", async () => {
    const fixture = await extensionManifestFixture({ manifestVersion: 3 })
    for (const invalid of ["null\n", "[]\n", "42\n"]) {
      await writeFile(fixture.path, invalid)
      await expect(addLoopbackPermission(fixture.root, fixture.path, fixture.matchPattern)).rejects.toMatchObject({
        code: "PERMISSION_MISMATCH",
      })
    }

    await writeFile(
      fixture.path,
      `${JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", host_permissions: [] })}\n`,
    )
    const concurrent = `${JSON.stringify({
      manifest_version: 3,
      name: "Fixture",
      version: "1",
      description: "concurrent edit",
      host_permissions: [],
    })}\n`
    await expect(
      addLoopbackPermission(fixture.root, fixture.path, fixture.matchPattern, () => {
        writeFileSync(fixture.path, concurrent)
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_MISMATCH" })
    await expect(fixture.read()).resolves.toBe(concurrent)
  })

  it("handles missing, unsafe, and already-clean helper imports without touching unowned source", async () => {
    const missing = await markerFileFixture({})
    const missingHelper = path.join(path.dirname(missing.manifestProbe.sourceFile), "missing-background.ts")
    const block = helperOwnershipBlock()
    await expect(
      removeOwnedProbe(withHelperOwnership(missing.manifestProbe, missingHelper, block)),
    ).resolves.toMatchObject({ status: "success" })
    await expect(missing.read()).resolves.toBe("")

    const unsafe = await markerFileFixture({})
    const unsafeRoot = path.dirname(unsafe.manifestProbe.sourceFile)
    const unsafeHelper = path.join(unsafeRoot, "background.ts")
    const target = path.join(unsafeRoot, "background-target.ts")
    await writeFile(target, block)
    await symlink(target, unsafeHelper)
    await expect(
      removeOwnedProbe(withHelperOwnership(unsafe.manifestProbe, unsafeHelper, block)),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "helper-import-path-unsafe",
    })
    await expect(unsafe.read()).resolves.toContain("DEBUG-START")

    const alreadyClean = await markerFileFixture({})
    const cleanHelper = path.join(path.dirname(alreadyClean.manifestProbe.sourceFile), "background.ts")
    const unowned = "export const userOwned = true\n"
    await writeFile(cleanHelper, unowned)
    await expect(
      removeOwnedProbe(withHelperOwnership(alreadyClean.manifestProbe, cleanHelper, block)),
    ).resolves.toMatchObject({ status: "success" })
    await expect(readFile(cleanHelper, "utf8")).resolves.toBe(unowned)
  })

  it("detects specifier-only helper remnants and malformed helper ownership", async () => {
    const remnant = await markerFileFixture({})
    const helperSource = path.join(path.dirname(remnant.manifestProbe.sourceFile), "background.ts")
    const importStatement = 'import defaultTransport from "./debug-transport.mjs"'
    const block = helperOwnershipBlock(importStatement)
    await writeFile(helperSource, `${importStatement}\n`)
    await expect(
      removeOwnedProbe(withHelperOwnership(remnant.manifestProbe, helperSource, block)),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "helper-import-content-mismatch",
      line: 1,
    })

    const malformed = await markerFileFixture({})
    const malformedHelper = path.join(path.dirname(malformed.manifestProbe.sourceFile), "background.ts")
    await expect(
      removeOwnedProbe(withHelperOwnership(malformed.manifestProbe, malformedHelper, "import './transport.mjs'")),
    ).resolves.toMatchObject({ status: "failed", reason: "helper-import-ownership-incomplete" })
  })

  it("rejects invalid transport helper plans and planning inside owned instrumentation", () =>
    withTempProject(async ({ paths }) => {
      const withoutHelper = await registryHarness(paths)
      await expect(
        withoutHelper.registry.plan(processPlan({ helperSourceFile: "background.ts" })),
      ).rejects.toMatchObject({ code: "STATE_INVALID" })
      await expect(
        withoutHelper.registry.plan(processPlan({ transport: "extension-background" })),
      ).rejects.toMatchObject({ code: "COLLECTOR_REQUIRED" })
    }))

  it("rejects unsafe helper paths, unsupported helper modules, and nested owned locations", () =>
    withTempProject(async ({ paths }) => {
      const harness = await registryHarness(paths, true)
      await expect(
        harness.registry.plan(processPlan({ transport: "extension-content", helperSourceFile: "../outside.ts" })),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })

      await writeFile(path.join(paths.projectRoot, "background.py"), "loaded = True\n")
      await expect(
        harness.registry.plan(processPlan({ transport: "extension-content", helperSourceFile: "background.py" })),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_LANGUAGE" })

      const first = await harness.registry.plan(processPlan())
      await writeFile(harness.source, `${first.markerBlock}\n${harness.sourceText}`)
      await expect(harness.registry.plan(processPlan({ hypothesisId: "hyp_B", sourceLine: 2 }))).rejects.toMatchObject({
        code: "MARKER_MISMATCH",
      })
    }))

  it("rejects unknown, incomplete, and hypothesis-stale probe registration", () =>
    withTempProject(async ({ paths }) => {
      const harness = await registryHarness(paths)
      await expect(harness.registry.register("probe_missing")).rejects.toMatchObject({ code: "MARKER_MISSING" })

      const incomplete = await harness.registry.plan(processPlan())
      await harness.store.modify((manifest) => ({
        ...manifest,
        probes: manifest.probes.map((probe) =>
          probe.id === incomplete.id ? { ...probe, expectedBlock: undefined } : probe,
        ),
      }))
      await expect(harness.registry.register(incomplete.id)).rejects.toMatchObject({ code: "MARKER_MISMATCH" })

      const stale = await harness.registry.plan(processPlan({ hypothesisId: "hyp_B" }))
      harness.setFingerprint(fingerprintB)
      await expect(harness.registry.register(stale.id)).rejects.toMatchObject({ code: "STATE_INVALID" })
    }))

  it("rejects incomplete and malformed helper registration metadata", () =>
    withTempProject(async ({ paths }) => {
      const harness = await registryHarness(paths)
      const probe = await harness.registry.plan(processPlan())
      await writeFile(harness.source, `${probe.markerBlock}\n${harness.sourceText}`)
      await harness.store.modify((manifest) => ({
        ...manifest,
        probes: manifest.probes.map((candidate) =>
          candidate.id === probe.id ? { ...candidate, helperSourceFile: harness.source } : candidate,
        ),
      }))
      await expect(harness.registry.register(probe.id)).rejects.toMatchObject({ code: "MARKER_MISMATCH" })

      const malformedHelper = 'import "./debug-transport.mjs"'
      await writeFile(harness.source, `${malformedHelper}\n${probe.markerBlock}\n${harness.sourceText}`)
      await harness.store.modify((manifest) => ({
        ...manifest,
        probes: manifest.probes.map((candidate) =>
          candidate.id === probe.id
            ? {
                ...candidate,
                helperSourceFile: harness.source,
                helperImportBlock: malformedHelper,
                helperImportHash: sha256(malformedHelper),
              }
            : candidate,
        ),
      }))
      await expect(harness.registry.register(probe.id)).rejects.toMatchObject({ code: "MARKER_MISMATCH" })
    }))

  it("rejects incomplete helper validation and events for a changed hypothesis", () =>
    withTempProject(async ({ paths }) => {
      const harness = await registryHarness(paths)
      const probe = await harness.registry.plan(processPlan())
      await writeFile(harness.source, `${probe.markerBlock}\n${harness.sourceText}`)
      await harness.registry.register(probe.id)

      await harness.store.modify((manifest) => ({
        ...manifest,
        probes: manifest.probes.map((candidate) =>
          candidate.id === probe.id ? { ...candidate, expectedBlock: undefined } : candidate,
        ),
      }))
      await expect(harness.registry.validate([probe.id])).rejects.toMatchObject({ code: "MARKER_MISMATCH" })

      await harness.store.modify((manifest) => ({
        ...manifest,
        probes: manifest.probes.map((candidate) =>
          candidate.id === probe.id
            ? { ...candidate, expectedBlock: probe.expectedBlock, helperSourceFile: harness.source }
            : candidate,
        ),
      }))
      await expect(harness.registry.validate([probe.id])).rejects.toMatchObject({ code: "MARKER_MISMATCH" })

      await harness.store.modify((manifest) => ({
        ...manifest,
        probes: manifest.probes.map((candidate) =>
          candidate.id === probe.id
            ? { ...candidate, helperSourceFile: undefined, status: "registered", validationStatus: "pending" }
            : candidate,
        ),
      }))
      await harness.registry.validate([probe.id])
      harness.setFingerprint(fingerprintB)
      await expect(
        harness.registry.validateEvent({
          schemaVersion: 1,
          sessionId: "session_A",
          runId: "run_A",
          runLabel: "pre-fix",
          hypothesisId: "hyp_A",
          probeId: probe.id,
          timestamp: "2026-07-13T00:00:01.000Z",
          message: "event",
          source: { file: "untrusted.ts", line: 99 },
          data: {},
        }),
      ).rejects.toMatchObject({ code: "STATE_INVALID" })
    }))

  it("closes pinned roots on invalid create and rewrite paths", () =>
    withTempProject(async ({ root, paths }) => {
      const outside = path.join(root, "outside.ts")
      await expect(createCanonicalProjectFile(paths.projectRoot, outside, "owned\n")).rejects.toMatchObject({
        code: "HELPER_PATH_UNSAFE",
      })

      const missing = path.join(paths.projectRoot, "missing.ts")
      await expect(rewriteCanonicalProjectFile(paths.projectRoot, missing, "old\n", "new\n")).rejects.toMatchObject({
        code: "HELPER_PATH_UNSAFE",
      })

      const rootFile = path.join(root, "project-file")
      await writeFile(rootFile, "not a directory\n")
      await expect(
        createCanonicalProjectFile(rootFile, path.join(rootFile, "child.ts"), "owned\n"),
      ).rejects.toMatchObject({ code: "HELPER_PATH_UNSAFE" })
    }))

  it("describes rewrite residue ownership both with and without a residue path", () => {
    const withoutResidue = new ProjectFileRewriteRollbackError("/project/source.ts")
    expect(withoutResidue).toMatchObject({
      filename: "/project/source.ts",
      action: expect.stringContaining("Inspect /project/source.ts"),
      details: { path: "/project/source.ts" },
    })

    const withResidue = new ProjectFileRewriteRollbackError("/project/source.ts", "/project/.rewrite-backup")
    expect(withResidue).toMatchObject({
      action: expect.stringContaining("/project/.rewrite-backup"),
      details: { path: "/project/source.ts", residuePath: "/project/.rewrite-backup" },
    })
  })
})
