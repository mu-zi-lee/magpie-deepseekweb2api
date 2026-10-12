import test from "node:test"
import assert from "node:assert/strict"
import { createPool } from "../src/account-pool.mjs"

test("a cancelled queued session does not start its task", async () => {
  const pool = createPool('[{"id":"a","userToken":"secret"}]')
  const first = pool.runExclusive("session", async () => new Promise((resolve) => setTimeout(resolve, 20)))
  const controller = new AbortController()
  const second = pool.runExclusive("session", async () => { throw new Error("should not run") }, controller.signal)
  controller.abort()
  await assert.rejects(second)
  await first
  assert.equal(pool.locks.has("session"), false)
  let ran = false
  await pool.runExclusive("session", async () => { ran = true })
  assert.equal(ran, true)
})

test("does not start a task cancelled immediately after queue release", async () => {
  const pool = createPool('[{"id":"a","userToken":"secret"}]')
  let releaseFirst
  const first = pool.runExclusive("session", () => new Promise((resolve) => { releaseFirst = resolve }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const controller = new AbortController()
  let ran = false
  const second = pool.runExclusive("session", async () => { ran = true }, controller.signal)
  releaseFirst()
  controller.abort()
  await first
  await assert.rejects(second)
  assert.equal(ran, false)
})
