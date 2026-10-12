import { LIMITS, PROVIDER, NAME, ORIGIN, providerModels, MODELS } from "./config.mjs"
import { credentialIssues, createPool, parseKeys } from "./account-pool.mjs"
import { classifyError, currentUser, safeErrorMessage } from "./deepseek-api.mjs"
import { complete } from "./completion.mjs"
import { chunk, finishReason, toPrompt, validateMessages } from "./openai.mjs"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { completedHistory, planConversation } from "./conversation.mjs"

const icon = `data:image/png;base64,${readFileSync(new URL("../assets/icon-256.png", import.meta.url)).toString("base64")}`

function authKeys(auth) {
  const raw = auth?.metadata?.keys ?? auth?.keys ?? auth?.key ?? auth?.access ?? ""
  return parseKeys(raw)
}

function authFingerprint(auth) {
  return createHash("sha256").update(JSON.stringify(authKeys(auth))).digest("hex")
}

async function verifyKeys(input) {
  const value = String(input ?? "").trim()
  if (!value) return { type: "failed", error: "At least one DeepSeek userToken is required" }
  let pool
  try { pool = createPool(value, { maxConcurrentPerKey: 2 }) }
  catch (error) { return { type: "failed", error: error.message } }
  const credentialErrors = credentialIssues(value)
  if (credentialErrors.length) {
    const cookieOnly = credentialErrors.filter((issue) => issue.code === "cookie_without_user_token").length
    return { type: "failed", error: cookieOnly ? `${cookieOnly} key(s) contain Cookie data but no userToken; DeepSeek Web requires userToken` : "Every key must contain a userToken" }
  }
  if (!pool.keys.length) return { type: "failed", error: "No valid keys found" }
  const results = []
  const enabled = pool.keys.filter((key) => key.enabled)
  if (!enabled.length) return { type: "failed", error: "At least one DeepSeek key must be enabled" }
  const queue = [...enabled.entries()]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try { await currentUser(ORIGIN, item[1]); results[item[0]] = true } catch { results[item[0]] = false }
    }
  })
  await Promise.all(workers)
  const valid = results.filter(Boolean).length
  if (valid !== results.length) return { type: "failed", error: `${valid} of ${results.length} DeepSeek keys were accepted; fix rejected keys and try again` }
  return { type: "success", key: value, accountId: "deepseek-web-pool", metadata: { keys: value } }
}

export const server = async () => {
  const pools = new Map()
  const retiredPools = new FinalizationRegistry((fingerprint) => {
    if (!pools.get(fingerprint)?.deref()) pools.delete(fingerprint)
  })
  const config = { name: NAME, npm: "@ai-sdk/openai-compatible", api: ORIGIN, models: providerModels() }
  return {
    config(cfg) { cfg.provider ??= {}; cfg.provider[PROVIDER] ??= config },
    async "chat.headers"(input, output) {
      if (input?.model?.providerID === PROVIDER && input.sessionID) output.headers["x-magpie-session"] = input.sessionID
    },
    auth: {
      provider: PROVIDER,
      icon,
      methods: [{
        type: "oauth",
        label: "Sign in with userToken and Cookie",
        prompts: [{
          type: "text",
          key: "userToken",
          message: "DeepSeek userToken",
          placeholder: "userToken",
          validate: (value) => String(value ?? "").trim() ? undefined : "userToken is required",
        }, {
          type: "text",
          key: "cookie",
          message: "DeepSeek Cookie (optional)",
          placeholder: "session=...; ... (leave blank to skip)",
        }],
        async authorize(inputs = {}) {
          const userToken = String(inputs.userToken ?? "").trim()
          const cookie = String(inputs.cookie ?? "").trim()
          return {
            url: "",
            method: "auto",
            instructions: "",
            callback: () => userToken
              ? verifyKeys(JSON.stringify([{ userToken, cookie }]))
              : Promise.resolve({ type: "failed", error: "userToken is required" }),
          }
        },
      }, {
        type: "oauth",
        label: "Import DeepSeek Web keys",
        async authorize() {
          return {
            url: "",
            method: "code",
            instructions: 'Paste a userToken or a compact JSON key pool: [{"id":"main","userToken":"...","cookie":"..."}]. Cookie is optional.',
            callback: verifyKeys,
          }
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth()
        const fingerprint = authFingerprint(auth)
        let pool = pools.get(fingerprint)?.deref()
        if (!pool) {
          try {
            const keys = authKeys(auth)
            if (credentialIssues(keys).length) throw new Error("Every DeepSeek key must contain a userToken")
            pool = createPool(keys, { maxConcurrentPerKey: 2 })
          }
          catch (error) { throw new Error(`DeepSeek key pool configuration is invalid: ${error.message}`) }
          if (!pool.keys.length) throw new Error("DeepSeek key pool is empty; sign in with at least one userToken")
          pools.set(fingerprint, new WeakRef(pool))
          retiredPools.register(pool, fingerprint)
        }
        return {
          baseURL: ORIGIN,
          // The stored key is a pool configuration, not an upstream API key.
          apiKey: "deepseek-web-local",
          async fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init)
            const requestAbort = new AbortController()
            const abortRequest = () => requestAbort.abort(request.signal.reason ?? new Error("Request cancelled"))
            if (request.signal.aborted) abortRequest()
            else request.signal.addEventListener("abort", abortRequest, { once: true })
            const cleanupAbort = () => request.signal.removeEventListener("abort", abortRequest)
            const invalidRequest = (message) => { cleanupAbort(); throw new Error(message) }
            let body
            try { body = await request.json() } catch { return invalidRequest("DeepSeek expects a JSON chat completion request") }
            if (!body || typeof body !== "object" || Array.isArray(body)) return invalidRequest("DeepSeek expects a JSON chat completion object")
            const modelId = body.model ?? "deepseek-chat"
            if (!MODELS[modelId]) return invalidRequest(`DeepSeek unknown model ${modelId}`)
            if (!Array.isArray(body.messages) || body.messages.length === 0) return invalidRequest("DeepSeek requires at least one message")
            if (body.messages.length > LIMITS.maxMessages) return invalidRequest(`DeepSeek accepts at most ${LIMITS.maxMessages} messages`)
            if (Array.isArray(body.tools) && body.tools.length) return invalidRequest("DeepSeek Web provider does not support tool definitions in this release")
            try { validateMessages(body.messages) } catch (error) { return invalidRequest(error.message) }
            const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
            const created = Math.floor(Date.now() / 1000)
            const sessionId = request.headers.get("x-magpie-session") || null
            const fullPrompt = toPrompt(body.messages)
            if (!fullPrompt.trim()) return invalidRequest("DeepSeek requires non-empty text or tool history")
            if (fullPrompt.length > LIMITS.maxPromptCharacters) return invalidRequest("DeepSeek prompt is too large")
            const encoder = new TextEncoder()
            const execute = async (emit, { canRetry = () => true } = {}) => {
              let lastError = null
              const originalConversation = sessionId ? pool.sessions.get(sessionId) : null
              for (let attempt = 0; attempt < 2; attempt++) {
                const key = pool.pick(sessionId)
                if (!key) throw lastError ?? new Error("No healthy DeepSeek keys available")
                const bound = pool.sessions.get(sessionId)
                const useState = bound?.keyId === key.id ? bound : null
                if (originalConversation?.historyHash && originalConversation.keyId !== key.id
                  && body.messages.length === 1 && body.messages[0].role === "user") {
                  pool.sessions.set(sessionId, originalConversation)
                  const error = new Error("DeepSeek account changed; resend the complete conversation history")
                  error.status = 409
                  throw error
                }
                const plan = planConversation(body.messages, useState, fullPrompt)
                pool.start(key)
                let state = null
                let replyText = ""
                try {
                  const reasoningEffort = body.reasoning_effort
                  const thinking = reasoningEffort === "none" ? false : reasoningEffort ? true : undefined
                  const iterator = complete({ key, modelId, prompt: plan.prompt, sessionId: plan.sessionId, parentMessageId: plan.parentMessageId, signal: requestAbort.signal, search: body.search_enabled !== false, thinking })
                  try {
                    for (;;) {
                      const step = await iterator.next()
                      if (step.done) { state = step.value; break }
                      replyText = step.value.text
                      await emit(step.value)
                    }
                  } finally { await iterator.return() }
                  if (sessionId && state?.sessionId) pool.sessions.set(sessionId, { keyId: key.id, deepseekSessionId: state.sessionId, parentMessageId: state.messageId, ...completedHistory(plan, replyText), updatedAt: Date.now() })
                  pool.success(key)
                  return
                } catch (error) {
                  lastError = error
                  pool.failure(key, error, { cancelled: requestAbort.signal.aborted })
                  if (sessionId) pool.forgetSession(sessionId)
                  if (requestAbort.signal.aborted || attempt === 1 || !canRetry()) throw error
                }
              }
            }

            if (body.stream === false) {
              try {
                let text = ""
                let reasoning = ""
                let status = "FINISHED"
                await pool.runExclusive(sessionId, () => execute((state) => { text = state.text; reasoning = state.reasoning; status = state.status ?? status }), requestAbort.signal)
                const message = { role: "assistant", content: text }
                if (reasoning) message.reasoning_content = reasoning
                return new Response(JSON.stringify({ id, object: "chat.completion", created, model: modelId, choices: [{ index: 0, message, finish_reason: finishReason(status) }] }), { headers: { "content-type": "application/json" } })
              } finally { cleanupAbort() }
            }

            const output = new TransformStream(undefined, { highWaterMark: 1 }, {
              highWaterMark: 64 * 1024,
              size(value) { return value.byteLength },
            })
            const writer = output.writable.getWriter()
            const abortOutput = () => { writer.abort(requestAbort.signal.reason).catch(() => {}) }
            requestAbort.signal.addEventListener("abort", abortOutput, { once: true })
            writer.closed.catch((error) => {
              if (!requestAbort.signal.aborted) requestAbort.abort(error ?? new Error("Client cancelled the stream"))
            })
            const write = async (value) => {
              requestAbort.signal.throwIfAborted()
              await writer.write(encoder.encode(value))
            }
            void (async () => {
                let sent = 0
                let reasoningSent = 0
                let role = false
                let emitted = false
                let status = "FINISHED"
                try {
                  await pool.runExclusive(sessionId, () => execute(async (current) => {
                    if (!role) { role = true; await write(chunk(id, created, modelId, { role: "assistant", content: "" })) }
                    status = current.status ?? status
                    if (current.reasoning.length > reasoningSent) { const value = current.reasoning.slice(reasoningSent); reasoningSent = current.reasoning.length; emitted = true; await write(chunk(id, created, modelId, { reasoning_content: value })) }
                    if (current.text.length > sent) { const value = current.text.slice(sent); sent = current.text.length; emitted = true; await write(chunk(id, created, modelId, { content: value })) }
                  }, { canRetry: () => !emitted }), requestAbort.signal)
                  await write(chunk(id, created, modelId, {}, finishReason(status)))
                  await write("data: [DONE]\n\n")
                  await writer.close()
                } catch (error) {
                  if (requestAbort.signal.aborted) {
                    await writer.abort(requestAbort.signal.reason ?? error).catch(() => {})
                  } else {
                    try {
                      await write(`data: ${JSON.stringify({ error: { message: safeErrorMessage(error?.message), type: "upstream_error", code: classifyError(error) } })}\n\n`)
                      await writer.close()
                    } catch {}
                  }
                } finally {
                  requestAbort.signal.removeEventListener("abort", abortOutput)
                  cleanupAbort()
                }
            })()
            return new Response(output.readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        const pool = pools.get(authFingerprint(auth))?.deref()
        const keys = (pool ?? createPool(authKeys(auth))).snapshot()
        const disabled = keys.filter((key) => !key.enabled).length
        const active = keys.reduce((sum, key) => sum + key.active, 0)
        const coolingDown = keys.filter((key) => key.enabled && key.cooldownUntil > Date.now()).length
        return {
          plan: "DeepSeek Web key pool",
          user: `${keys.length} keys · ${active} active · ${coolingDown} cooling down · ${disabled} disabled`,
          windows: [],
          error: keys.length && disabled === keys.length ? "All DeepSeek keys are unavailable" : "",
        }
      },
    },
    provider: { id: PROVIDER, async models(provider) { return provider.models } },
  }
}

export default { id: PROVIDER, server }
export const _internal = { createPool, parseKeys, toPrompt }
