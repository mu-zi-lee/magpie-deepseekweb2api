import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

test("aborting the client request aborts the upstream fetch", async () => {
  const originalFetch = globalThis.fetch
  let upstreamSignal
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === "/api/v0/chat_session/create") return new Response(JSON.stringify({ data: { biz_data: { id: "s" } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/create_pow_challenge") return new Response(JSON.stringify({ data: { biz_data: { challenge: { algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1, challenge: deepSeekHashV1("s_1_0"), signature: "x", target_path: "/api/v0/chat/completion" } } } }), { headers: { "content-type": "application/json" } })
    upstreamSignal = init.signal
    return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const plugin = await server()
    const loaded = await plugin.auth.loader(async () => ({ type: "api", key: JSON.stringify([{ userToken: "secret" }]) }))
    const controller = new AbortController()
    const response = await loaded.fetch("https://chat.deepseek.com/v1/chat/completions", { method: "POST", signal: controller.signal, body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }) })
    const reader = response.body.getReader()
    const pending = reader.read()
    const rejected = assert.rejects(pending, { name: "AbortError" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(upstreamSignal.aborted, true)
    await rejected
    reader.releaseLock()
    await new Promise((resolve) => setImmediate(resolve))
    const usage = await plugin.auth.usage(async () => ({ key: JSON.stringify([{ userToken: "secret" }]) }))
    assert.match(usage.user, /0 active/)
    assert.match(usage.user, /0 cooling down/)
  } finally { globalThis.fetch = originalFetch }
})
