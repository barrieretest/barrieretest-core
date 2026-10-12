/**
 * Built-in model table: default models per provider and the capabilities of
 * known model ids.
 *
 * The table is advisory — model lineups change faster than releases, so
 * `AIProviderConfig.capabilities` always wins over an entry here.
 */

import type { AIProviderName, ModelCapabilities, ProviderKind } from "./types.js";

/**
 * Model used when the provider config omits `model`. `openai-compatible` has
 * no default: the caller names both the endpoint and the model.
 */
export const DEFAULT_MODELS: Record<AIProviderName, string | undefined> = {
  mistral: "mistral-large-4",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  nebius: "openai/gpt-oss-120b",
  "openai-compatible": undefined,
};

const BOTH: ModelCapabilities = { vision: true, jsonSchema: true };
const NEITHER: ModelCapabilities = { vision: false, jsonSchema: false };
/** Vision + structured output on a model that reasons by default. */
const BOTH_REASONING: ModelCapabilities = { ...BOTH, reasoning: true };

/**
 * Capabilities assumed for model ids that are not in `KNOWN_MODELS`. The
 * vendor kinds ship vision and structured output across their current
 * lineups; an arbitrary OpenAI-compatible endpoint gets the restrictive
 * default so a text-only model never silently swallows a screenshot.
 */
const KIND_DEFAULTS: Record<ProviderKind, ModelCapabilities> = {
  mistral: BOTH,
  openai: BOTH,
  anthropic: BOTH,
  "openai-compatible": NEITHER,
};

const KNOWN_MODELS: Record<ProviderKind, Record<string, ModelCapabilities>> = {
  mistral: {
    "mistral-large-4": BOTH_REASONING,
    "mistral-small-2603": BOTH,
  },
  openai: {
    "gpt-4o": BOTH,
    "gpt-4o-mini": BOTH,
    "gpt-4.1": BOTH,
    "gpt-4.1-mini": BOTH,
  },
  // Anthropic's claude-* models all support vision and structured output
  // (via a forced tool call), which is also the kind default.
  anthropic: {},
  "openai-compatible": {
    "openai/gpt-oss-120b": NEITHER,
  },
};

/**
 * Resolves the capabilities of a model, with `override` winning field by field.
 */
export function resolveCapabilities(
  kind: ProviderKind,
  model: string,
  override?: Partial<ModelCapabilities>
): ModelCapabilities {
  const base = KNOWN_MODELS[kind][model] ?? KIND_DEFAULTS[kind];
  const resolved: ModelCapabilities = { ...base };

  if (override?.vision !== undefined) {
    resolved.vision = override.vision;
  }
  if (override?.jsonSchema !== undefined) {
    resolved.jsonSchema = override.jsonSchema;
  }
  if (override?.maxImagesPerRequest !== undefined) {
    resolved.maxImagesPerRequest = override.maxImagesPerRequest;
  }
  if (override?.reasoning !== undefined) {
    resolved.reasoning = override.reasoning;
  }

  return resolved;
}
