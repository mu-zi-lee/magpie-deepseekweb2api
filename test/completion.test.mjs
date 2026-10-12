import test from "node:test"
import assert from "node:assert/strict"
import { complete } from "../src/completion.mjs"
import { deepSeekHash, solvePow } from "../src/pow.mjs"

test("solves a challenge and resumes an incomplete stream", async () => {
  const originalFetch = globalThis.fetch
  const key = { userToken: "test-token" }
  const salt = "salt"
  const expireAt = 123
  const challenge = (targetPath) => ({ algorithm: "DeepSeekHashV1", salt, expire_at: expireAt, difficulty: 2, challenge: deepSeekHash(`${salt}_${expireAt}_1`), signature: "sig", target_path: targetPath })
  const sse = (frames) => new Response(`event: message\ndata: ${JSON.stringify(frames[0])}\n\nevent: close\ndata: {}\n\n`, { headers: { "content-type": "text/event-stream" } })
  let completionCalls = 0
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path === "/api/v0/chat_session/create") return new Response(JSON.stringify({ data: { biz_data: { id: "chat-1" } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/create_pow_challenge") return new Response(JSON.stringify({ data: { biz_data: { challenge: challenge(init.body && JSON.parse(init.body).target_path) } } }), { headers: { "content-type": "application/json" } })
    if (path === "/api/v0/chat/completion") {
      completionCalls += 1
      return sse([{ v: { response: { message_id: 7, status: "INCOMPLETE", fragments: [{ type: "RESPONSE", content: "Hello" }] } } }])
    }
    if (path === "/api/v0/chat/continue") return sse([{ v: { response: { message_id: 8, status: "FINISHED", fragments: [{ type: "RESPONSE", content: "Hello world" }] } } }])
    throw new Error(`unexpected ${path}`)
  }
  try {
    const iterator = complete({ key, modelId: "deepseek-chat", prompt: "Hi" })
    let last
    let finalState
    for (;;) {
      const step = await iterator.next()
      if (step.done) { last = step.value; break }
      finalState = step.value
    }
    assert.equal(finalState.text, "Hello world")
    assert.equal(completionCalls, 1)
    assert.equal(solvePow({ ...challenge("/api/v0/chat/completion"), expireAt }, undefined), 1)
  } finally { globalThis.fetch = originalFetch }
})
