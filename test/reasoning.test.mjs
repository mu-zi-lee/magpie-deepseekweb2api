import test from "node:test"
import assert from "node:assert/strict"
import { complete } from "../src/completion.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

test("completion accepts an explicit thinking override", async () => {
  const originalFetch = globalThis.fetch
  let payload
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === "/api/v0/chat_session/create") return new Response(JSON.stringify({ data: { biz_data: { id: "s" } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/create_pow_challenge") return new Response(JSON.stringify({ data: { biz_data: { challenge: { algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1, challenge: deepSeekHashV1("s_1_0"), signature: "x", target_path: "/api/v0/chat/completion" } } } }), { headers: { "content-type": "application/json" } })
    payload = JSON.parse(init.body)
    return new Response(JSON.stringify({ data: { biz_data: { response: "ok" } } }), { headers: { "content-type": "application/json" } })
  }
  try { const iterator = complete({ key: { userToken: "secret" }, modelId: "deepseek-chat", prompt: "hi", thinking: true }); await iterator.next(); assert.equal(payload.thinking_enabled, true) } finally { globalThis.fetch = originalFetch }
})
