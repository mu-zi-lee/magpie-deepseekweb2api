import test from "node:test"
import assert from "node:assert/strict"
import { complete } from "../src/completion.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

test("merges a non-streaming continuation response with existing text", async () => {
  const originalFetch = globalThis.fetch
  let completion = 0
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === "/api/v0/chat_session/create") return new Response(JSON.stringify({ data: { biz_data: { id: "s" } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/create_pow_challenge") return new Response(JSON.stringify({ data: { biz_data: { challenge: { algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1, challenge: deepSeekHashV1("s_1_0"), signature: "x", target_path: "/api/v0/chat/completion" } } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/completion") {
      completion += 1
      return new Response("event: message\ndata: {\"v\":{\"response\":{\"status\":\"INCOMPLETE\",\"message_id\":2,\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"Hello\"}]}}}\n\nevent: close\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/api/v0/chat/continue") return new Response(JSON.stringify({ data: { biz_data: { response: " world" } } }), { headers: { "content-type": "application/json" } })
    throw new Error(`unexpected ${path}`)
  }
  try {
    const iterator = complete({ key: { userToken: "secret" }, modelId: "deepseek-chat", prompt: "hi" })
    let final
    for (;;) { const step = await iterator.next(); if (step.done) break; final = step.value }
    assert.equal(final.text, "Hello world")
    assert.equal(completion, 1)
  } finally { globalThis.fetch = originalFetch }
})
