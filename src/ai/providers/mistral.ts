/**
 * Mistral provider for AI-enhanced accessibility analysis
 *
 * Mistral speaks the OpenAI chat-completions format. Set `baseUrl` to use a
 * regional endpoint, e.g. https://api.eu.mistral.ai/v1.
 */

import { normalizeBaseUrl } from "../transports/shared.js";
import type { AIProvider, AIProviderConfig } from "../types.js";
import { createChatCompletionsProvider } from "./shared.js";

const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

/**
 * Creates a Mistral provider instance
 */
export function createMistralProvider(config: AIProviderConfig): AIProvider {
  return createChatCompletionsProvider({
    name: "mistral",
    kind: "mistral",
    label: "Mistral",
    envVar: "MISTRAL_API_KEY",
    baseUrl: normalizeBaseUrl(config.baseUrl ?? MISTRAL_BASE_URL),
    config,
  });
}
