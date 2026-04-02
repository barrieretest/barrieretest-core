/**
 * Types for AI-enhanced accessibility analysis
 */

import type { Issue } from "../types";

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
 * AI provider interface
 */
export interface AIProvider {
  /** Provider name */
  name: string;
  /** Analyze an accessibility issue */
  analyze(input: AIAnalysisInput): Promise<AIAnalysis>;
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
}

/**
 * Supported AI provider names
 */
export type AIProviderName = "openai" | "anthropic" | "nebius";

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
