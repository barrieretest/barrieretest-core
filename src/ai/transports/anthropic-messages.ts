/**
 * The Anthropic messages wire format.
 *
 * Structured output goes through a single forced tool call, which is the
 * provider's documented route — there is no `response_format` here.
 */

import type { ModelCapabilities, ModelRequest, ModelResponse } from "../types.js";
import {
  fetchWithTimeoutAndRetry,
  INCOMPLETE_JSON_ANSWER,
  truncationError,
  uint8ArrayToBase64,
} from "./shared.js";

const ANTHROPIC_VERSION = "2023-06-01";
/** Tool name used for the forced-tool-call structured output path. */
const RESPONSE_TOOL_NAME = "response";

export interface AnthropicTransportConfig {
  /** Provider label used in error messages. */
  label: string;
  /** Base URL without trailing slash; the request goes to `${baseUrl}/messages`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  capabilities: ModelCapabilities;
  timeoutMs: number;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentPart[];
}

interface AnthropicContentPart {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
}

interface AnthropicResponse {
  model?: string;
  stop_reason?: string;
  content?: {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Creates a `complete()` implementation for the Anthropic messages endpoint.
 */
export function createAnthropicTransport(
  config: AnthropicTransportConfig
): (request: ModelRequest) => Promise<ModelResponse> {
  const { label, baseUrl, apiKey, model, maxTokens, temperature, capabilities } = config;

  return async (request: ModelRequest): Promise<ModelResponse> => {
    // Anthropic recommends images before the text they relate to.
    const userContent: AnthropicContentPart[] = [];
    for (const image of request.images ?? []) {
      if (image.label) {
        userContent.push({ type: "text", text: image.label });
      }
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: uint8ArrayToBase64(image.png) },
      });
    }
    userContent.push({ type: "text", text: request.text });

    const messages: AnthropicMessage[] = [{ role: "user", content: userContent }];
    const useSchema = Boolean(request.responseSchema) && capabilities.jsonSchema;
    const sentMaxTokens = request.maxTokens ?? maxTokens;

    const responseText = await fetchWithTimeoutAndRetry({
      label,
      url: `${baseUrl}/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model,
        messages,
        max_tokens: sentMaxTokens,
        temperature,
        ...(request.system ? { system: request.system } : {}),
        ...(useSchema
          ? {
              tools: [{ name: RESPONSE_TOOL_NAME, input_schema: request.responseSchema }],
              tool_choice: { type: "tool", name: RESPONSE_TOOL_NAME },
            }
          : {}),
      },
      timeoutMs: request.timeout ?? config.timeoutMs,
      signal: request.signal,
    });

    const data = JSON.parse(responseText) as AnthropicResponse;
    const finish = data.stop_reason ? { finishReason: data.stop_reason } : {};
    // `request.cacheKey` has no counterpart here: Anthropic caches on explicit
    // `cache_control` breakpoints, which this transport does not set.
    const usage = data.usage
      ? {
          usage: {
            // Anthropic reports cache reads and cache writes beside
            // `input_tokens`, not inside it, while `ModelResponse.usage`
            // documents `inputTokens` as the total that `cachedInputTokens`
            // is part of.
            inputTokens:
              (data.usage.input_tokens ?? 0) +
              (data.usage.cache_read_input_tokens ?? 0) +
              (data.usage.cache_creation_input_tokens ?? 0),
            outputTokens: data.usage.output_tokens ?? 0,
            ...(typeof data.usage.cache_read_input_tokens === "number"
              ? { cachedInputTokens: data.usage.cache_read_input_tokens }
              : {}),
          },
        }
      : {};

    if (useSchema) {
      const toolUse = data.content?.find((block) => block.type === "tool_use");
      if (toolUse?.input !== undefined) {
        return {
          text: JSON.stringify(toolUse.input),
          json: toolUse.input,
          model: data.model ?? model,
          ...finish,
          ...usage,
        };
      }
      // A forced tool call that hit the ceiling leaves no usable structured
      // answer, whatever text blocks came with it.
      if (data.stop_reason === "max_tokens") {
        throw truncationError(label, sentMaxTokens, INCOMPLETE_JSON_ANSWER);
      }
    }

    const content = data.content?.find((block) => block.type === "text")?.text;
    if (!content) {
      throw new Error(`No response content from ${label}`);
    }

    return { text: content, model: data.model ?? model, ...finish, ...usage };
  };
}
