import test from "node:test"
import assert from "node:assert/strict"
import { completedHistory, planConversation } from "../src/conversation.mjs"
import { messageText, toPrompt, validateMessages } from "../src/openai.mjs"
import { server } from "../src/index.mjs"
import { deepSeekHashV1 } from "../src/pow.mjs"

const firstMessages = [{ role: "system", content: "be precise" }, { role: "user", content: "first" }]
const nextMessages = [...firstMessages, { role: "assistant", content: "answer" }, { role: "user", content: "next" }]
const bound = { deepseekSessionId: "chat", parentMessageId: 7, ...completedHistory(planConversation(firstMessages, null), "answer") }

test("matching full history sends only new messages to the existing parent", () => {
  const plan = planConversation(nextMessages, bound)
  assert.equal(plan.prompt, "next")
  assert.equal(plan.sessionId, "chat")
  assert.equal(plan.parentMessageId, 7)
  assert.equal(plan.historyLength, 4)
})

test("editing history or instructions rebuilds the conversation", () => {
  for (const messages of [
    [{ role: "system", content: "new instructions" }, ...nextMessages.slice(1)],
    [...nextMessages.slice(0, 2), { role: "assistant", content: "edited" }, nextMessages[3]],
  ]) {
    const plan = planConversation(messages, bound)
    assert.equal(plan.sessionId, undefined)
    assert.equal(plan.parentMessageId, undefined)
    assert.equal(plan.prompt, toPrompt(messages))
  }
})

test("delta-only clients can append a single user turn", () => {
  const plan = planConversation([{ role: "user", content: "next" }], bound)
  assert.equal(plan.sessionId, "chat")
  assert.equal(plan.prompt, "next")
  assert.equal(plan.historyLength, 4)
})

test("reasoning metadata and equivalent text parts do not reset history", () => {
  const messages = [
    firstMessages[0], firstMessages[1],
    { role: "assistant", content: [{ type: "text", text: "answer" }], reasoning_content: "private reasoning" },
    nextMessages[3],
  ]
  assert.equal(planConversation(messages, bound).sessionId, "chat")
  assert.equal(messageText({ content: ["a", { type: "text", text: "b" }] }), "ab")
})

test("history state stores a fixed-size digest rather than conversation text", () => {
  const state = completedHistory(planConversation(firstMessages, null), "secret conversation text")
  assert.equal(state.historyHash.length, 64)
  assert.equal(state.historyLength, 3)
  assert.equal(JSON.stringify(state).includes("secret conversation text"), false)
})

test("message validation rejects malformed entries and preserves tool-only history", () => {
  for (const message of [null, { role: "unknown", content: "x" }, { role: "user", content: 42 }, { role: "user", content: [{ type: "text", text: 42 }] }]) {
    assert.throws(() => validateMessages([message]))
  }
  const messages = [{ role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }] }]
  validateMessages(messages)
  assert.match(toPrompt(messages), /lookup/)
})

test("delta-only failover requires full history and replacement account reconstructs it", async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let rejectFirst = false
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    const token = new Headers(init.headers).get("authorization")?.slice(7)
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ path, token, body })
    if (path === "/api/v0/chat_session/create") return Response.json({ data: { biz_data: { id: `chat-${token}` } } })
    if (path === "/api/v0/chat/create_pow_challenge") return Response.json({ data: { biz_data: { challenge: {
      algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1,
      challenge: deepSeekHashV1("s_1_0"), signature: "fake",
    } } } })
    if (rejectFirst && token === "a") return new Response("{}", { status: 401 })
    return new Response('data: {"v":{"response":{"status":"FINISHED","message_id":7,"fragments":[{"type":"RESPONSE","content":"answer"}]}}}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const plugin = await server()
    const loaded = await plugin.auth.loader(async () => ({ key: JSON.stringify([{ id: "a", userToken: "a" }, { id: "b", userToken: "b" }]) }))
    const send = (messages) => loaded.fetch("https://test.invalid/v1/chat/completions", { method: "POST", headers: { "x-magpie-session": "one" }, body: JSON.stringify({ messages, stream: false }) })
    await (await send(firstMessages)).json()
    rejectFirst = true
    await assert.rejects(send([{ role: "user", content: "next" }]), /complete conversation history/)
    assert.equal(requests.some((request) => request.path === "/api/v0/chat/completion" && request.token === "b"), false)
    assert.equal((await (await send(nextMessages)).json()).choices[0].message.content, "answer")
    const completions = requests.filter((request) => request.path === "/api/v0/chat/completion")
    assert.deepEqual(completions.map((request) => request.token), ["a", "a", "b"])
    assert.equal(completions[1].body.prompt, "next")
    assert.equal(completions[1].body.parent_message_id, 7)
    assert.equal(completions[2].body.prompt, toPrompt(nextMessages))
    assert.equal(completions[2].body.parent_message_id, null)
    assert.equal(completions[2].body.chat_session_id, "chat-b")
  } finally { globalThis.fetch = originalFetch }
})
