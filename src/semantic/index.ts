/**
 * Public entry point for the semantic-audit feature.
 *
 * `semanticAudit()` runs AI-driven accessibility checks that require
 * vision and reasoning — the kind of issues axe and pa11y can't find on
 * their own. The set of checks is an extensible registry; the six built-ins
 * are the seed.
 *
 * @example
 * ```typescript
 * import { semanticAudit } from "@barrieretest/core";
 *
 * const result = await semanticAudit("https://example.com", {
 *   provider: { name: "nebius", apiKey: process.env.NEBIUS_API_KEY! },
 * });
 * ```
 *
 * Or, more commonly, via `audit({ semantic: ... })` so the regular and
 * semantic passes share a single browser launch.
 */

import {
  type BrowserPage,
  isBrowserPage,
  isPlaywrightPage,
  isPuppeteerPage,
  isUrl,
} from "../browser.js";
import type { AuditTarget } from "../types.js";
import { runSemanticAudit, runSemanticAuditOnUrl } from "./runner.js";
import type { SemanticAuditResult, SemanticOptions } from "./types.js";

/**
 * Run a semantic accessibility audit against a URL or live browser page.
 */
export async function semanticAudit(
  target: AuditTarget,
  options: SemanticOptions
): Promise<SemanticAuditResult> {
  if (isUrl(target)) {
    return runSemanticAuditOnUrl(target, options);
  }

  if (isPuppeteerPage(target) || isPlaywrightPage(target) || isBrowserPage(target)) {
    const page = target as BrowserPage;
    return runSemanticAudit({ url: page.url(), page, ownsBrowser: false }, options);
  }

  throw new Error("Invalid target: expected a URL string or browser page");
}

export { runSemanticAudit, runSemanticAuditOnUrl } from "./runner.js";
export {
  BUILT_IN_CHECKS,
  BUILT_IN_CHECK_IDS,
  resolveChecks,
  altTextQualityCheck,
  ariaMismatchCheck,
  formLabelClarityCheck,
  landmarksCheck,
  langAttributeCheck,
  pageTitleCheck,
} from "./checks/index.js";
export { buildSemanticPrompt, SEMANTIC_SYSTEM_PROMPT } from "./prompt.js";
export { extractJsonObject, parseSemanticResponse } from "./parse.js";
export {
  type SanitizedPromptContext,
  sanitizePromptContext,
} from "./sanitize.js";
export {
  DEFAULT_CONTEXT_LIMITS,
  type ExtractedContext,
  extractHtmlContext,
  formatExtractedContext,
} from "./context.js";
export type {
  RawSemanticFinding,
  SemanticAnalysisInput,
  SemanticAnalysisResponse,
  SemanticAuditResult,
  SemanticCheck,
  SemanticContextLimits,
  SemanticContextSection,
  SemanticIssueMeta,
  SemanticLandmark,
  SemanticMeta,
  SemanticOptions,
  SemanticProviderConfig,
  SemanticSeverity,
} from "./types.js";
export { SEMANTIC_SEVERITY_MAP } from "./types.js";
