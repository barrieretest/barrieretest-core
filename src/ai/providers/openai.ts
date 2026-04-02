/**
 * OpenAI provider for AI-enhanced accessibility analysis
 */

import type { AIAnalysis, AIAnalysisInput, AIProvider, AIProviderConfig } from "../types";
import { buildAnalysisPrompt, parseAnalysisResponse } from "../types";

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_TOKENS = 1024;

interface OpenAIMessage {
  role: "user" | "assistant" | "system";
  content: string | OpenAIContentPart[];
}

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

interface OpenAIResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
}

/**
 * Creates an OpenAI provider instance
 */
export function createOpenAIProvider(config: AIProviderConfig): AIProvider {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.3,
  } = config;

  return {
    name: "openai",

    async analyze(input: AIAnalysisInput): Promise<AIAnalysis> {
      const prompt = buildAnalysisPrompt(input);
      const messages: OpenAIMessage[] = [];

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
                detail: "high",
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

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as OpenAIResponse;
      const content = data.choices[0]?.message?.content;

      if (!content) {
        throw new Error("No response content from OpenAI");
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
