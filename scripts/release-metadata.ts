import { appendFile, readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

export type NpmDistTag = "latest" | "beta" | "next"

export interface ReleaseMetadata {
  version: string
  npmTag: NpmDistTag
  prerelease: boolean
}

const numericIdentifier = "(?:0|[1-9]\\d*)"
const releaseTagPattern = new RegExp(
  `^v(${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-(beta|rc)\\.${numericIdentifier})?)$`,
)
const npmVersionPattern = /^(\d+)\.(\d+)\.(\d+)$/

export function resolveReleaseMetadata(tag: string, packageVersion: string): ReleaseMetadata {
  const match = releaseTagPattern.exec(tag)
  const version = match?.[1]
  const channel = match?.[2]

  if (version === undefined) {
    throw new Error(`Unsupported release tag: ${tag}`)
  }
  if (version !== packageVersion) {
    throw new Error(`Tag version ${version} does not match package.json version ${packageVersion}`)
  }

  const npmTag: NpmDistTag = channel === "beta" ? "beta" : channel === "rc" ? "next" : "latest"
  return { version, npmTag, prerelease: channel !== undefined }
}

export function assertSupportedNpmVersion(version: string): void {
  const match = npmVersionPattern.exec(version)
  if (match === null) {
    throw new Error(`Invalid npm version: ${version}`)
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const supported = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))
  if (!supported) {
    throw new Error(`npm 11.5.1 or newer is required; found ${version}`)
  }
}

interface PackageMetadata {
  name: string
  version: string
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record.name === "string" && typeof record.version === "string"
}

async function emitReleaseMetadata(tag: string, packageJsonPath: string): Promise<void> {
  const packageJson: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"))
  if (!isPackageMetadata(packageJson)) {
    throw new Error(`${packageJsonPath} must contain string name and version fields`)
  }

  const metadata = resolveReleaseMetadata(tag, packageJson.version)
  const output = {
    package_name: packageJson.name,
    version: metadata.version,
    npm_tag: metadata.npmTag,
    prerelease: String(metadata.prerelease),
  }
  const githubOutput = process.env.GITHUB_OUTPUT

  if (githubOutput === undefined) {
    process.stdout.write(`${JSON.stringify(output)}\n`)
    return
  }

  await appendFile(
    githubOutput,
    `${Object.entries(output)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  )
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === "metadata") {
    const tag = process.argv[3]
    if (tag === undefined) {
      throw new Error("Usage: release-metadata.ts metadata <tag> [package.json]")
    }
    await emitReleaseMetadata(tag, process.argv[4] ?? "package.json")
    return
  }
  if (command === "npm-version") {
    const version = process.argv[3]
    if (version === undefined) {
      throw new Error("Usage: release-metadata.ts npm-version <version>")
    }
    assertSupportedNpmVersion(version)
    return
  }
  throw new Error("Usage: release-metadata.ts <metadata|npm-version> ...")
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
