import test from "node:test"
import assert from "node:assert/strict"
import { readEnvelope } from "../src/deepseek-api.mjs"

test("preserves retry metadata for non-JSON rate-limit responses", async () => {
  await assert.rejects(
    () => readEnvelope(new Response("busy", { status: 429, headers: { "retry-after": "7" } }), "completion"),
    (error) => error.status === 429 && error.retryAfterMs === 7000,
  )
})
