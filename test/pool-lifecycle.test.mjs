import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

test("reloading credentials preserves failover health and session state", async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    const token = new Headers(init.headers).get("authorization")?.slice(7)
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ path, token, body })
    if (path === "/api/v0/chat_session/create") {
      if (token === "expired") return new Response("{}", { status: 401 })
      return Response.json({ data: { biz_data: { id: "sticky-chat" } } })
    }
    if (path === "/api/v0/chat/create_pow_challenge") return Response.json({ data: { biz_data: { challenge: {
      algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1,
      challenge: deepSeekHashV1("s_1_0"), signature: "fake",
    } } } })
    return new Response('data: {"v":{"response":{"status":"FINISHED","message_id":7,"fragments":[{"type":"RESPONSE","content":"ok"}]}}}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const plugin = await server()
    const keys = [{ id: "a", userToken: "expired" }, { id: "b", userToken: "valid" }]
    const getAuth = async () => ({ key: JSON.stringify(keys) })
    const first = await plugin.auth.loader(getAuth)
    const request = () => ({ method: "POST", headers: { "x-magpie-session": "one" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: false }) })
    await (await first.fetch("https://test.invalid/v1/chat/completions", request())).json()
    const second = await plugin.auth.loader(async () => ({ metadata: { keys } }))
    assert.equal(second.apiKey, "deepseek-web-local")
    await (await second.fetch("https://test.invalid/v1/chat/completions", request())).json()
    assert.equal(requests.filter((request) => request.path === "/api/v0/chat_session/create").length, 2)
    assert.deepEqual(requests.filter((request) => request.path === "/api/v0/chat/completion").map((request) => request.body.parent_message_id), [null, 7])
    const usage = await plugin.auth.usage(getAuth)
    assert.match(usage.user, /1 disabled/)
    assert.match(usage.user, /0 active/)
  } finally { globalThis.fetch = originalFetch }
})

test("usage can report configured keys before any request loads the pool", async () => {
  const plugin = await server()
  const usage = await plugin.auth.usage(async () => ({ key: JSON.stringify([{ userToken: "secret" }, { userToken: "secret2", enabled: false }]) }))
  assert.match(usage.user, /2 keys/)
  assert.match(usage.user, /1 disabled/)
  assert.equal(JSON.stringify(usage).includes("secret"), false)
})
