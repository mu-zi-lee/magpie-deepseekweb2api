import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { deepSeekHashV1 } from "../src/pow.mjs"

const hostPath = process.argv[2] ?? process.env.MAGPIE_HOST_PATH
if (!hostPath) throw new Error("Pass the path to Magpie internal/plugin/host.js or set MAGPIE_HOST_PATH")
const pluginPath = fileURLToPath(new URL("../", import.meta.url))
const directory = await mkdtemp(path.join(tmpdir(), "deepseek-magpie-smoke-"))
const requests = []
let chatCounter = 0
const upstream = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    const token = request.headers.authorization?.slice(7)
    requests.push({ path: request.url, token, cookie: request.headers.cookie, body })
    response.setHeader("content-type", "application/json")
    let data
    if (request.url === "/api/v0/users/current") data = { id: "fake-user" }
    else if (request.url === "/api/v0/chat_session/create") {
      if (token === "fake-token-a") { response.writeHead(401); response.end("{}"); return }
      assert.equal(token, "fake-token-b")
      data = { id: `chat-${++chatCounter}` }
    } else if (request.url === "/api/v0/chat/create_pow_challenge") {
      data = { challenge: { algorithm: "DeepSeekHashV1", salt: "s", expire_at: 1, difficulty: 1, challenge: deepSeekHashV1("s_1_0"), signature: "fake", target_path: body.target_path } }
    } else if (request.url === "/api/v0/chat/completion") {
      assert.equal(token, "fake-token-b")
      assert.ok(request.headers["x-ds-pow-response"])
      response.setHeader("content-type", "text/event-stream")
      response.end(`data: ${JSON.stringify({ v: { response: { status: "FINISHED", message_id: 7, fragments: [{ type: "RESPONSE", content: "ok" }] } } })}\r\n\r\nevent: close\r\ndata: {}\r\n\r\n`)
      return
    } else throw new Error(`Unexpected upstream path: ${request.url}`)
    response.end(JSON.stringify({ data: { biz_code: 0, biz_data: data } }))
  } catch {
    response.writeHead(500)
    response.end("{}")
  }
})
upstream.listen(0, "127.0.0.1")
await once(upstream, "listening")
const origin = `http://127.0.0.1:${upstream.address().port}`
const child = spawn(process.env.BUN_BIN ?? "bun", [path.resolve(hostPath)], {
  env: { ...process.env, DEEPSEEK_WEB_ORIGIN: origin },
  stdio: ["pipe", "pipe", "pipe"],
})
const calls = new Map()
let nextId = 1
let stderr = ""
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000) })
const output = readline.createInterface({ input: child.stdout })
output.on("line", (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const call = calls.get(message.id)
  if (!call) return
  if (message.event === "head") call.status = message.status
  else if (message.event === "chunk") {
    call.chunks.push(Buffer.from(message.data, "base64"))
    child.stdin.write(JSON.stringify({ method: "credit", params: { id: message.id, n: Buffer.byteLength(message.data, "base64") + 2048 } }) + "\n")
  } else if ("result" in message || message.error) {
    calls.delete(message.id)
    clearTimeout(call.timeout)
    if (message.error) call.reject(new Error(message.error.message))
    else call.resolve(call.stream ? { status: call.status, body: Buffer.concat(call.chunks).toString() } : message.result)
  }
})
function failCalls(error) {
  for (const call of calls.values()) { clearTimeout(call.timeout); call.reject(error) }
  calls.clear()
}
child.on("error", failCalls)
child.on("exit", (code) => failCalls(new Error(`Magpie host exited (${code}): ${stderr}`)))
function rpc(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      calls.delete(id)
      child.stdin.write(JSON.stringify({ method: "abort", params: { id } }) + "\n")
      reject(new Error(`Magpie host timed out in ${method}`))
    }, 15_000)
    calls.set(id, { resolve, reject, timeout, stream: method === "fetch", chunks: [] })
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  })
}
try {
  const init = await rpc("init", { authPath: path.join(directory, "auth.json"), directory, plugins: [{ spec: "deepseek-web-smoke", target: pluginPath }] })
  assert.equal(init.plugins[0].error, undefined, init.plugins[0].error)
  assert.deepEqual(init.plugins[0].provides, ["deepseek-web"])
  const providers = await rpc("providers")
  assert.match(providers[0].icon, /^data:image\/png;base64,/)
  assert.equal(providers[0].methods[0].type, "oauth")
  assert.deepEqual(providers[0].models.map((model) => model.id).sort(), ["deepseek-chat", "deepseek-reasoner"])
  const signIn = { provider: "deepseek-web", method: 0 }
  const tokenPrompt = await rpc("prompt", { ...signIn, inputs: {} })
  assert.equal(tokenPrompt.prompt.key, "userToken")
  const invalidToken = await rpc("validate", { ...signIn, key: "userToken", value: " " })
  assert.match(invalidToken.error, /required/)
  const cookiePrompt = await rpc("prompt", { ...signIn, inputs: { userToken: "fake-token-b" } })
  assert.equal(cookiePrompt.prompt.key, "cookie")
  let account
  for (const cookie of ["session=fake", ""]) {
    const inputs = { userToken: "fake-token-b", cookie }
    assert.equal((await rpc("prompt", { ...signIn, inputs })).prompt, null)
    const singleFlow = await rpc("authorize", { ...signIn, inputs, account })
    assert.equal(singleFlow.method, "auto")
    assert.equal(singleFlow.url, "")
    const singleLogin = await rpc("callback", { session: singleFlow.session })
    assert.equal(singleLogin.ok, true)
    account = singleLogin.account
    assert.equal(requests.at(-1).token, "fake-token-b")
    assert.equal(requests.at(-1).cookie ?? "", cookie)
    const singleLoaded = await rpc("load", { provider: "deepseek-web" })
    assert.equal(singleLoaded.fetch, true)
    assert.match(JSON.stringify(await rpc("usage", { provider: "deepseek-web" })), /1 keys/)
  }
  const flow = await rpc("authorize", { provider: "deepseek-web", method: 1, account })
  assert.equal(flow.method, "code")
  const login = await rpc("callback", { session: flow.session, code: JSON.stringify([{ id: "a", userToken: "fake-token-a" }, { id: "b", userToken: "fake-token-b" }]) })
  assert.equal(login.ok, true)
  const loaded = await rpc("load", { provider: "deepseek-web" })
  assert.equal(loaded.fetch, true)
  assert.equal(loaded.apiKey, "deepseek-web-local")
  assert.equal(loaded.baseURL, origin)
  for (const stream of [false, true]) {
    const result = await rpc("fetch", {
      provider: "deepseek-web", model: "deepseek-chat", npm: "@ai-sdk/openai-compatible",
      url: `${origin}/v1/chat/completions`, method: "POST", session: "host-session", window: 1 << 20,
      body: Buffer.from(JSON.stringify({
        model: "deepseek-chat",
        messages: stream ? [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }] : [{ role: "user", content: "hi" }],
        stream, search_enabled: false,
      })).toString("base64"),
    })
    assert.equal(result.status, 200)
    if (stream) { assert.match(result.body, /"content":"ok"/); assert.match(result.body, /data: \[DONE\]/) }
    else assert.equal(JSON.parse(result.body).choices[0].message.content, "ok")
    await rpc("reload", { provider: "deepseek-web" })
  }
  const completions = requests.filter((request) => request.path === "/api/v0/chat/completion")
  assert.equal(chatCounter, 1, "host reload must preserve sticky sessions")
  assert.equal(completions[1].body.parent_message_id, 7)
  assert.equal(completions[1].body.prompt, "next", "full history must not be replayed into an existing chat")
  const usage = await rpc("usage", { provider: "deepseek-web" })
  assert.match(JSON.stringify(usage), /1 disabled/)
  assert.equal(requests.filter((request) => request.path === "/api/v0/chat_session/create" && request.token === "fake-token-a").length, 1, "host reload must preserve account health")
  console.log("Magpie host smoke passed: plugin load, credential import, models, PoW, failover, JSON, SSE, session reuse and health across reload.")
} finally {
  child.stdin.end()
  if (child.exitCode === null && child.signalCode === null) {
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000)
    await once(child, "exit").catch(() => {})
    clearTimeout(killTimer)
  }
  output.close()
  upstream.closeAllConnections()
  await new Promise((resolve) => upstream.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
