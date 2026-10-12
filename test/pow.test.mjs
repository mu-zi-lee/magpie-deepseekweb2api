import test from "node:test"
import assert from "node:assert/strict"
import { deepSeekHash } from "../src/pow.mjs"

test("matches DeepSeekHashV1 known vectors", () => {
  assert.equal(deepSeekHash(""), "e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3")
  assert.equal(deepSeekHash("abc"), "f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506")
})
