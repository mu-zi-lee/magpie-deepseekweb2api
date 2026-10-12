export function messageText(message) {
  if (typeof message?.content === "string") return message.content
  if (Array.isArray(message?.content)) return message.content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("")
  return ""
}

export function validateMessages(messages) {
  for (const message of messages ?? []) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("DeepSeek requires message objects")
    if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) throw new Error("DeepSeek message role is invalid")
    if (message.content == null && message.role === "assistant") continue
    if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new Error("DeepSeek message content must be text")
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part === "string" || (part?.type === "text" && typeof part.text === "string")) continue
        throw new Error("DeepSeek Web provider currently supports text messages only")
      }
    }
  }
}

export function toPrompt(messages, from = 0) {
  const parts = []
  let userSpoke = false
  for (const message of (messages ?? []).slice(from)) {
    const text = messageText(message)
    if (!text && !(message.role === "assistant" && message.tool_calls?.length)) continue
    if (message.role === "system" || message.role === "developer") parts.push(text)
    else if (message.role === "assistant") {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => {
        const fn = call?.function
        return fn?.name ? `<tool_call>${JSON.stringify({ name: fn.name, arguments: fn.arguments ?? "{}" })}</tool_call>` : ""
      }).filter(Boolean).join("\n") : ""
      parts.push([text ? `Assistant: ${text}` : "", calls].filter(Boolean).join("\n"))
    }
    else if (message.role === "tool") parts.push(`Tool result: ${text}`)
    else { parts.push(userSpoke ? `User: ${text}` : text); userSpoke = true }
  }
  return parts.join("\n\n")
}

export function chunk(id, created, model, delta, finish_reason = null) {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
}

export function finishReason(status) {
  switch (status) {
    case "CONTENT_FILTER": return "content_filter"
    case "CONTEXT_LENGTH_EXCEEDED": return "length"
    case "INCOMPLETE":
    case "TIMEOUT": return "length"
    default: return "stop"
  }
}
