import test from "node:test"
import assert from "node:assert/strict"
import { safeErrorMessage } from "../src/deepseek-api.mjs"

test("redacts credentials and bounds upstream error messages", () => {
  const token = "A".repeat(64)
  const message = safeErrorMessage(`Bearer ${token} cookie=session=${token}; ${token}`)
  assert.equal(message.includes(token), false)
  assert.equal(message.includes("Bearer [redacted]"), true)
  assert.ok(message.length <= 500)
})
