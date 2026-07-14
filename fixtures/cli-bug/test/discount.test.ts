import { describe, expect, it } from "vitest"
import { discount } from "../src/discount.js"

describe("discount", () => {
  it("applies the VIP discount by value", () => expect(discount("vip-42")).toBe(20))
})
