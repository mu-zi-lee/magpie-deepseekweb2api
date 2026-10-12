import test from "node:test"
import assert from "node:assert/strict"
import { createPool } from "../src/account-pool.mjs"

test("account management disables sessions and can re-enable a key", () => {
  const pool = createPool('[{"id":"a","userToken":"secret"},{"id":"b","userToken":"secret2"}]')
  assert.equal(pool.pick("session").id, "a")
  assert.equal(pool.disable("a"), true)
  assert.equal(pool.sessions.has("session"), false)
  assert.equal(pool.pick("session").id, "b")
  assert.equal(pool.enable("a"), true)
  assert.equal(pool.getKey("a").enabled, true)
})
