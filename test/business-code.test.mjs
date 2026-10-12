import test from "node:test"
import assert from "node:assert/strict"
import { readEnvelope } from "../src/deepseek-api.mjs"

test("preserves string business codes and recognizes string 429", async () => {
  await assert.rejects(
    () => readEnvelope(new Response(JSON.stringify({ data: { biz_code: "429", biz_msg: "busy" } }), { headers: { "content-type": "application/json" } }), "completion"),
    (error) => error.bizCode === "429" && error.status === 429,
  )
})
