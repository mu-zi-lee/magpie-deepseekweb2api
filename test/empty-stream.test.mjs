import test from "node:test"
import assert from "node:assert/strict"
import { complete } from "../src/completion.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

test("rejects an empty upstream stream", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path === "/api/v0/chat_session/create") return new Response(JSON.stringify({ data: { biz_data: { id: "s" } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/create_pow_challenge") return new Response(JSON.stringify({ data: { biz_data: { challenge: { algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1, challenge: deepSeekHashV1("s_1_0"), signature: "x", target_path: "/api/v0/chat/completion" } } } }), { headers: { "content-type": "application/json" } })
    return new Response("event: close\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const iterator = complete({ key: { userToken: "secret" }, modelId: "deepseek-chat", prompt: "hi" })
    await assert.rejects(async () => { for (;;) { const step = await iterator.next(); if (step.done) break } }, /empty stream/)
  } finally { globalThis.fetch = originalFetch }
})
