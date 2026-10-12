/**
 * Types for AI-enhanced accessibility analysis
 */

import type { SemanticAnalysisInput, SemanticAnalysisResponse } from "../semantic/types.js";
import type { Issue } from "../types.js";

/**
 * Result of AI analysis for an accessibility issue
 */
export interface AIAnalysis {
  /** Contextual analysis of the issue */
  contextualAnalysis: string;
  /** Suggested code fix */
  suggestedFix: string;
  /** Confidence score (0-1) */
  confidence: number;
}

/**
 * Input for AI analysis
 */
export interface AIAnalysisInput {
  /** Screenshot of the element (PNG) */
  screenshot?: Uint8Array;
  /** The accessibility issue */
  issue: Issue;
  /** Additional context about the element */
  context?: {
    /** Component name if identified */
    componentName?: string;
    /** Source file if found */
    sourceFile?: string;
    /** HTML of the element */
    html?: string;
  };
}

/**
 * Capabilities a model either has or lacks. Declared, never discovered by a
 * failed request: an unsupported capability is a configuration error before
 * the first network call.
 */
export interface ModelCapabilities {
  /** Accepts images in the request. */
  vision: boolean;
  /** Native structured output (response_format json_schema, or a forced tool call on Anthropic). */
  jsonSchema: boolean;
  /** Omitted when the provider imposes no practical per-request limit. */
  maxImagesPerRequest?: number;
  /** Emits reasoning by default; costs output tokens and latency. */
  reasoning?: boolean;
}

/** A JSON Schema object describing the expected response shape. */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * One request in the shape every provider accepts, independent of wire format.
 */
export interface ModelRequest {
  /** Optional system prompt. */
  system?: string;
  /** User prompt. Sent as the first part of the user message. */
  text: string;
  /**
   * PNG images. `label` is sent as a text part directly before its image,
   * e.g. "Image 2: same capture with numbered marks".
   */
  images?: { png: Uint8Array; label?: string }[];
  /** When set and the model supports it, enforced via provider-native structured output. */
  responseSchema?: JsonSchemaObject;
  /** Overrides the provider's configured max output tokens for this request. */
  maxTokens?: number;
  /** Per-request timeout in milliseconds. Defaults to the provider's `timeout`. */
  timeout?: number;
  /** Caller abort signal, honoured alongside the timeout. */
  signal?: AbortSignal;
}

/**
 * One response in the shape every provider returns.
 */
export interface ModelResponse {
  /** Raw text content. */
  text: string;
  /**
   * Parsed JSON when `responseSchema` was given, the provider enforced it,
   * and the text parsed; undefined otherwise.
   */
  json?: unknown;
  /** Model the provider reported, falling back to the configured model. */
  model: string;
  /** Why the model stopped, as the provider reported it, e.g. "stop" or "length". */
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * AI provider interface
 */
export interface AIProvider {
  /** Provider name */
  name: string;
  /** Model identifier. Set by every provider `createProvider()` builds. */
  model?: string;
  /** Declared model capabilities. Set by every provider `createProvider()` builds. */
  capabilities?: ModelCapabilities;
  /**
   * Single request in the unified shape.
   *
   * Optional so hand-written providers and test stubs that only implement
   * `analyze()` keep compiling.
   */
  complete?(request: ModelRequest): Promise<ModelResponse>;
  /** Analyze a single accessibility issue (per-issue enhancement). */
  analyze(input: AIAnalysisInput): Promise<AIAnalysis>;
  /**
   * Run a semantic-audit pass.
   *
   * Optional — providers that don't implement it cause `semanticAudit()` to
   * throw a clear "not supported" error. Implementations should return the
   * raw model output as a string; the runner is responsible for parsing it.
   */
  analyzeSemantic?(input: SemanticAnalysisInput): Promise<SemanticAnalysisResponse>;
}

/**
 * Configuration for AI providers
 */
export interface AIProviderConfig {
  /** API key for the provider */
  apiKey: string;
  /** Model to use (provider-specific) */
  model?: string;
  /** Maximum tokens for response */
  maxTokens?: number;
  /** Temperature for generation */
  temperature?: number;
  /**
   * Required for "openai-compatible"; optional override for the others
   * (e.g. https://api.eu.mistral.ai/v1). Trailing slashes are stripped.
   */
  baseUrl?: string;
  /** Overrides or supplies capabilities for models not in the built-in table. */
  capabilities?: Partial<ModelCapabilities>;
  /** Default per-request timeout in ms. Default 120_000. */
  timeout?: number;
  /**
   * Reasoning level, passed verbatim to the provider because vendors differ.
   * Documented values: "none", "high". Unset means "none" for a model the
   * table declares as `reasoning`, and the vendor default otherwise.
   */
  reasoningEffort?: string;
}

/**
 * Wire formats and capability tables the layer implements.
 */
export type ProviderKind = "mistral" | "openai" | "anthropic" | "openai-compatible";

/**
 * Supported AI provider names. "nebius" is an alias for openai-compatible
 * with the Nebius base URL and its default model.
 */
export type AIProviderName = ProviderKind | "nebius";

/**
 * Builds the prompt for AI analysis
 */
export function buildAnalysisPrompt(input: AIAnalysisInput): string {
  const { issue, context } = input;

  let prompt = `Analyze this accessibility issue and provide a fix.

## Issue Details
- **Rule**: ${issue.id}
- **Severity**: ${issue.impact}
- **Description**: ${issue.description}
- **Help**: ${issue.help}
${issue.helpUrl ? `- **Documentation**: ${issue.helpUrl}` : ""}
${issue.selector ? `- **Selector**: ${issue.selector}` : ""}
`;

  if (issue.nodes.length > 0) {
    prompt += `
## Affected HTML
\`\`\`html
${issue.nodes.map((n) => n.html).join("\n")}
\`\`\`
`;
  }

  if (context) {
    prompt += "\n## Context\n";
    if (context.componentName) {
      prompt += `- **Component**: ${context.componentName}\n`;
    }
    if (context.sourceFile) {
      prompt += `- **Source File**: ${context.sourceFile}\n`;
    }
  }

  prompt += `
## Instructions
1. Explain why this is an accessibility issue and who it affects
2. Provide a specific code fix that resolves the issue
3. Keep the fix minimal - only change what's necessary

Respond in this exact JSON format:
{
  "contextualAnalysis": "Explanation of the issue and its impact on users",
  "suggestedFix": "The corrected HTML/code that fixes the issue",
  "confidence": 0.8
}

Only output the JSON, no other text.`;

  return prompt;
}

/**
 * Parses AI response into AIAnalysis
 */
export function parseAnalysisResponse(response: string): AIAnalysis {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in AI response");
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    contextualAnalysis?: string;
    suggestedFix?: string;
    confidence?: number;
  };

  if (!parsed.contextualAnalysis || !parsed.suggestedFix) {
    throw new Error("Invalid AI response format");
  }

  return {
    contextualAnalysis: parsed.contextualAnalysis,
    suggestedFix: parsed.suggestedFix,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
  };
}
