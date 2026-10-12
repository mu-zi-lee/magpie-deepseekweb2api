import test from "node:test"
import assert from "node:assert/strict"
import { validateMessages } from "../src/openai.mjs"

test("rejects non-text message parts instead of silently dropping them", () => {
  assert.throws(() => validateMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }]), /text messages only/)
})
