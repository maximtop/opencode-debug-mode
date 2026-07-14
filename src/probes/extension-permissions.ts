import { readFile, writeFile } from "node:fs/promises"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import type { z } from "zod"
import { DebugModeError } from "../core/errors.js"
import type { PermissionChangeSchema } from "../session/types.js"

export type PermissionChange = z.infer<typeof PermissionChangeSchema>

const LOOPBACK_MATCH = /^http:\/\/(?:127\.0\.0\.1:\d{1,5}|\[::1\]:\d{1,5})\/\*$/u
const formatting = { tabSize: 2, insertSpaces: true, eol: "\n" }

function readManifest(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DebugModeError("PERMISSION_MISMATCH", "Extension manifest is invalid")
  }
  return value as Record<string, unknown>
}

function permissionProperty(manifest: Record<string, unknown>): "permissions" | "host_permissions" {
  if (manifest.manifest_version === 2) return "permissions"
  if (manifest.manifest_version === 3) return "host_permissions"
  throw new DebugModeError("PERMISSION_MISMATCH", "Extension manifest version must be 2 or 3")
}

export async function addLoopbackPermission(manifestPath: string, matchPattern: string): Promise<PermissionChange> {
  if (!LOOPBACK_MATCH.test(matchPattern)) {
    throw new DebugModeError("PERMISSION_MISMATCH", "Only an exact active loopback match pattern is allowed")
  }
  const text = await readFile(manifestPath, "utf8")
  const manifest = readManifest(text)
  const property = permissionProperty(manifest)
  const current = manifest[property]
  if (current !== undefined && (!Array.isArray(current) || current.some((entry) => typeof entry !== "string"))) {
    throw new DebugModeError("PERMISSION_MISMATCH", `Extension ${property} must be a string array`)
  }
  const permissions = (current ?? []) as string[]
  if (permissions.includes(matchPattern)) {
    return { manifestPath, property, matchPattern, addedBySession: false }
  }
  const edits = Array.isArray(current)
    ? modify(text, [property, permissions.length], matchPattern, {
        formattingOptions: formatting,
        isArrayInsertion: true,
      })
    : modify(text, [property], [matchPattern], { formattingOptions: formatting })
  await writeFile(manifestPath, applyEdits(text, edits), "utf8")
  return { manifestPath, property, matchPattern, addedBySession: true }
}

export async function removeLoopbackPermission(
  manifestPath: string,
  change: PermissionChange,
): Promise<{ status: "success" | "already-clean" | "failed"; reason?: string }> {
  if (!change.addedBySession) return { status: "already-clean" }
  let text: string
  try {
    text = await readFile(manifestPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "already-clean" }
    return { status: "failed", reason: "manifest-read-failed" }
  }
  let manifest: Record<string, unknown>
  try {
    manifest = readManifest(text)
  } catch {
    return { status: "failed", reason: "manifest-invalid" }
  }
  if (permissionProperty(manifest) !== change.property) return { status: "failed", reason: "manifest-version-changed" }
  const current = manifest[change.property]
  if (current === undefined) return { status: "already-clean" }
  if (!Array.isArray(current) || current.some((entry) => typeof entry !== "string")) {
    return { status: "failed", reason: "permission-structure-changed" }
  }
  const matches = current.flatMap((entry, index) => (entry === change.matchPattern ? [index] : []))
  if (matches.length === 0) return { status: "already-clean" }
  if (matches.length !== 1) return { status: "failed", reason: "permission-ambiguous" }
  const index = matches[0]
  if (index === undefined) return { status: "already-clean" }
  const edits = modify(text, [change.property, index], undefined, { formattingOptions: formatting })
  await writeFile(manifestPath, applyEdits(text, edits), "utf8")
  return { status: "success" }
}
