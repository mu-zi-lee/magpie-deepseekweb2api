import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"

test("authorization validates keys with bounded concurrency", async () => {
  const originalFetch = globalThis.fetch
  let active = 0
  let peak = 0
  globalThis.fetch = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    return new Response(JSON.stringify({ data: { biz_data: { user: { id: "ok" } } } }), { headers: { "content-type": "application/json" } })
  }
  try {
    const plugin = await server()
    const keys = Array.from({ length: 12 }, (_, index) => ({ id: String(index), userToken: `token-${index}` }))
    const flow = await plugin.auth.methods[0].authorize()
    const result = await flow.callback(JSON.stringify(keys))
    assert.equal(result.type, "success")
    assert.ok(peak <= 4)
  } finally { globalThis.fetch = originalFetch }
})
