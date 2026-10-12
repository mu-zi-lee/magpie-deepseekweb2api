function now() { return Date.now() }
const SESSION_TTL = 6 * 60 * 60 * 1000
const MAX_SESSIONS = 10_000

export function parseKeys(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return []
  const text = value.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.keys)) return parsed.keys
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === "object") return Object.values(parsed)
  } catch {}
  return text.split(/\r?\n/).map((line, index) => {
    const clean = line.trim()
    const match = clean.match(/^([^:=\s][^:=]*)\s*[:=]\s*(\S+)$/)
    if (match && !/^[A-Za-z0-9+/]{40,}={0,2}$/.test(clean)) {
      return { id: `key-${index + 1}`, label: match[1].trim(), userToken: match[2].trim() }
    }
    return { id: `key-${index + 1}`, label: `DeepSeek account ${index + 1}`, userToken: clean }
  })
}

export function normalizeKey(raw, index) {
  const userToken = String(raw?.userToken ?? raw?.token ?? raw?.key ?? "").trim()
  if (!userToken) return null
  const cookieValue = raw?.cookie ?? raw?.cookies ?? ""
  const cookie = Array.isArray(cookieValue)
    ? cookieValue
      .filter((item) => item && typeof item === "object" && item.name && item.value !== undefined && (!item.domain || /(^|\.)deepseek\.com$/i.test(String(item.domain).replace(/^\./, ""))))
      .map((item) => `${item.name}=${item.value}`)
      .join("; ")
    : cookieValue && typeof cookieValue === "object"
      ? Object.entries(cookieValue).map(([name, value]) => `${name}=${value}`).join("; ")
      : String(cookieValue).trim()
  return {
    id: String(raw?.id ?? `key-${index + 1}`),
    label: String(raw?.label ?? raw?.name ?? `DeepSeek account ${index + 1}`),
    userToken,
    cookie,
    enabled: raw?.enabled !== false,
    active: 0,
    failures: 0,
    cooldownUntil: 0,
    lastUsedAt: 0,
  }
}

export function credentialIssues(rawKeys) {
  const raw = parseKeys(rawKeys)
  const issues = []
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      issues.push({ index, code: "invalid_entry" })
      return
    }
    const token = String(entry.userToken ?? entry.token ?? entry.key ?? "").trim()
    const hasCookie = Boolean(entry.cookie ?? entry.cookies)
    if (!token && hasCookie) issues.push({ index, code: "cookie_without_user_token" })
    else if (!token) issues.push({ index, code: "missing_user_token" })
  })
  return issues
}

export function createPool(rawKeys, { maxConcurrentPerKey = 2 } = {}) {
  const keys = parseKeys(rawKeys).map(normalizeKey).filter(Boolean)
  if (keys.length > 100) throw new Error("DeepSeek key pool cannot contain more than 100 keys")
  const ids = new Set()
  const credentials = new Set()
  for (const key of keys) {
    if (ids.has(key.id)) throw new Error(`Duplicate DeepSeek key id: ${key.id}`)
    if (credentials.has(key.userToken)) throw new Error("Duplicate DeepSeek userToken; use one key per credential")
    ids.add(key.id)
    credentials.add(key.userToken)
  }
  return {
    keys,
    sessions: new Map(),
    locks: new Map(),
    async runExclusive(sessionId, task, signal) {
      if (!sessionId) return task()
      if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled")
      const previous = this.locks.get(sessionId) ?? Promise.resolve()
      let release
      const current = new Promise((resolve) => { release = resolve })
      const queued = previous.then(() => current)
      this.locks.set(sessionId, queued)
      let onAbort
      try {
        if (signal) {
          onAbort = () => {}
          await Promise.race([
            previous,
            new Promise((_, reject) => {
              onAbort = () => reject(signal.reason ?? new Error("Request cancelled"))
              signal.addEventListener("abort", onAbort, { once: true })
            }),
          ])
        } else await previous
      } catch (error) {
        // Keep the queue moving, but never start the cancelled task.
        if (onAbort) signal.removeEventListener("abort", onAbort)
        if (this.locks.get(sessionId) === queued) this.locks.set(sessionId, previous)
        previous.then(() => release(), () => release()).finally(() => {
          if (this.locks.get(sessionId) === previous) this.locks.delete(sessionId)
        })
        throw error
      }
      if (onAbort) signal.removeEventListener("abort", onAbort)
      if (signal?.aborted) {
        release()
        if (this.locks.get(sessionId) === queued) this.locks.delete(sessionId)
        throw signal.reason ?? new Error("Request cancelled")
      }
      try { return await task() } finally {
        release()
        if (this.locks.get(sessionId) === queued) this.locks.delete(sessionId)
      }
    },
    prune() {
      const cutoff = now() - SESSION_TTL
      for (const [sessionId, state] of this.sessions) {
        if ((state.updatedAt ?? 0) < cutoff) this.sessions.delete(sessionId)
      }
      while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value)
    },
    pick(sessionId) {
      this.prune()
      const bound = sessionId && this.sessions.get(sessionId)
      if (bound) {
        const existing = this.keys.find((key) => key.id === bound.keyId && key.enabled)
        if (existing && existing.cooldownUntil <= now() && existing.active < maxConcurrentPerKey) return existing
      }
      const candidates = this.keys
        .filter((key) => key.enabled && key.cooldownUntil <= now() && key.active < maxConcurrentPerKey)
        .sort((a, b) => a.active - b.active || a.lastUsedAt - b.lastUsedAt)
      const key = candidates[0]
      if (key && sessionId) this.sessions.set(sessionId, { keyId: key.id, updatedAt: now() })
      return key ?? null
    },
    start(key) { key.active += 1; key.lastUsedAt = now() },
    success(key) { key.active = Math.max(0, key.active - 1); key.failures = 0 },
    failure(key, error, { cancelled = false } = {}) {
      key.active = Math.max(0, key.active - 1)
      if (cancelled || error?.name === "AbortError" || /request cancelled|client cancelled/i.test(error?.message ?? "")) return
      key.failures += 1
      if (error?.signIn === "expired" || error?.status === 401 || error?.status === 403) key.enabled = false
      else key.cooldownUntil = now() + Math.min(10 * 60_000, error?.retryAfterMs > 0 ? error.retryAfterMs : 2_000 * 2 ** Math.min(key.failures, 5))
    },
    rebind(sessionId, key) {
      if (sessionId) this.sessions.set(sessionId, { keyId: key.id, updatedAt: now() })
    },
    forgetSession(sessionId) { this.sessions.delete(sessionId) },
    snapshot() {
      return this.keys.map((key) => ({ id: key.id, label: key.label, enabled: key.enabled, active: key.active, failures: key.failures, cooldownUntil: key.cooldownUntil }))
    },
    publicStatus() {
      const keys = this.snapshot()
      return {
        total: keys.length,
        enabled: keys.filter((key) => key.enabled).length,
        active: keys.reduce((sum, key) => sum + key.active, 0),
        coolingDown: keys.filter((key) => key.cooldownUntil > now()).length,
      }
    },
    getKey(id) { return this.keys.find((key) => key.id === id) ?? null },
    disable(id) {
      const key = this.getKey(id)
      if (key) key.enabled = false
      for (const [sessionId, state] of this.sessions) if (state.keyId === id) this.sessions.delete(sessionId)
      return Boolean(key)
    },
    enable(id) {
      const key = this.getKey(id)
      if (key) { key.enabled = true; key.cooldownUntil = 0; key.failures = 0 }
      return Boolean(key)
    },
  }
}
