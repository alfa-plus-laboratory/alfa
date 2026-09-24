/**
 * Templates are only a starting point; the protocol adapter decides the request shape. The
 * model ID must come from discovery or from the user — never guessed. Vendor shortcuts
 * are limited to the two native integrations; other services use the custom endpoint.
 */
import type { ProviderConfig } from "../config/config.ts"
export const PROVIDER_TEMPLATES: Record<string, ProviderConfig> = {
  anthropic: { type: "anthropic", baseURL: "https://api.anthropic.com/v1" },
  openai: { type: "openai-responses", baseURL: "https://api.openai.com/v1" },
  local: { type: "openai-chat", baseURL: "http://127.0.0.1:11434/v1", noKey: true },
  // New endpoints try Responses first; services that only implement the old API pick Chat
  // Completions explicitly in the protocol choice.
  custom: { type: "openai-responses" },
}
