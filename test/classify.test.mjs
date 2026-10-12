import test from "node:test"
import assert from "node:assert/strict"
import { classifyError } from "../src/deepseek-api.mjs"

test("classifies operational errors without exposing credentials", () => {
  assert.equal(classifyError(Object.assign(new Error("no"), { status: 401 })), "auth")
  assert.equal(classifyError(Object.assign(new Error("slow"), { name: "TimeoutError" })), "timeout")
  assert.equal(classifyError(Object.assign(new Error("busy"), { status: 429 })), "rate_limit")
  assert.equal(classifyError(Object.assign(new Error("bad frame"), { retryable: true })), "protocol")
})
