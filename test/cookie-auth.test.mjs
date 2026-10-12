import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"

test("authorization explains that Cookie alone is insufficient", async () => {
  const plugin = await server()
  const flow = await plugin.auth.methods[1].authorize()
  const result = await flow.callback(JSON.stringify([{ id: "cookie", cookie: "ds_session_id=x" }]))
  assert.equal(result.type, "failed")
  assert.match(result.error, /userToken/)
})
