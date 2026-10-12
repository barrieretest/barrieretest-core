/**
 * The OpenAI chat-completions wire format, parameterised by base URL, header
 * builder and error label.
 *
 * Used by Mistral, OpenAI, Nebius and any other OpenAI-compatible endpoint —
 * they differ in endpoint and auth header, not in message shape.
 */

import type { ModelCapabilities, ModelRequest, ModelResponse } from "../types.js";
import {
  BUDGET_SPENT_ON_REASONING,
  fetchWithTimeoutAndRetry,
  INCOMPLETE_JSON_ANSWER,
  truncationError,
  uint8ArrayToBase64,
} from "./shared.js";

export interface OpenAIChatTransportConfig {
  /** Provider label used in error messages, e.g. "Mistral". */
  label: string;
  /** Base URL without trailing slash; the request goes to `${baseUrl}/chat/completions`. */
  baseUrl: string;
  /** Builds the request headers, including auth. */
  headers: () => Record<string, string>;
  model: string;
  maxTokens: number;
  temperature: number;
  capabilities: ModelCapabilities;
  /** OpenAI-only image detail hint; omitted for the other users of this format. */
  imageDetail?: "low" | "high" | "auto";
  timeoutMs: number;
  /** Reasoning level to send verbatim; unset lets the capability table decide. */
  reasoningEffort?: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ChatContentPart[];
}

interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

/**
 * A chunk of an array-shaped assistant message. Reasoning models return
 * `thinking` (and other) chunks alongside the `text` chunks that carry the
 * actual answer.
 */
interface ChatContentChunk {
  type?: string;
  text?: string;
}

interface ChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | ChatContentChunk[] | null;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Creates a `complete()` implementation for a chat-completions endpoint.
 */
export function createOpenAIChatTransport(
  config: OpenAIChatTransportConfig
): (request: ModelRequest) => Promise<ModelResponse> {
  const { label, baseUrl, headers, model, maxTokens, temperature, capabilities, imageDetail } =
    config;

  // The semantic pass is a one-shot structured extraction: reasoning
  // multiplies cost and latency and can exhaust the token budget before the
  // answer starts. A model the table declares as reasoning therefore gets
  // reasoning turned off, and the user opts back in with
  // `reasoningEffort: "high"` plus a larger `maxTokens`.
  const reasoningEffort = config.reasoningEffort ?? (capabilities.reasoning ? "none" : undefined);

  return async (request: ModelRequest): Promise<ModelResponse> => {
    const messages: ChatMessage[] = [];

    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }

    const parts: ChatContentPart[] = [{ type: "text", text: request.text }];
    for (const image of request.images ?? []) {
      if (image.label) {
        parts.push({ type: "text", text: image.label });
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${uint8ArrayToBase64(image.png)}`,
          ...(imageDetail ? { detail: imageDetail } : {}),
        },
      });
    }
    messages.push({ role: "user", content: parts });

    const useSchema = Boolean(request.responseSchema) && capabilities.jsonSchema;
    const sentMaxTokens = request.maxTokens ?? maxTokens;

    const responseText = await fetchWithTimeoutAndRetry({
      label,
      url: `${baseUrl}/chat/completions`,
      headers: headers(),
      body: {
        model,
        messages,
        max_tokens: sentMaxTokens,
        temperature,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(useSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "response", schema: request.responseSchema, strict: true },
              },
            }
          : {}),
      },
      timeoutMs: request.timeout ?? config.timeoutMs,
      signal: request.signal,
    });

    const data = JSON.parse(responseText) as ChatResponse;
    const choice = data.choices?.[0];
    const content = normaliseContent(choice?.message?.content);

    if (!content) {
      if (choice?.finish_reason === "length") {
        throw truncationError(label, sentMaxTokens, BUDGET_SPENT_ON_REASONING);
      }
      throw new Error(`No response content from ${label}`);
    }

    const json = useSchema ? tryParseJson(content) : undefined;

    // A truncated answer that still parses may have finished just under the
    // limit, and text requested without a schema is usable as it stands. A
    // truncated answer that does not parse is only ever a budget problem, and
    // the caller would otherwise see a bare JSON syntax error.
    if (choice?.finish_reason === "length" && useSchema && json === undefined) {
      throw truncationError(label, sentMaxTokens, INCOMPLETE_JSON_ANSWER);
    }

    return {
      text: content,
      json,
      model: data.model ?? model,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(data.usage
        ? {
            usage: {
              inputTokens: data.usage.prompt_tokens ?? 0,
              outputTokens: data.usage.completion_tokens ?? 0,
            },
          }
        : {}),
    };
  };
}

/**
 * Reasoning models return an array of chunks instead of a string; only the
 * `text` chunks carry the answer, the rest (`thinking`, references, unknown
 * future types) are not part of it.
 */
function normaliseContent(content: string | ChatContentChunk[] | null | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
    .map((chunk) => chunk.text)
    .join("");
}

/** A model that ignored the schema still yields usable text, so never throw here. */
function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
