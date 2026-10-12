import test from "node:test"
import assert from "node:assert/strict"
import { PatchState } from "../src/stream.mjs"

test("folds full response, bare append, reasoning, and status patches", () => {
  const state = new PatchState()
  state.apply({ v: { response: { message_id: 7, fragments: [{ type: "RESPONSE", content: "Hel" }, { type: "THINKING", content: "plan" }] } } })
  state.apply({ p: "response/fragments/0/content", o: "APPEND", v: "lo" })
  state.apply({ p: "response/status", o: "SET", v: "FINISHED" })
  assert.equal(state.text, "Hello")
  assert.equal(state.reasoning, "plan")
  assert.equal(state.messageId, 7)
  assert.equal(state.status, "FINISHED")
})

test("routes compressed Reasoner deltas and fragment appends to separate channels", () => {
  const state = new PatchState()
  state.apply({ v: { response: { status: "WIP", message_id: 2, fragments: [{ type: "THINK", content: "Think" }] } } })
  state.apply({ p: "response/fragments/-1/content", o: "APPEND", v: " carefully" })
  state.apply({ v: "." })
  state.apply({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "39" }] })
  state.apply({ v: "1" })
  state.apply({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", o: "SET", v: 30 }, { p: "response/status", o: "SET", v: "FINISHED" }] })
  assert.equal(state.reasoning, "Think carefully.")
  assert.equal(state.text, "391")
  assert.equal(state.usage, 30)
  assert.equal(state.status, "FINISHED")
})

test("cumulative snapshots after deltas do not duplicate either channel", () => {
  const state = new PatchState()
  state.apply({ v: { response: { fragments: [{ type: "THINK", content: "plan" }] } } })
  state.apply({ v: " ahead" })
  state.apply({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "ok" }] })
  state.apply({ v: { response: { fragments: [{ type: "THINK", content: "plan ahead" }, { type: "RESPONSE", content: "okay" }] } } })
  assert.equal(state.reasoning, "plan ahead")
  assert.equal(state.text, "okay")
})

test("continuation snapshots deduplicate baselines for both fragment types", () => {
  const state = new PatchState({ baselineReasoning: "plan", baselineText: "Hello" })
  state.apply({ v: { response: { fragments: [{ type: "THINK", content: "plan ahead" }, { type: "RESPONSE", content: "Hello world" }] } } })
  assert.equal(state.reasoning, "plan ahead")
  assert.equal(state.text, "Hello world")
})

test("does not duplicate cumulative response fragments", () => {
  const state = new PatchState()
  state.apply({ v: { response: { fragments: [{ type: "RESPONSE", content: "Hel" }] } } })
  state.apply({ v: { response: { fragments: [{ type: "RESPONSE", content: "Hello" }] } } })
  assert.equal(state.text, "Hello")
})
