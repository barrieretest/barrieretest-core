/**
 * Nebius provider for AI-enhanced accessibility analysis
 *
 * Nebius offers OpenAI-compatible APIs with various models.
 * See: https://nebius.ai/
 */

import type { AIAnalysis, AIAnalysisInput, AIProvider, AIProviderConfig } from "../types";
import { buildAnalysisPrompt, parseAnalysisResponse } from "../types";

const DEFAULT_MODEL = "Qwen/Qwen2-VL-72B-Instruct";
const DEFAULT_MAX_TOKENS = 1024;
const NEBIUS_API_URL = "https://api.studio.nebius.ai/v1/chat/completions";

interface NebiusMessage {
  role: "user" | "assistant" | "system";
  content: string | NebiusContentPart[];
}

interface NebiusContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

interface NebiusResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
}

/**
 * Creates a Nebius provider instance
 *
 * Nebius uses an OpenAI-compatible API format.
 */
export function createNebiusProvider(config: AIProviderConfig): AIProvider {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.3,
  } = config;

  return {
    name: "nebius",

    async analyze(input: AIAnalysisInput): Promise<AIAnalysis> {
      const prompt = buildAnalysisPrompt(input);
      const messages: NebiusMessage[] = [];

      // Build message with optional image
      if (input.screenshot) {
        const base64Image = uint8ArrayToBase64(input.screenshot);
        messages.push({
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
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

      const response = await fetch(NEBIUS_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
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
        throw new Error(`Nebius API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as NebiusResponse;
      const content = data.choices[0]?.message?.content;

      if (!content) {
        throw new Error("No response content from Nebius");
      }

      return parseAnalysisResponse(content);
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
