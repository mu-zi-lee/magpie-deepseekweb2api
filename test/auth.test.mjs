import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"

test("authorization validates the complete key pool without leaking credentials", async () => {
  const originalFetch = globalThis.fetch
  const accepted = new Set(["good-a", "good-b"])
  globalThis.fetch = async (_url, init = {}) => {
    const token = new Headers(init.headers).get("authorization")?.slice(7)
    return accepted.has(token)
      ? new Response(JSON.stringify({ data: { biz_data: { user: { id: token } } } }), { headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ code: 401 }), { status: 401, headers: { "content-type": "application/json" } })
  }
  try {
    const plugin = await server()
    const flow = await plugin.auth.methods[0].authorize()
    assert.equal(flow.method, "code")
    const result = await flow.callback(JSON.stringify([{ id: "a", userToken: "good-a" }, { id: "b", userToken: "bad-b" }]))
    assert.equal(result.type, "failed")
    assert.match(result.error, /1 of 2/)
    assert.equal(result.error.includes("bad-b"), false)
  } finally { globalThis.fetch = originalFetch }
})

test("disabled expired credentials can be retained without blocking import", async () => {
  const originalFetch = globalThis.fetch
  const checked = []
  globalThis.fetch = async (_url, init) => {
    const token = new Headers(init.headers).get("authorization")
    checked.push(token)
    return Response.json({ data: { biz_data: { id: "valid" } } })
  }
  try {
    const plugin = await server()
    const flow = await plugin.auth.methods[0].authorize()
    const result = await flow.callback(JSON.stringify([{ userToken: "old", enabled: false }, { userToken: "valid" }]))
    assert.equal(result.type, "success")
    assert.deepEqual(checked, ["Bearer valid"])
    assert.equal(JSON.parse(result.key)[0].enabled, false)
    const none = await flow.callback(JSON.stringify([{ userToken: "old", enabled: false }]))
    assert.equal(none.type, "failed")
    assert.match(none.error, /must be enabled/)
  } finally { globalThis.fetch = originalFetch }
})
