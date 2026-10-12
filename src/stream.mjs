import { LIMITS } from "./config.mjs"

const MAX_FRAME_CHARACTERS = 1_048_576

function parseFrame(block) {
  let event = "message"
  const lines = []
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""))
  }
  return lines.length ? { event, data: lines.join("\n") } : null
}

export async function* sseFrames(body, { signal } = {}) {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let exhausted = false
  const abort = () => {
    try { Promise.resolve(reader.cancel(signal.reason)).catch(() => {}) } catch {}
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    signal?.throwIfAborted()
    for (;;) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) { exhausted = true; buffer += decoder.decode(); break }
      buffer += decoder.decode(value, { stream: true })
      let separator
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        signal?.throwIfAborted()
        if (separator.index > MAX_FRAME_CHARACTERS) throw new Error("DeepSeek stream frame exceeds size limit")
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const frame = parseFrame(block)
        if (frame) yield frame
      }
      if (buffer.length > MAX_FRAME_CHARACTERS) throw new Error("DeepSeek stream frame exceeds size limit")
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    try { if (!exhausted) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}

const REASONING_TYPES = new Set(["THINK", "THINKING", "REASONING", "SEARCH", "TOOL_SEARCH", "TOOL_OPEN", "TOOL_FIND"])

export class PatchState {
  constructor({ baselineText = "", baselineReasoning = "" } = {}) {
    this.text = baselineText
    this.reasoning = baselineReasoning
    this.baselineText = baselineText
    this.baselineReasoning = baselineReasoning
    this.status = null
    this.messageId = null
    this.usage = null
    this.fragments = new Map()
    this.fragmentTypes = new Map()
    this.lastFragmentIndex = null
    this.lastKind = "RESPONSE"
    this.baselinesUsed = new Set()
  }
  apply(frame) {
    if (!frame || typeof frame !== "object") return
    if (frame.p && typeof frame.p === "string") {
      if (frame.o === "BATCH" && Array.isArray(frame.v)) {
        for (const item of frame.v) {
          if (!item || typeof item !== "object") continue
          const path = typeof item.p === "string" && item.p.startsWith("response") ? item.p : [frame.p, item.p].filter(Boolean).join("/")
          this.apply({ ...item, p: path })
        }
        return
      }
      if (frame.p.endsWith("/status") && typeof frame.v === "string") this.status = frame.v
      if (frame.p.endsWith("/message_id") && typeof frame.v === "number") this.messageId = frame.v
      if (frame.p.includes("accumulated_token_usage") && typeof frame.v === "number") this.usage = frame.v
      if (frame.p === "response/fragments" && Array.isArray(frame.v)) {
        const start = frame.o === "APPEND" ? this.fragments.size : 0
        this.readFragments(frame.v, start)
      } else if (frame.p === "response" && frame.v && typeof frame.v === "object") {
        this.apply({ v: { response: frame.v } })
      } else {
        const match = /^response\/fragments\/(-?\d+)\/content$/.exec(frame.p)
        if (match && typeof frame.v === "string") {
          const index = Number(match[1]) === -1 ? this.lastFragmentIndex ?? 0 : Number(match[1])
          this.writeFragment(index, frame.v, this.fragmentTypes.get(index) ?? this.lastKind, frame.o === "SET")
        }
      }
      return
    }
    if (typeof frame.v === "string") {
      this.writeFragment(this.lastFragmentIndex ?? 0, frame.v, this.lastKind, false)
      return
    }
    const response = frame.v?.response ?? frame.response
    if (!response || typeof response !== "object") return
    if (typeof response.status === "string") this.status = response.status
    if (typeof response.message_id === "number") this.messageId = response.message_id
    if (typeof response.accumulated_token_usage === "number") this.usage = response.accumulated_token_usage
    this.readFragments(response.fragments)
  }
  readFragments(fragments, start = 0) {
    if (!Array.isArray(fragments)) return
    for (const [offset, fragment] of fragments.entries()) {
      if (!fragment || typeof fragment !== "object") continue
      const index = start + offset
      const type = String(fragment.type ?? this.fragmentTypes.get(index) ?? "RESPONSE").toUpperCase()
      this.fragmentTypes.set(index, type)
      this.lastFragmentIndex = index
      this.lastKind = type
      if (typeof fragment.content === "string") this.writeFragment(index, fragment.content, type, true)
      else if (!this.fragments.has(index)) this.fragments.set(index, "")
    }
  }
  writeFragment(index, value, type, snapshot) {
    const reasoning = REASONING_TYPES.has(type)
    const previous = this.fragments.get(index) ?? ""
    const channel = reasoning ? "reasoning" : "text"
    const baseline = !this.baselinesUsed.has(channel) ? (reasoning ? this.baselineReasoning : this.baselineText) : ""
    const prefix = previous || baseline
    const delta = snapshot && value.startsWith(prefix) ? value.slice(prefix.length) : value
    this.fragments.set(index, snapshot ? value : previous + value)
    this.fragmentTypes.set(index, type)
    this.lastFragmentIndex = index
    this.lastKind = type
    if (value) this.baselinesUsed.add(channel)
    this.append(delta, reasoning)
  }
  append(value, reasoning) {
    if (this.text.length + this.reasoning.length + value.length > LIMITS.maxOutputCharacters) {
      const error = new Error("DeepSeek response exceeds size limit")
      error.retryable = true
      throw error
    }
    if (reasoning) this.reasoning += value
    else this.text += value
  }
}
