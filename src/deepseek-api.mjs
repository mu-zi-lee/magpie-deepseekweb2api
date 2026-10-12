import { APP_VERSION, ORIGIN } from "./config.mjs"

export function safeErrorMessage(value, fallback = "DeepSeek request failed") {
  const text = String(value ?? fallback)
    .replace(/Bearer\s+[A-Za-z0-9._+/=-]+/gi, "Bearer [redacted]")
    .replace(/(cookie\s*[:=]\s*)([^;\s]+)/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9+/]{48,}={0,2}/g, "[redacted]")
  return text.slice(0, 500) || fallback
}

export function classifyError(error) {
  if (error?.signIn === "expired" || error?.status === 401 || error?.status === 403) return "auth"
  if (error?.name === "TimeoutError" || /timeout|timed out/i.test(error?.message ?? "")) return "timeout"
  if (error?.status === 429 || /rate.?limit|too many/i.test(error?.message ?? "")) return "rate_limit"
  if (error?.retryable) return "protocol"
  if (Number(error?.status) >= 500) return "upstream"
  return "request"
}

export function retryAfterMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === "") return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10 * 60_000, seconds * 1000)
  const date = Date.parse(String(value))
  return Number.isFinite(date) ? Math.max(0, Math.min(10 * 60_000, date - nowMs)) : 0
}

export function requestHeaders(origin, key, extra = {}) {
  const headers = {
    accept: "*/*",
    "content-type": "application/json",
    authorization: `Bearer ${key.userToken}`,
    origin,
    referer: `${origin}/a/chat/`,
    "x-client-platform": "web",
    "x-client-version": APP_VERSION,
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-locale": "zh_CN",
    ...extra,
  }
  if (key.cookie) headers.cookie = key.cookie
  return headers
}

export function withTimeout(signal, ms = 90_000) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

export async function readEnvelope(response, what) {
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`DeepSeek ${what}: sign-in expired`)
    error.signIn = "expired"
    error.status = response.status
    throw error
  }
  const text = await response.text()
  if (!text.trim()) throw new Error(safeErrorMessage(`DeepSeek ${what}: empty response (${response.status})`))
  let body
  try { body = JSON.parse(text) } catch {
    const error = new Error(safeErrorMessage(`DeepSeek ${what}: invalid JSON (${response.status})`))
    error.status = response.status
    error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"))
    throw error
  }
  if (!response.ok) {
    const error = new Error(safeErrorMessage(`DeepSeek ${what}: HTTP ${response.status}`))
    error.status = response.status
    error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"))
    throw error
  }
  const data = body?.data
  const code = data?.biz_code ?? body?.code
  if (code !== undefined && code !== null && code !== 0 && code !== "0") {
    const error = new Error(safeErrorMessage(`DeepSeek ${what}: refused (${code}) ${data?.biz_msg ?? body?.msg ?? ""}`))
    error.code = Number(code)
    error.bizCode = code
    error.status = String(code) === "429" ? 429 : undefined
    error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"))
    throw error
  }
  return data?.biz_data ?? data ?? body
}

export async function currentUser(origin = ORIGIN, key, signal) {
  const response = await fetch(`${origin}/api/v0/users/current`, {
    headers: requestHeaders(origin, key), signal: withTimeout(signal, 10_000),
  })
  return readEnvelope(response, "current user")
}

export async function createChat(origin, key, signal) {
  const response = await fetch(`${origin}/api/v0/chat_session/create`, {
    method: "POST", headers: requestHeaders(origin, key), body: "{}", signal: withTimeout(signal, 20_000),
  })
  const data = await readEnvelope(response, "chat session")
  const id = data?.chat_session?.id ?? data?.id
  if (!id) throw new Error("DeepSeek chat session response did not include an id")
  return id
}

export async function powChallenge(origin, key, targetPath, signal) {
  const response = await fetch(`${origin}/api/v0/chat/create_pow_challenge`, {
    method: "POST", headers: requestHeaders(origin, key),
    body: JSON.stringify({ target_path: targetPath }), signal: withTimeout(signal, 20_000),
  })
  const data = await readEnvelope(response, "proof-of-work challenge")
  const challenge = data?.challenge
  if (!challenge) throw new Error("DeepSeek proof-of-work challenge missing")
  return { ...challenge, expireAt: challenge.expire_at, targetPath: challenge.target_path ?? targetPath }
}
