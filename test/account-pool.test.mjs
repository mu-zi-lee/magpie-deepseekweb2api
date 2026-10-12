import test from "node:test"
import assert from "node:assert/strict"
import { credentialIssues, createPool, parseKeys } from "../src/account-pool.mjs"

test("parses JSON keys and browser cookie arrays", () => {
  const keys = parseKeys(JSON.stringify([
    { id: "main", userToken: "token-a", cookies: [{ name: "sid", value: "one" }] },
    { id: "backup", userToken: "token-b", cookie: { theme: "dark" } },
  ]))
  const pool = createPool(keys)
  assert.equal(pool.keys[0].cookie, "sid=one")
  assert.equal(pool.keys[1].cookie, "theme=dark")
})

test("binds a Magpie session to one key until it becomes unavailable", () => {
  const pool = createPool('[{"id":"a","userToken":"ta"},{"id":"b","userToken":"tb"}]')
  const first = pool.pick("session-1")
  assert.equal(pool.pick("session-1").id, first.id)
  first.enabled = false
  assert.equal(pool.pick("session-1").id, "b")
})

test("does not split a raw base64 token on padding", () => {
  const pool = createPool("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/==")
  assert.equal(pool.keys.length, 1)
  assert.equal(pool.keys[0].userToken.endsWith("=="), true)
})

test("does not select a key above its concurrency limit", () => {
  const pool = createPool('[{"id":"a","userToken":"ta"}]', { maxConcurrentPerKey: 1 })
  const key = pool.pick("one")
  pool.start(key)
  assert.equal(pool.pick("two"), null)
})

test("does not penalize a key for client cancellation", () => {
  const pool = createPool('[{"id":"a","userToken":"ta"}]')
  const key = pool.keys[0]
  pool.start(key)
  pool.failure(key, Object.assign(new Error("Request cancelled"), { name: "AbortError" }))
  assert.equal(key.failures, 0)
  assert.equal(key.cooldownUntil, 0)
  assert.equal(key.enabled, true)
})

test("diagnoses cookie-only credentials", () => {
  assert.deepEqual(credentialIssues(JSON.stringify([{ cookie: "ds_session_id=x" }])), [{ index: 0, code: "cookie_without_user_token" }])
})

test("rejects duplicate ids and oversized pools", () => {
  assert.throws(() => createPool('[{"id":"same","userToken":"a"},{"id":"same","userToken":"b"}]'), /Duplicate/)
  const many = Array.from({ length: 101 }, (_, index) => ({ id: String(index), userToken: `token-${index}` }))
  assert.throws(() => createPool(many), /100 keys/)
})

test("duplicate tokens cannot multiply one account's concurrency budget", () => {
  assert.throws(() => createPool([{ id: "a", userToken: "same" }, { id: "b", userToken: "same" }]), /Duplicate DeepSeek userToken/)
})

test("accepts a keys wrapper object", () => {
  const pool = createPool(JSON.stringify({ keys: [{ id: "a", userToken: "ta" }] }))
  assert.equal(pool.keys[0].id, "a")
})

test("filters imported cookies to DeepSeek domains", () => {
  const pool = createPool(JSON.stringify({ keys: [{ id: "a", userToken: "ta", cookies: [
    { name: "ok", value: "1", domain: ".deepseek.com" },
    { name: "no", value: "2", domain: ".example.com" },
  ] }] }))
  assert.equal(pool.keys[0].cookie, "ok=1")
})

test("exposes aggregate status without credentials", () => {
  const pool = createPool('[{"id":"a","userToken":"secret"},{"id":"b","userToken":"secret2"}]')
  const status = pool.publicStatus()
  assert.deepEqual(status, { total: 2, enabled: 2, active: 0, coolingDown: 0 })
  assert.equal(JSON.stringify(status).includes("secret"), false)
})

test("serializes work for the same session", async () => {
  const pool = createPool('[{"id":"a","userToken":"secret"}]')
  const order = []
  const first = pool.runExclusive("session", async () => { order.push("start-1"); await new Promise((resolve) => setTimeout(resolve, 10)); order.push("end-1") })
  const second = pool.runExclusive("session", async () => { order.push("start-2") })
  await Promise.all([first, second])
  assert.deepEqual(order, ["start-1", "end-1", "start-2"])
})
