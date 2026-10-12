/**
 * Generic OpenAI-compatible provider: any endpoint that speaks the
 * chat-completions format.
 *
 * Both `baseUrl` and `model` are required — there is nothing to default to.
 * Capabilities default to the restrictive `{ vision: false, jsonSchema: false }`
 * for unknown models; declare them with `capabilities` when the model has more.
 */

import { normalizeBaseUrl } from "../transports/shared.js";
import type { AIProvider, AIProviderConfig } from "../types.js";
import { createChatCompletionsProvider, requireApiKey } from "./shared.js";

const LABEL = "OpenAI-compatible";

/**
 * Creates a provider for an arbitrary OpenAI-compatible endpoint
 */
export function createOpenAICompatibleProvider(config: AIProviderConfig): AIProvider {
  requireApiKey(LABEL, "OPENAI_COMPATIBLE_API_KEY", config.apiKey);

  const baseUrl = config.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      `${LABEL} provider requires a baseUrl (e.g. https://api.tokenfactory.nebius.com/v1)`
    );
  }

  return createChatCompletionsProvider({
    name: "openai-compatible",
    kind: "openai-compatible",
    label: LABEL,
    envVar: "OPENAI_COMPATIBLE_API_KEY",
    baseUrl: normalizeBaseUrl(baseUrl),
    config,
  });
}
