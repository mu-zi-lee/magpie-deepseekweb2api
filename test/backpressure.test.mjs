import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
const credentials = JSON.stringify([{ userToken: "fake-token" }])

async function slowOutput(run) {
  const originalFetch = globalThis.fetch
  let produced = 0
  let cancelled = false
  let upstreamSignal
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === "/api/v0/chat_session/create") return Response.json({ data: { biz_data: { id: "s" } } })
    if (path === "/api/v0/chat/create_pow_challenge") return Response.json({ data: { biz_data: { challenge: {
      algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1,
      challenge: deepSeekHashV1("s_1_0"), signature: "fake",
    } } } })
    upstreamSignal = init.signal
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      pull(controller) {
        produced++
        const frame = produced === 1
          ? { v: { response: { status: "WIP", message_id: 2, fragments: [{ type: "RESPONSE", content: "start" }] } } }
          : { v: "x".repeat(1024) }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      },
      cancel() { cancelled = true },
    }), { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const plugin = await server()
    const getAuth = async () => ({ key: credentials })
    const loaded = await plugin.auth.loader(getAuth)
    const controller = new AbortController()
    const response = await loaded.fetch("https://test.invalid/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    await nextTurn()
    await nextTurn()
    try { await run({ plugin, response, controller, getAuth, state: () => ({ produced, cancelled, upstreamSignal }) }) }
    finally { if (!cancelled) await response.body.cancel().catch(() => {}) }
  } finally { globalThis.fetch = originalFetch }
}

test("an unread response bounds upstream reads and reader cancellation releases the key", async () => {
  await slowOutput(async ({ plugin, response, getAuth, state }) => {
    const paused = state().produced
    assert.ok(paused > 1 && paused < 200, `unexpected buffered frame count: ${paused}`)
    await nextTurn()
    assert.equal(state().produced, paused)
    assert.match((await plugin.auth.usage(getAuth)).user, /1 active/)
    await response.body.cancel("Client stopped reading")
    await nextTurn()
    assert.equal(state().cancelled, true)
    assert.equal(state().upstreamSignal.aborted, true)
    const usage = await plugin.auth.usage(getAuth)
    assert.match(usage.user, /0 active/)
    assert.match(usage.user, /0 cooling down/)
    assert.match(usage.user, /0 disabled/)
  })
})

test("request cancellation unblocks an output writer waiting for a slow reader", async () => {
  await slowOutput(async ({ plugin, response, controller, getAuth, state }) => {
    const reason = new Error("User navigated away")
    controller.abort(reason)
    await assert.rejects(response.text(), (error) => error === reason)
    await nextTurn()
    assert.equal(state().cancelled, true)
    assert.match((await plugin.auth.usage(getAuth)).user, /0 active/)
    assert.match((await plugin.auth.usage(getAuth)).user, /0 cooling down/)
  })
})
