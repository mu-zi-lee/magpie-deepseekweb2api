import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

test("provider loader converts an OpenAI request into a DeepSeek web request", async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    requests.push({ path, headers: new Headers(init.headers), body: init.body })
    if (path === "/api/v0/chat_session/create") return new Response(JSON.stringify({ data: { biz_data: { id: "session-1" } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/create_pow_challenge") return new Response(JSON.stringify({ data: { biz_data: { challenge: { algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1, challenge: deepSeekHashV1("s_1_0"), signature: "sig", target_path: "/api/v0/chat/completion" } } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/completion") return new Response("event: message\ndata: {\"v\":{\"response\":{\"status\":\"FINISHED\",\"message_id\":2,\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"ok\"}]}}}\n\nevent: close\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })
    throw new Error(`unexpected path ${path}`)
  }
  try {
    const plugin = await server()
    const loaded = await plugin.auth.loader(async () => ({ type: "api", key: JSON.stringify([{ id: "a", userToken: "secret" }]) }))
    const response = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", { method: "POST", headers: { "x-magpie-session": "magpie-1" }, body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: false }) })
    const body = await response.json()
    assert.equal(body.choices[0].message.content, "ok")
    assert.equal(requests.some((request) => request.path === "/api/v0/chat/completion"), true)
    assert.equal(requests.find((request) => request.path === "/api/v0/chat/completion").headers.get("authorization"), "Bearer secret")
  } finally { globalThis.fetch = originalFetch }
})
