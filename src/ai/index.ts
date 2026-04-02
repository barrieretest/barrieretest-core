/**
 * AI-enhanced accessibility analysis
 *
 * Orchestrates AI providers to analyze accessibility issues
 * and suggest fixes.
 */

import type { LocalizationResult, LocalizedIssue } from "../localization";
import type { Issue } from "../types";
import { createAnthropicProvider } from "./providers/anthropic";
import { createNebiusProvider } from "./providers/nebius";
import { createOpenAIProvider } from "./providers/openai";
import type {
  AIAnalysis,
  AIAnalysisInput,
  AIProvider,
  AIProviderConfig,
  AIProviderName,
} from "./types";

/**
 * Issue with AI enhancement
 */
export interface AIEnhancedIssue extends Issue {
  /** Localization information */
  localization?: LocalizationResult;
  /** AI analysis results */
  ai?: AIAnalysis;
}

/**
 * Options for AI enhancement
 */
export interface AIEnhanceOptions {
  /** Which provider to use */
  provider: AIProviderName;
  /** Provider configuration */
  config: AIProviderConfig;
  /** Maximum concurrent requests */
  concurrency?: number;
  /** Delay between requests (ms) for rate limiting */
  requestDelay?: number;
  /** Maximum issues to analyze (for cost control) */
  maxIssues?: number;
  /** Whether to continue on individual failures */
  continueOnError?: boolean;
  /** Progress callback */
  onProgress?: (data: { current: number; total: number; issue: Issue }) => void;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_REQUEST_DELAY = 100;

/**
 * Creates an AI provider based on name
 */
export function createProvider(name: AIProviderName, config: AIProviderConfig): AIProvider {
  switch (name) {
    case "openai":
      return createOpenAIProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
    case "nebius":
      return createNebiusProvider(config);
    default:
      throw new Error(`Unknown AI provider: ${name}`);
  }
}

/**
 * Enhances issues with AI analysis
 *
 * @param issues - Issues to enhance (can be plain Issues or LocalizedIssues)
 * @param options - AI enhancement options
 * @returns Issues with AI analysis added
 */
export async function enhanceWithAI(
  issues: (Issue | LocalizedIssue)[],
  options: AIEnhanceOptions
): Promise<AIEnhancedIssue[]> {
  const {
    provider: providerName,
    config,
    concurrency = DEFAULT_CONCURRENCY,
    requestDelay = DEFAULT_REQUEST_DELAY,
    maxIssues,
    continueOnError = true,
    onProgress,
  } = options;

  const provider = createProvider(providerName, config);

  // Limit issues if requested
  const issuesToProcess = maxIssues ? issues.slice(0, maxIssues) : issues;
  const total = issuesToProcess.length;

  const results: AIEnhancedIssue[] = [];

  // Process in batches for rate limiting
  for (let i = 0; i < issuesToProcess.length; i += concurrency) {
    const batch = issuesToProcess.slice(i, i + concurrency);

    const batchPromises = batch.map(async (issue, batchIndex) => {
      const globalIndex = i + batchIndex;

      try {
        onProgress?.({ current: globalIndex + 1, total, issue });

        const input = buildAnalysisInput(issue);
        const analysis = await provider.analyze(input);

        return {
          ...issue,
          ai: analysis,
        } as AIEnhancedIssue;
      } catch (error) {
        if (!continueOnError) {
          throw error;
        }

        // Return issue without AI on failure
        console.warn(
          `AI analysis failed for issue ${issue.id}: ${error instanceof Error ? error.message : "Unknown error"}`
        );

        return {
          ...issue,
        } as AIEnhancedIssue;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Rate limiting delay between batches
    if (i + concurrency < issuesToProcess.length && requestDelay > 0) {
      await sleep(requestDelay);
    }
  }

  return results;
}

/**
 * Builds AI analysis input from an issue
 */
function buildAnalysisInput(issue: Issue | LocalizedIssue): AIAnalysisInput {
  const input: AIAnalysisInput = {
    issue,
  };

  // Add screenshot if available from localization
  const localizedIssue = issue as LocalizedIssue;
  if (localizedIssue.localization?.screenshot) {
    input.screenshot = localizedIssue.localization.screenshot;
  }

  // Add context from localization
  if (localizedIssue.localization) {
    input.context = {
      componentName: localizedIssue.localization.componentName,
      sourceFile: localizedIssue.localization.sourceFile,
      html: issue.nodes[0]?.html,
    };
  } else if (issue.nodes.length > 0) {
    input.context = {
      html: issue.nodes[0].html,
    };
  }

  return input;
}

/**
 * Analyzes a single issue with AI
 *
 * @param issue - Issue to analyze
 * @param options - AI options (provider and config required)
 * @returns Issue with AI analysis
 */
export async function analyzeIssue(
  issue: Issue | LocalizedIssue,
  options: Pick<AIEnhanceOptions, "provider" | "config">
): Promise<AIEnhancedIssue> {
  const provider = createProvider(options.provider, options.config);
  const input = buildAnalysisInput(issue);

  try {
    const analysis = await provider.analyze(input);
    return {
      ...issue,
      ai: analysis,
    };
  } catch {
    return { ...issue };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { createAnthropicProvider } from "./providers/anthropic";
export { createNebiusProvider } from "./providers/nebius";
export { createOpenAIProvider } from "./providers/openai";
// Re-export types
export type {
  AIAnalysis,
  AIAnalysisInput,
  AIProvider,
  AIProviderConfig,
  AIProviderName,
} from "./types";
export { buildAnalysisPrompt, parseAnalysisResponse } from "./types";
