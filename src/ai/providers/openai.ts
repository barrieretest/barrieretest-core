/**
 * OpenAI provider for AI-enhanced accessibility analysis
 */

import { normalizeBaseUrl } from "../transports/shared.js";
import type { AIProvider, AIProviderConfig } from "../types.js";
import { createChatCompletionsProvider } from "./shared.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Creates an OpenAI provider instance
 */
export function createOpenAIProvider(config: AIProviderConfig): AIProvider {
  return createChatCompletionsProvider({
    name: "openai",
    kind: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    baseUrl: normalizeBaseUrl(config.baseUrl ?? OPENAI_BASE_URL),
    imageDetail: "high",
    config,
  });
}
