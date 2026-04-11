/**
 * Anthropic provider for AI-enhanced accessibility analysis
 */

import type {
  SemanticAnalysisInput,
  SemanticAnalysisResponse,
} from "../../semantic/types.js";
import type { AIAnalysis, AIAnalysisInput, AIProvider, AIProviderConfig } from "../types.js";
import { buildAnalysisPrompt, parseAnalysisResponse } from "../types.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_SEMANTIC_MAX_TOKENS = 2000;
const DEFAULT_SEMANTIC_TIMEOUT_MS = 120_000;

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
  content: {
    type: "text";
    text: string;
  }[];
}

/**
 * Creates an Anthropic provider instance
 */
export function createAnthropicProvider(config: AIProviderConfig): AIProvider {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.3,
  } = config;

  return {
    name: "anthropic",

    async analyze(input: AIAnalysisInput): Promise<AIAnalysis> {
      const prompt = buildAnalysisPrompt(input);
      const messages: AnthropicMessage[] = [];

      // Build message with optional image
      if (input.screenshot) {
        const base64Image = uint8ArrayToBase64(input.screenshot);
        messages.push({
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: base64Image,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        });
      } else {
        messages.push({
          role: "user",
          content: prompt,
        });
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      const content = data.content.find((c) => c.type === "text")?.text;

      if (!content) {
        throw new Error("No response content from Anthropic");
      }

      return parseAnalysisResponse(content);
    },

    async analyzeSemantic(input: SemanticAnalysisInput): Promise<SemanticAnalysisResponse> {
      const userContent: AnthropicContentPart[] = [];

      if (input.screenshot) {
        const base64Image = uint8ArrayToBase64(input.screenshot);
        userContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: base64Image,
          },
        });
      }

      userContent.push({ type: "text", text: input.prompt });

      const messages: AnthropicMessage[] = [{ role: "user", content: userContent }];

      const controller = new AbortController();
      const timeoutMs = input.timeout ?? DEFAULT_SEMANTIC_TIMEOUT_MS;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: Math.max(maxTokens, DEFAULT_SEMANTIC_MAX_TOKENS),
            temperature,
            system: input.system,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Anthropic API error: ${response.status} - ${error}`);
        }

        const data = (await response.json()) as AnthropicResponse;
        const content = data.content.find((c) => c.type === "text")?.text;

        if (!content) {
          throw new Error("No response content from Anthropic");
        }

        return { content, model };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Anthropic semantic call timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Converts Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
