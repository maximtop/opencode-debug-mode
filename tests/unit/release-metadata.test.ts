import { describe, expect, it } from "vitest"
import { assertSupportedNpmVersion, resolveReleaseMetadata } from "../../scripts/release-metadata.js"

describe("release metadata", () => {
  it.each([
    ["v1.2.3", "latest", false],
    ["v1.2.3-beta.4", "beta", true],
    ["v1.2.3-rc.5", "next", true],
  ] as const)("maps %s to npm tag %s", (tag, npmTag, prerelease) => {
    expect(resolveReleaseMetadata(tag, tag.slice(1))).toEqual({
      version: tag.slice(1),
      npmTag,
      prerelease,
    })
  })

  it("requires the tag version to match package.json exactly", () => {
    expect(() => resolveReleaseMetadata("v1.2.3", "1.2.4")).toThrow(
      "Tag version 1.2.3 does not match package.json version 1.2.4",
    )
  })

  it.each([
    "1.2.3",
    "v1.2",
    "v1.2.3-alpha.1",
    "v1.2.3-beta",
    "v01.2.3",
    "v1.2.3-rc.01",
  ])("rejects unsupported or malformed tag %s", (tag) => {
    expect(() => resolveReleaseMetadata(tag, tag.replace(/^v/, ""))).toThrow(`Unsupported release tag: ${tag}`)
  })
})

describe("npm CLI version", () => {
  it.each(["11.5.1", "11.6.0", "12.0.0"])("accepts npm %s", (version) => {
    expect(() => assertSupportedNpmVersion(version)).not.toThrow()
  })

  it.each(["11.5.0", "10.9.9"])("rejects npm %s", (version) => {
    expect(() => assertSupportedNpmVersion(version)).toThrow(`npm 11.5.1 or newer is required; found ${version}`)
  })

  it("rejects a malformed npm version", () => {
    expect(() => assertSupportedNpmVersion("11.5")).toThrow("Invalid npm version: 11.5")
  })
})
