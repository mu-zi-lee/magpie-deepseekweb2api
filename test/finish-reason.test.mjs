import test from "node:test"
import assert from "node:assert/strict"
import { finishReason } from "../src/openai.mjs"

test("maps DeepSeek terminal statuses to OpenAI finish reasons", () => {
  assert.equal(finishReason("FINISHED"), "stop")
  assert.equal(finishReason("CONTENT_FILTER"), "content_filter")
  assert.equal(finishReason("CONTEXT_LENGTH_EXCEEDED"), "length")
  assert.equal(finishReason("TIMEOUT"), "length")
})
