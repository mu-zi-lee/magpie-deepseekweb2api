import { createHash } from "node:crypto"
import { messageText, toPrompt } from "./openai.mjs"

function messageIdentity(message) {
  return {
    role: message.role,
    content: messageText(message),
    name: message.name ?? null,
    tool_call_id: message.tool_call_id ?? null,
    tool_calls: message.tool_calls ?? null,
  }
}

export function extendHistory(hash, messages) {
  let next = hash
  for (const message of messages) {
    next = createHash("sha256").update(next).update("\0").update(JSON.stringify(messageIdentity(message))).digest("hex")
  }
  return next
}

export function planConversation(messages, bound, fullPrompt = toPrompt(messages)) {
  const hasParent = bound?.deepseekSessionId && Number.isSafeInteger(bound.parentMessageId) && bound.historyHash
  const deltaOnly = messages.length === 1 && messages[0].role === "user"
  const matches = hasParent && messages.length > bound.historyLength
    && extendHistory("", messages.slice(0, bound.historyLength)) === bound.historyHash
  if (hasParent && (matches || deltaOnly)) {
    const added = matches ? messages.slice(bound.historyLength) : messages
    return {
      sessionId: bound.deepseekSessionId,
      parentMessageId: bound.parentMessageId,
      prompt: toPrompt(added),
      historyHash: extendHistory(bound.historyHash, added),
      historyLength: bound.historyLength + added.length,
    }
  }
  return { prompt: fullPrompt, historyHash: extendHistory("", messages), historyLength: messages.length }
}

export function completedHistory(plan, text) {
  return {
    historyHash: extendHistory(plan.historyHash, [{ role: "assistant", content: text }]),
    historyLength: plan.historyLength + 1,
  }
}
