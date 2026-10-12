/**
 * Anthropic provider for AI-enhanced accessibility analysis
 */

import { resolveCapabilities } from "../models.js";
import { createAnthropicTransport } from "../transports/anthropic-messages.js";
import { DEFAULT_TIMEOUT_MS, normalizeBaseUrl } from "../transports/shared.js";
import type { AIProvider, AIProviderConfig } from "../types.js";
import {
  createAIProvider,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  requireApiKey,
  requireModel,
} from "./shared.js";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const LABEL = "Anthropic";

/**
 * Creates an Anthropic provider instance
 */
export function createAnthropicProvider(config: AIProviderConfig): AIProvider {
  const apiKey = requireApiKey(LABEL, "ANTHROPIC_API_KEY", config.apiKey);
  const model = requireModel(LABEL, "anthropic", config.model);
  const capabilities = resolveCapabilities("anthropic", model, config.capabilities);
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  const send = createAnthropicTransport({
    label: LABEL,
    baseUrl: normalizeBaseUrl(config.baseUrl ?? ANTHROPIC_BASE_URL),
    apiKey,
    model,
    maxTokens,
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    capabilities,
    timeoutMs: config.timeout ?? DEFAULT_TIMEOUT_MS,
  });

  return createAIProvider({ name: "anthropic", model, capabilities, maxTokens, send });
}
