/**
 * Semantic-audit runner.
 *
 * Orchestrates the steps of a semantic accessibility pass:
 *   1. Resolve the requested checks (built-ins ∪ custom).
 *   2. Extract only the HTML context categories the selected checks need.
 *   3. Sanitize the context.
 *   4. Build a single prompt that lists every selected check.
 *   5. Call the AI provider's `analyzeSemantic()` once with screenshot + text.
 *   6. Parse the JSON response, map findings to `Issue[]`, return result.
 *
 * The runner accepts a live `BrowserPage` (typical: called from `audit()`
 * which already has one) or launches its own browser when given a URL.
 */

import { createProvider } from "../ai/index.js";
import type { AIProvider } from "../ai/types.js";
import type { BrowserPage } from "../browser.js";
import { closeSession, launchPuppeteerSession, navigateTo } from "../puppeteer-launch.js";
import type { Issue } from "../types.js";
import { resolveChecks } from "./checks/index.js";
import { type ExtractedContext, extractHtmlContext, formatExtractedContext } from "./context.js";
import { parseSemanticResponse } from "./parse.js";
import { buildSemanticPrompt, SEMANTIC_SYSTEM_PROMPT } from "./prompt.js";
import { sanitizePromptContext } from "./sanitize.js";
import {
  type RawSemanticFinding,
  SEMANTIC_SEVERITY_MAP,
  type SemanticAuditResult,
  type SemanticCheck,
  type SemanticContextSection,
  type SemanticMeta,
  type SemanticOptions,
} from "./types.js";

/**
 * Internal context shared between standalone and `audit()`-integrated paths.
 */
export interface SemanticRunContext {
  url: string;
  page: BrowserPage;
  /** When true, the runner is responsible for closing the browser. */
  ownsBrowser: boolean;
  /** Pre-captured screenshot to reuse, if any. */
  screenshot?: Uint8Array;
  /**
   * Set to true when the caller has already navigated the page and dismissed
   * cookie banners (e.g. when called from `audit({ semantic })`). When false
   * or undefined, `runSemanticAudit` will dismiss banners itself.
   */
  pagePrepared?: boolean;
  /**
   * Internal: inject a fully constructed AIProvider, bypassing
   * `createProvider()`. Used by tests to avoid hitting real APIs.
   */
  providerOverride?: AIProvider;
}

/**
 * Default mapping from a raw finding into the standard `Issue` shape.
 */
function defaultFindingToIssue(
  finding: RawSemanticFinding,
  check: SemanticCheck | undefined
): Issue {
  const checkId = check?.id ?? finding.checkType;
  const rawConfidence = typeof finding.confidence === "number" ? finding.confidence : 50;
  // Confidence comes back as 0-100; normalize to 0-1 and clamp so the
  // documented `SemanticIssueMeta.confidence` contract holds even when the
  // model returns out-of-range values.
  const normalized = rawConfidence > 1 ? rawConfidence / 100 : rawConfidence;
  const normalizedConfidence = Math.min(1, Math.max(0, normalized));

  return {
    id: `semantic:${checkId}`,
    impact: SEMANTIC_SEVERITY_MAP[finding.severity],
    description: finding.message,
    help: check?.description ?? finding.suggestion ?? finding.message,
    helpUrl: check?.helpUrl,
    selector: finding.location || null,
    nodes: finding.context ? [{ html: finding.context }] : [],
    semantic: {
      checkType: checkId,
      confidence: normalizedConfidence,
      suggestion: finding.suggestion,
    },
  };
}

function mapFindingToIssue(finding: RawSemanticFinding, checks: SemanticCheck[]): Issue {
  const check = checks.find((c) => c.id === finding.checkType);
  if (check?.parseIssue) {
    return check.parseIssue(finding, check);
  }
  return defaultFindingToIssue(finding, check);
}

/**
 * Filter parsed findings against the resolved check set for this run.
 *
 * Decision 3A: drop findings whose `checkType` isn't in the requested set.
 * Returns the kept findings plus the IDs that were dropped, so the caller can
 * surface them. Exported for unit testing.
 */
export function validateFindingsAgainstChecks(
  findings: RawSemanticFinding[],
  checks: SemanticCheck[]
): { valid: RawSemanticFinding[]; dropped: string[] } {
  const requestedIds = new Set(checks.map((c) => c.id));
  const valid: RawSemanticFinding[] = [];
  const dropped: string[] = [];
  for (const finding of findings) {
    if (requestedIds.has(finding.checkType)) {
      valid.push(finding);
    } else {
      dropped.push(finding.checkType);
    }
  }
  return { valid, dropped };
}

function unionContextSections(checks: SemanticCheck[]): SemanticContextSection[] {
  const set = new Set<SemanticContextSection>();
  for (const check of checks) {
    for (const section of check.needsContext) {
      set.add(section);
    }
  }
  return Array.from(set);
}

function checksNeedScreenshot(checks: SemanticCheck[]): boolean {
  return checks.some((c) => c.needsScreenshot);
}

/**
 * Extract a screenshot from the page if any selected check needs one.
 * Falls back gracefully — screenshot failures don't abort the pass.
 */
async function ensureScreenshot(
  page: BrowserPage,
  cached: Uint8Array | undefined,
  needed: boolean
): Promise<Uint8Array | undefined> {
  if (!needed) return undefined;
  if (cached) return cached;
  try {
    return await page.screenshot({ type: "png", fullPage: false });
  } catch {
    return undefined;
  }
}

/**
 * Core orchestration shared between standalone and `audit()` paths.
 *
 * Callers are responsible for setting up `runContext.page` (and any browser
 * lifecycle) before calling this function.
 */
export async function runSemanticAudit(
  runContext: SemanticRunContext,
  options: SemanticOptions
): Promise<SemanticAuditResult> {
  const { url, page, screenshot: cachedScreenshot, pagePrepared } = runContext;
  const { onProgress, provider: providerConfig } = options;

  const checks = resolveChecks(options.checks, options.customChecks);
  if (checks.length === 0) {
    throw new Error("semanticAudit requires at least one check");
  }

  await onProgress?.({ percent: 10, message: "Resolving semantic checks" });

  if (!pagePrepared) {
    try {
      const { dismissCookieBanner } = await import("../cookie-banner.js");
      await dismissCookieBanner(page);
    } catch {
      // Banner dismissal is best-effort; never fail the run because of it.
    }
  }

  const sections = unionContextSections(checks);
  const rawContext: ExtractedContext = await extractHtmlContext(page, sections, options.context);
  await onProgress?.({ percent: 30, message: "Extracting page context" });

  const formattedContext = formatExtractedContext(rawContext);
  const sanitized = sanitizePromptContext(formattedContext);

  const screenshot = await ensureScreenshot(page, cachedScreenshot, checksNeedScreenshot(checks));

  const userPrompt = buildSemanticPrompt({
    checks,
    url,
    context: sanitized,
    formattedContext: sanitized.sanitized,
  });

  await onProgress?.({ percent: 50, message: "Calling AI provider" });

  const provider =
    runContext.providerOverride ??
    createProvider(providerConfig.name, {
      apiKey: providerConfig.apiKey,
      model: providerConfig.model,
      maxTokens: providerConfig.maxTokens,
      temperature: providerConfig.temperature,
    });

  if (!provider.analyzeSemantic) {
    throw new Error(`AI provider '${providerConfig.name}' does not implement analyzeSemantic()`);
  }

  const response = await provider.analyzeSemantic({
    prompt: userPrompt,
    screenshot,
    system: SEMANTIC_SYSTEM_PROMPT,
    timeout: options.timeout,
  });

  await onProgress?.({ percent: 80, message: "Parsing AI response" });

  const parsed = parseSemanticResponse(response.content);

  // Decision 3A: drop findings whose checkType isn't in the requested set.
  // This guards against hallucinated check IDs, typos, and findings for
  // checks that weren't actually selected for this run.
  const { valid: validFindings, dropped: droppedTypes } = validateFindingsAgainstChecks(
    parsed.findings,
    checks
  );
  if (droppedTypes.length > 0) {
    console.warn(
      `Semantic runner dropped ${droppedTypes.length} finding(s) with unknown ` +
        `or unrequested checkType: ${[...new Set(droppedTypes)].join(", ")}`
    );
  }

  const issues = validFindings.map((finding) => mapFindingToIssue(finding, checks));

  const meta: SemanticMeta = {
    detectedLanguage: parsed.detectedLanguage,
    declaredLanguage: parsed.declaredLanguage,
    landmarks: parsed.landmarks,
    overallAssessment: parsed.overallAssessment,
    checksRun: checks.map((c) => c.id),
    provider: providerConfig.name,
    model: response.model,
  };

  await onProgress?.({ percent: 100, message: "Semantic audit complete" });

  return {
    url,
    issues,
    meta,
    screenshot,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Launch a fresh Puppeteer browser, navigate to `url`, dismiss cookie banners,
 * and hand the page to `runSemanticAudit`. Used by the standalone
 * `semanticAudit(url, options)` entry point.
 *
 * Most production usage should go through `audit({ semantic: ... })`, which
 * shares a single browser between the engine pass and the semantic pass.
 */
export async function runSemanticAuditOnUrl(
  url: string,
  options: SemanticOptions
): Promise<SemanticAuditResult> {
  const session = await launchPuppeteerSession({
    headless: options.headless,
    viewport: options.viewport,
  });

  try {
    await navigateTo(session.page, url, { timeout: options.timeout });

    // Cookie-banner dismissal happens inside runSemanticAudit when
    // pagePrepared is false (which is the default for this entry point).
    return await runSemanticAudit(
      {
        url,
        page: session.page,
        ownsBrowser: true,
      },
      options
    );
  } finally {
    await closeSession(session);
  }
}
