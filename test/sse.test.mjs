import test from "node:test"
import assert from "node:assert/strict"
import { sseFrames } from "../src/stream.mjs"

test("reads a final SSE frame without a trailing blank line", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: close\ndata: {\"ok\":true}"))
      controller.close()
    },
  })
  const frames = []
  for await (const frame of sseFrames(body)) frames.push(frame)
  assert.deepEqual(frames, [{ event: "close", data: '{"ok":true}' }])
})
