import test from "node:test"
import assert from "node:assert/strict"
import { readEnvelope } from "../src/deepseek-api.mjs"

test("recognizes auth expiry even when the upstream body is not JSON", async () => {
  await assert.rejects(() => readEnvelope(new Response("not-json", { status: 401 }), "current user"), (error) => error.signIn === "expired")
})
