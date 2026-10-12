import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"

test("early request validation removes its abort listener", async () => {
  const plugin = await server()
  const loaded = await plugin.auth.loader(async () => ({ type: "api", key: JSON.stringify([{ userToken: "secret" }]) }))
  const controller = new AbortController()
  await assert.rejects(() => loaded.fetch("https://chat.deepseek.com/v1/chat/completions", { method: "POST", signal: controller.signal, body: "not-json" }))
  controller.abort()
  assert.equal(controller.signal.aborted, true)
})
