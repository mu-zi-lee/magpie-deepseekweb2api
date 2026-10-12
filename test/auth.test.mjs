import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"
import { createPool } from "../src/account-pool.mjs"

test("default sign-in accepts separate token and optional Cookie fields", async () => {
  const originalFetch = globalThis.fetch
  const checked = []
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init.headers)
    checked.push({ token: headers.get("authorization"), cookie: headers.get("cookie") })
    return Response.json({ data: { biz_data: { id: "valid" } } })
  }
  try {
    const plugin = await server()
    const method = plugin.auth.methods[0]
    assert.deepEqual(method.prompts.map((prompt) => prompt.key), ["userToken", "cookie"])
    assert.match(method.prompts[0].validate(" "), /required/)
    assert.equal(method.prompts[0].validate("token"), undefined)
    for (const cookie of [" session=a; other=b ", "", undefined]) {
      const flow = await method.authorize({ userToken: " token=with-padding== ", cookie })
      assert.equal(flow.method, "auto")
      const result = await flow.callback()
      assert.equal(result.type, "success")
      assert.equal(result.metadata.keys, result.key)
      const [key] = createPool(result.metadata.keys).keys
      assert.equal(key.userToken, "token=with-padding==")
      assert.equal(key.cookie, cookie?.trim() ?? "")
    }
    assert.deepEqual(checked, [
      { token: "Bearer token=with-padding==", cookie: "session=a; other=b" },
      { token: "Bearer token=with-padding==", cookie: null },
      { token: "Bearer token=with-padding==", cookie: null },
    ])
    const missing = await method.authorize({ userToken: " ", cookie: "session=a" })
    assert.equal((await missing.callback()).type, "failed")
    assert.equal(checked.length, 3)
  } finally { globalThis.fetch = originalFetch }
})

test("separate credential sign-ins keep inputs isolated and reject invalid tokens", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init.headers)
    return headers.get("authorization") === "Bearer good" && headers.get("cookie") === "session=good"
      ? Response.json({ data: { biz_data: { id: "valid" } } })
      : Response.json({}, { status: 401 })
  }
  try {
    const plugin = await server()
    const good = await plugin.auth.methods[0].authorize({ userToken: "good", cookie: "session=good" })
    const bad = await plugin.auth.methods[0].authorize({ userToken: "private-bad", cookie: "session=private-bad" })
    const rejected = await bad.callback()
    assert.equal(rejected.type, "failed")
    assert.equal(rejected.error.includes("private-bad"), false)
    assert.equal((await good.callback()).type, "success")
  } finally { globalThis.fetch = originalFetch }
})

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
    const flow = await plugin.auth.methods[1].authorize()
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
    const flow = await plugin.auth.methods[1].authorize()
    const result = await flow.callback(JSON.stringify([{ userToken: "old", enabled: false }, { userToken: "valid" }]))
    assert.equal(result.type, "success")
    assert.deepEqual(checked, ["Bearer valid"])
    assert.equal(JSON.parse(result.key)[0].enabled, false)
    const none = await flow.callback(JSON.stringify([{ userToken: "old", enabled: false }]))
    assert.equal(none.type, "failed")
    assert.match(none.error, /must be enabled/)
  } finally { globalThis.fetch = originalFetch }
})
