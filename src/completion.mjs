import { LIMITS, MODELS, ORIGIN } from "./config.mjs"
import { requestHeaders, readEnvelope, createChat, powChallenge, retryAfterMs, withTimeout } from "./deepseek-api.mjs"
import { powHeader, solvePowAsync } from "./pow.mjs"
import { PatchState, sseFrames } from "./stream.mjs"

export async function* complete({ key, modelId, prompt, sessionId, parentMessageId, signal, origin = ORIGIN, search = true, thinking }) {
  const model = MODELS[modelId]
  if (!model) throw new Error(`Unknown model: ${modelId}`)
  const chatId = sessionId ?? await createChat(origin, key, signal)
  let path = "/api/v0/chat/completion"
  let payload = { action: null, chat_session_id: chatId, parent_message_id: parentMessageId ?? null, model_type: model.wire, prompt, ref_file_ids: [], thinking_enabled: thinking ?? model.thinking, search_enabled: search, preempt: false }
  let continues = 0
  let carriedText = ""
  let carriedReasoning = ""
  for (;;) {
    let headers = requestHeaders(origin, key)
    if (path === "/api/v0/chat/completion") {
      const challenge = await powChallenge(origin, key, path, signal)
      headers = requestHeaders(origin, key, { "x-ds-pow-response": powHeader(challenge, await solvePowAsync(challenge, signal)) })
    }
    const completionSignal = withTimeout(signal, LIMITS.requestTimeoutMs)
    const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(payload), signal: completionSignal })
    if (response.status === 401 || response.status === 403) { const error = new Error("DeepSeek sign-in expired"); error.signIn = "expired"; error.status = response.status; throw error }
    if (!response.ok) { const error = new Error(`DeepSeek completion HTTP ${response.status}`); error.status = response.status; error.retryAfterMs = retryAfterMs(response.headers.get("retry-after")); throw error }
    const state = new PatchState({ baselineText: carriedText, baselineReasoning: carriedReasoning })
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      const body = await readEnvelope(response, "completion")
      const text = String(body?.response ?? body?.content ?? "")
      state.append(text.startsWith(carriedText) ? text.slice(carriedText.length) : text, false)
      const reasoning = String(body?.reasoning_content ?? body?.reasoning ?? "")
      state.append(reasoning.startsWith(carriedReasoning) ? reasoning.slice(carriedReasoning.length) : reasoning, true)
      state.status = "FINISHED"
      yield state
      return { sessionId: chatId, messageId: state.messageId }
    }
    for await (const frame of sseFrames(response.body, { signal: completionSignal })) {
      if (frame.event === "close") break
      if (frame.data === "[DONE]") break
      let parsed
      try { parsed = JSON.parse(frame.data) }
      catch {
        const error = new Error("DeepSeek returned a malformed stream frame")
        error.retryable = true
        throw error
      }
      state.apply(parsed)
      yield state
    }
    if (state.status === null && state.messageId === null && !state.text && !state.reasoning) {
      const error = new Error("DeepSeek returned an empty stream")
      error.retryable = true
      throw error
    }
    if (!["FINISHED", "INCOMPLETE", "CONTENT_FILTER", "CONTEXT_LENGTH_EXCEEDED", "TIMEOUT"].includes(state.status)) {
      const error = new Error("DeepSeek stream ended without a terminal status")
      error.retryable = true
      throw error
    }
    if (state.status === "INCOMPLETE" && state.messageId !== null && continues < 20) {
      continues += 1
      carriedText = state.text
      carriedReasoning = state.reasoning
      path = "/api/v0/chat/continue"
      payload = { chat_session_id: chatId, message_id: state.messageId, fallback_to_resume: true }
      continue
    }
    return { sessionId: chatId, messageId: state.messageId }
  }
}
