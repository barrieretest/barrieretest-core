/**
 * Provider assembly shared by all built-in providers: configuration checks
 * that fail before the first network call, the capability gate, and the
 * `analyze()` / `analyzeSemantic()` wrappers over `complete()`.
 */

import type { SemanticAnalysisInput, SemanticAnalysisResponse } from "../../semantic/types.js";
import { DEFAULT_MODELS, resolveCapabilities } from "../models.js";
import { createOpenAIChatTransport } from "../transports/openai-chat.js";
import { DEFAULT_TIMEOUT_MS } from "../transports/shared.js";
import type {
  AIAnalysis,
  AIAnalysisInput,
  AIProvider,
  AIProviderConfig,
  AIProviderName,
  ModelCapabilities,
  ModelRequest,
  ModelResponse,
  ProviderKind,
} from "../types.js";
import { buildAnalysisPrompt, parseAnalysisResponse } from "../types.js";

export const DEFAULT_MAX_TOKENS = 1024;
/**
 * The semantic pass needs room for a full findings list: a page with many
 * images or form fields produced more than 2000 tokens of findings and the
 * answer was cut off mid-JSON. With reasoning off by default the extra
 * ceiling costs nothing unless it is used.
 */
export const SEMANTIC_MIN_MAX_TOKENS = 4000;
export const DEFAULT_TEMPERATURE = 0.3;

export interface ProviderCore {
  /** Provider name as reported on the provider object. */
  name: AIProviderName;
  model: string;
  capabilities: ModelCapabilities;
  /** Resolved max output tokens from the provider config. */
  maxTokens: number;
  /** Wire-format implementation. */
  send: (request: ModelRequest) => Promise<ModelResponse>;
}

/**
 * Wraps a transport into an `AIProvider`: capability gate on `complete()`,
 * plus the two legacy entry points expressed through it.
 */
export function createAIProvider(core: ProviderCore): AIProvider {
  const { name, model, capabilities, maxTokens, send } = core;

  const complete = async (request: ModelRequest): Promise<ModelResponse> => {
    const imageCount = request.images?.length ?? 0;

    if (imageCount > 0 && !capabilities.vision) {
      throw new Error(
        `Model '${model}' on provider '${name}' does not support images; ${imageCount} image(s) were supplied`
      );
    }

    const maxImages = capabilities.maxImagesPerRequest;
    if (maxImages !== undefined && imageCount > maxImages) {
      throw new Error(
        `Model '${model}' on provider '${name}' supports at most ${maxImages} image(s) per request; ${imageCount} were supplied`
      );
    }

    return send(request);
  };

  return {
    name,
    model,
    capabilities,
    complete,

    async analyze(input: AIAnalysisInput): Promise<AIAnalysis> {
      const response = await complete({
        text: buildAnalysisPrompt(input),
        images: input.screenshot ? [{ png: input.screenshot }] : undefined,
      });

      return parseAnalysisResponse(response.text);
    },

    async analyzeSemantic(input: SemanticAnalysisInput): Promise<SemanticAnalysisResponse> {
      const response = await complete({
        text: input.prompt,
        system: input.system,
        images: input.screenshot ? [{ png: input.screenshot }] : undefined,
        maxTokens: Math.max(maxTokens, SEMANTIC_MIN_MAX_TOKENS),
        timeout: input.timeout,
      });

      return { content: response.text, model: response.model };
    },
  };
}

/**
 * Validates the API key without reading it from the environment: library
 * callers pass `apiKey`, the CLI resolves the env var itself.
 */
export function requireApiKey(label: string, envVar: string, apiKey: string | undefined): string {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    throw new Error(`${label} provider requires an API key (set ${envVar} or pass apiKey)`);
  }
  return trimmed;
}

/**
 * Resolves the model id, falling back to the provider's default.
 */
export function requireModel(
  label: string,
  name: AIProviderName,
  model: string | undefined
): string {
  const resolved = model?.trim() || DEFAULT_MODELS[name];
  if (!resolved) {
    throw new Error(`${label} provider requires a model (pass model in the provider config)`);
  }
  return resolved;
}

export interface ChatProviderOptions {
  name: AIProviderName;
  /** Capability table and wire format to use. */
  kind: ProviderKind;
  /** Label used in error messages. */
  label: string;
  /** Env var named in the missing-key error. */
  envVar: string;
  /** Resolved base URL without trailing slash. */
  baseUrl: string;
  /** OpenAI-only image detail hint. */
  imageDetail?: "low" | "high" | "auto";
  config: AIProviderConfig;
}

/**
 * Builds a provider on the chat-completions wire format.
 */
export function createChatCompletionsProvider(options: ChatProviderOptions): AIProvider {
  const { name, kind, label, envVar, baseUrl, imageDetail, config } = options;

  const apiKey = requireApiKey(label, envVar, config.apiKey);
  const model = requireModel(label, name, config.model);
  const capabilities = resolveCapabilities(kind, model, config.capabilities);
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  const send = createOpenAIChatTransport({
    label,
    baseUrl,
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    model,
    maxTokens,
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    capabilities,
    imageDetail,
    timeoutMs: config.timeout ?? DEFAULT_TIMEOUT_MS,
    reasoningEffort: config.reasoningEffort,
  });

  return createAIProvider({ name, model, capabilities, maxTokens, send });
}
