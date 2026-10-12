/**
 * Nebius provider for AI-enhanced accessibility analysis
 *
 * Nebius offers OpenAI-compatible APIs with various models.
 * See: https://nebius.ai/
 *
 * Kept as a named alias for `openai-compatible` with the Nebius base URL so
 * existing configurations keep working. Note that the default model
 * `openai/gpt-oss-120b` is text-only: a run that needs a screenshot fails as
 * a configuration error instead of silently dropping the image.
 */

import { normalizeBaseUrl } from "../transports/shared.js";
import type { AIProvider, AIProviderConfig } from "../types.js";
import { createChatCompletionsProvider } from "./shared.js";

const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/**
 * Creates a Nebius provider instance
 *
 * Nebius uses an OpenAI-compatible API format.
 */
export function createNebiusProvider(config: AIProviderConfig): AIProvider {
  return createChatCompletionsProvider({
    name: "nebius",
    kind: "openai-compatible",
    label: "Nebius",
    envVar: "NEBIUS_API_KEY",
    baseUrl: normalizeBaseUrl(config.baseUrl ?? NEBIUS_BASE_URL),
    config,
  });
}
