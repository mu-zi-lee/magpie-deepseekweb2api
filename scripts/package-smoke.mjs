import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"

const run = promisify(execFile)
const root = fileURLToPath(new URL("../", import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), "deepseek-package-smoke-"))
const originalFetch = globalThis.fetch
try {
  const { stdout } = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: root })
  const [archive] = JSON.parse(stdout)
  assert.ok(archive.filename)
  assert.ok(archive.files.every((file) => /^(src\/|scripts\/|assets\/|README\.md$|LICENSE$|SECURITY\.md$|CHANGELOG\.md$|package\.json$)/.test(file.path)), "unexpected file in release archive")
  await run("tar", ["-xzf", path.join(temporary, archive.filename), "-C", temporary])
  const packageRoot = path.join(temporary, "package")
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
  assert.equal(manifest.magpie.icon, `https://raw.githubusercontent.com/mu-zi-lee/magpie-deepseekweb2api/v${manifest.version}/assets/icon-256.png`, "market icon must point to this release's bundled asset")
  const { default: entry } = await import(pathToFileURL(path.join(packageRoot, manifest.exports["./server"])).href)
  assert.equal(entry.id, "deepseek-web")
  assert.equal(typeof entry.server, "function")
  const { deepSeekHashV1 } = await import(pathToFileURL(path.join(packageRoot, "src/pow.mjs")).href)
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname
    if (route === "/api/v0/users/current") return Response.json({ data: { biz_data: { id: "package-user" } } })
    if (route === "/api/v0/chat_session/create") return Response.json({ data: { biz_data: { id: "package-chat" } } })
    if (route === "/api/v0/chat/create_pow_challenge") return Response.json({ data: { biz_data: { challenge: {
      algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1,
      challenge: deepSeekHashV1("s_1_0"), signature: "package-test",
    } } } })
    assert.equal(route, "/api/v0/chat/completion")
    return new Response('data: {"v":{"response":{"status":"FINISHED","message_id":7,"fragments":[{"type":"RESPONSE","content":"ok"}]}}}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const plugin = await entry.server()
  const icon = await readFile(path.join(packageRoot, "assets/icon-256.png"))
  assert.equal(plugin.auth.icon, `data:image/png;base64,${icon.toString("base64")}`)
  assert.ok(plugin.auth.icon.length <= 3 << 19, "icon exceeds Magpie's size limit")
  const config = {}
  plugin.config(config)
  assert.deepEqual(Object.keys(config.provider["deepseek-web"].models).sort(), ["deepseek-chat", "deepseek-reasoner"])
  const flow = await plugin.auth.methods[0].authorize({ userToken: "package-fake-token", cookie: "" })
  const auth = await flow.callback()
  assert.equal(auth.type, "success")
  const loaded = await plugin.auth.loader(async () => ({ type: "api", key: auth.key }))
  const response = await loaded.fetch("https://test.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: false }),
  })
  assert.equal((await response.json()).choices[0].message.content, "ok")
  console.log(`Package smoke passed: ${archive.files.length} files, exported entry, models, credential import, PoW and completion.`)
} finally {
  globalThis.fetch = originalFetch
  await rm(temporary, { recursive: true, force: true })
}
