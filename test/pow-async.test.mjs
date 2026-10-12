import test from "node:test"
import assert from "node:assert/strict"
import { deepSeekHashV1, solvePow, solvePowAsync } from "../src/pow.mjs"

function challenge(nonce, difficulty = nonce + 1) {
  return { algorithm: "DeepSeekHashV1", salt: "s", expireAt: 1, difficulty, challenge: deepSeekHashV1(`s_1_${nonce}`) }
}

test("asynchronous PoW matches the synchronous solver across batches", async () => {
  const input = challenge(20)
  assert.equal(await solvePowAsync(input, { tick: 4 }), solvePow(input))
})

test("PoW lets timers cancel a running search with the original reason", async () => {
  const controller = new AbortController()
  const reason = new Error("User left")
  const timer = setTimeout(() => controller.abort(reason), 0)
  try {
    await assert.rejects(solvePowAsync(challenge(10_000), { signal: controller.signal, tick: 4 }), (error) => error === reason)
  } finally { clearTimeout(timer) }
})

test("PoW enforces a deadline during computation", async () => {
  await assert.rejects(solvePowAsync(challenge(10_000), { timeoutMs: 1, tick: 4 }), { name: "TimeoutError" })
})

test("PoW respects cancellation before starting and bounds batch size", async () => {
  const reason = new Error("Already cancelled")
  await assert.rejects(solvePowAsync(challenge(0), AbortSignal.abort(reason)), (error) => error === reason)
  await assert.rejects(solvePowAsync(challenge(0), { tick: 0 }), /positive whole number/)
  await assert.rejects(solvePowAsync(challenge(0), { tick: 2048 }), /cannot exceed/)
})
