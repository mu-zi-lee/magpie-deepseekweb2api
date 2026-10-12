import test from "node:test"
import assert from "node:assert/strict"
import { PatchState, sseFrames } from "../src/stream.mjs"
import { LIMITS } from "../src/config.mjs"
import { createPool } from "../src/account-pool.mjs"
import { complete } from "../src/completion.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

test("parses CRLF frames across chunk boundaries and preserves data whitespace", async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const text of ["event: message\r", "\ndata:   hello\r\n\r", "\nevent: close\r\ndata: {}\r\n\r\n"]) controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  const frames = []
  for await (const frame of sseFrames(body)) frames.push(frame)
  assert.deepEqual(frames, [{ event: "message", data: "  hello" }, { event: "close", data: "{}" }])
})

test("closing the SSE iterator cancels the upstream reader", async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: {}\n\n")) },
    cancel() { cancelled = true },
  })
  for await (const frame of sseFrames(body)) { assert.equal(frame.data, "{}"); break }
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})

test("rejects oversized frames and cancels the reader", async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: " + "x".repeat(1_048_577))) },
    cancel() { cancelled = true },
  })
  await assert.rejects(async () => { for await (const frame of sseFrames(body)) void frame }, /size limit/)
  assert.equal(cancelled, true)
})

test("explicit cancellation with a custom reason does not cool down an account", () => {
  const pool = createPool([{ userToken: "test" }])
  const key = pool.pick()
  pool.start(key)
  pool.failure(key, new Error("User navigated away"), { cancelled: true })
  assert.equal(key.active, 0)
  assert.equal(key.failures, 0)
  assert.equal(key.cooldownUntil, 0)
})

test("partial text followed by EOF is a protocol failure", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("create_pow_challenge")) {
      return new Response(JSON.stringify({ data: { biz_data: { challenge: { algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1, challenge: deepSeekHashV1("s_1_0"), signature: "sig" } } } }))
    }
    return new Response(
      'data: {"v":{"response":{"status":"GENERATING","message_id":2,"fragments":[{"type":"RESPONSE","content":"partial"}]}}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  try {
    const iterator = complete({ key: { userToken: "test" }, modelId: "deepseek-chat", prompt: "hi", sessionId: "existing", origin: "https://test.invalid" })
    await assert.rejects(async () => { for await (const state of iterator) assert.equal(state.text, "partial") }, /terminal status/)
  } finally { globalThis.fetch = originalFetch }
})

test("cancellation interrupts a stalled SSE reader with its original reason", async () => {
  let cancelled = false
  const controller = new AbortController()
  const reason = new Error("Stop reading")
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const iterator = sseFrames(body, { signal: controller.signal })
  const pending = assert.rejects(iterator.next(), (error) => error === reason)
  controller.abort(reason)
  await pending
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})

test("the output limit includes both answer and reasoning across continuations", () => {
  const state = new PatchState({ baselineText: "x".repeat(LIMITS.maxOutputCharacters - 1), baselineReasoning: "r" })
  assert.throws(() => state.apply({ v: "x" }), /response exceeds size limit/)
  assert.equal(state.text.length + state.reasoning.length, LIMITS.maxOutputCharacters)
})
