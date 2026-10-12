import test from "node:test"
import assert from "node:assert/strict"
import { retryAfterMs } from "../src/deepseek-api.mjs"

test("parses Retry-After seconds and dates with a bounded delay", () => {
  assert.equal(retryAfterMs("5"), 5000)
  assert.equal(retryAfterMs("999999"), 600000)
  const now = Date.parse("2026-01-01T00:00:00Z")
  assert.equal(retryAfterMs("Wed, 01 Jan 2026 00:00:10 GMT", now), 10000)
})
