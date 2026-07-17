import assert from "node:assert/strict"
import test from "node:test"
import { isBetaEnabled } from "../src/feature-flags.mjs"

test("loads beta flags for account identifiers containing slashes", async () => {
  assert.equal(await isBetaEnabled("team/acme"), true)
})
