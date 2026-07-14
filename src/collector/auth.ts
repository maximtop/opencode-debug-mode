import { createHash, timingSafeEqual } from "node:crypto"
import type { SecretStore } from "../session/secret-store.js"

const TOKEN = /^[A-Za-z0-9_-]{43}$/

function decode(value: string): Buffer | undefined {
  if (!TOKEN.test(value)) return undefined
  const decoded = Buffer.from(value, "base64url")
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) return undefined
  return decoded
}

export function authenticateBearer(header: string | undefined, expectedToken: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ") || header.indexOf(" ", 7) !== -1) return false
  const provided = decode(header.slice(7))
  const expected = decode(expectedToken)
  if (provided === undefined || expected === undefined) return false
  const providedDigest = createHash("sha256").update(provided).digest()
  const expectedDigest = createHash("sha256").update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

export async function createCollectorCredential(store: SecretStore): Promise<string> {
  return store.create()
}
