export const PROVIDER = "deepseek-web"
export const NAME = "DeepSeek Web (key pool)"
export const ORIGIN = process.env.DEEPSEEK_WEB_ORIGIN || "https://chat.deepseek.com"
export const APP_VERSION = "2.4.0"

export const MODELS = {
  "deepseek-chat": { wire: "default", thinking: false, name: "DeepSeek Chat" },
  "deepseek-reasoner": { wire: "expert", thinking: true, name: "DeepSeek Reasoner" },
}

export const LIMITS = {
  maxMessages: 512,
  maxPromptCharacters: 1_000_000,
  maxOutputCharacters: 2_000_000,
  requestTimeoutMs: 90_000,
}

export function providerModels() {
  return Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [id, {
    name: model.name,
    reasoning: model.thinking,
    tool_call: false,
    attachment: false,
    limit: { context: 128_000, output: model.thinking ? 32_768 : 8_192 },
    cost: { input: 0, output: 0 },
  }]))
}
