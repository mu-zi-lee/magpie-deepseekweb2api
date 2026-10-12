import test from "node:test"
import assert from "node:assert/strict"
import { server } from "../src/index.mjs"

test("loader rejects empty or malformed pools before serving requests", async () => {
  const plugin = await server()
  await assert.rejects(() => plugin.auth.loader(async () => ({ type: "api", key: "" })), /key pool is empty/)
  await assert.rejects(() => plugin.auth.loader(async () => ({ type: "api", key: JSON.stringify([{ id: "x", userToken: "a" }, { id: "x", userToken: "b" }]) })), /Duplicate/)
  await assert.rejects(() => plugin.auth.loader(async () => ({ key: JSON.stringify([{ userToken: "valid" }, { cookie: "ds_session_id=invalid" }]) })), /Every DeepSeek key/)
})
