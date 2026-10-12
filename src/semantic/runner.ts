/**
 * Semantic-audit runner.
 *
 * Orchestrates the steps of a semantic accessibility pass:
 *   1. Resolve the requested checks (built-ins ∪ custom) and group them by
 *      model tier ("small" for cheap per-element checks, "large" otherwise).
 *   2. Extract only the HTML context categories the selected checks need.
 *   3. Sanitize the context, capture one screenshot for all tiers.
 *   4. Per tier: build a prompt listing that tier's checks and send one
 *      request, natively schema-constrained when the model supports it.
 *   5. Parse each response, map findings to `Issue[]`, merge, return result.
 *
 * The runner accepts a live `BrowserPage` (typical: called from `audit()`
 * which already has one) or launches its own browser when given a URL.
 */

import { createProvider } from "../ai/index.js";
import { DEFAULT_MAX_TOKENS, SEMANTIC_MIN_MAX_TOKENS } from "../ai/providers/shared.js";
import type { AIProvider, ModelCapabilities, ModelResponse } from "../ai/types.js";
import type { BrowserPage } from "../browser.js";
import { closeSession, launchPuppeteerSession, navigateTo } from "../puppeteer-launch.js";
import type { Issue } from "../types.js";
import { resolveChecks } from "./checks/index.js";
import { type ExtractedContext, extractHtmlContext, formatExtractedContext } from "./context.js";
import {
  type ParsedSemanticResponse,
  parseSemanticObject,
  parseSemanticResponse,
} from "./parse.js";
import { buildSemanticPrompt, SEMANTIC_SYSTEM_PROMPT } from "./prompt.js";
import { type SanitizedPromptContext, sanitizePromptContext } from "./sanitize.js";
import { buildSemanticResponseSchema } from "./schema.js";
import {
  type RawSemanticFinding,
  SEMANTIC_SEVERITY_MAP,
  type SemanticAuditResult,
  type SemanticCheck,
  type SemanticContextSection,
  type SemanticMeta,
  type SemanticModelTier,
  type SemanticOptions,
  type SemanticProviderConfig,
  type SemanticTierMeta,
} from "./types.js";

/**
 * Merge and reporting order. The large tier owns the page-level metadata, so
 * it comes first; `SEMANTIC_MODEL_TIERS` is the public, declaration-order list.
 */
const TIER_ORDER: readonly SemanticModelTier[] = ["large", "small"];

/**
 * Capabilities assumed for a provider that declares none — hand-written
 * providers and test stubs. Vision is assumed because that is how those
 * providers behaved before capabilities existed; structured output is not,
 * because it needs `complete()`.
 */
const UNDECLARED_CAPABILITIES: ModelCapabilities = { vision: true, jsonSchema: false };

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
   * Internal: inject a fully constructed AIProvider for every tier, bypassing
   * `createProvider()`. Used by tests to avoid hitting real APIs.
   */
  providerOverride?: AIProvider;
  /** Internal: per-tier injection, winning over `providerOverride`. */
  tierProviderOverrides?: Partial<Record<SemanticModelTier, AIProvider>>;
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
 * Group the resolved checks by the tier that will run them, preserving
 * resolution order inside each group.
 */
function groupChecksByTier(checks: SemanticCheck[]): Map<SemanticModelTier, SemanticCheck[]> {
  const groups = new Map<SemanticModelTier, SemanticCheck[]>();
  for (const check of checks) {
    const tier = check.tier ?? "large";
    const group = groups.get(tier);
    if (group) {
      group.push(check);
    } else {
      groups.set(tier, [check]);
    }
  }
  return groups;
}

/**
 * Resolve the provider for one tier: explicit test overrides first, then the
 * tier's own configuration.
 */
function resolveTierProvider(
  runContext: SemanticRunContext,
  tier: SemanticModelTier,
  config: SemanticProviderConfig,
  timeout: number | undefined
): AIProvider {
  const override = runContext.tierProviderOverrides?.[tier] ?? runContext.providerOverride;
  if (override) {
    return override;
  }
  return createProvider(config.name, {
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    baseUrl: config.baseUrl,
    capabilities: config.capabilities,
    reasoningEffort: config.reasoningEffort,
    timeout,
  });
}

interface TierRunResult {
  tier: SemanticModelTier;
  checks: SemanticCheck[];
  parsed: ParsedSemanticResponse;
  provider: string;
  model: string;
}

/**
 * One tier, resolved and checked, ready to be sent. Built by the preflight
 * phase so that every configuration error surfaces before the first request.
 */
interface PreparedTier {
  tier: SemanticModelTier;
  checks: SemanticCheck[];
  config: SemanticProviderConfig;
  provider: AIProvider;
  /** The shared screenshot, but only when this tier's checks need it. */
  screenshot: Uint8Array | undefined;
  url: string;
  context: SanitizedPromptContext;
  timeout: number | undefined;
}

/**
 * Reject a tier whose checks need the screenshot on a model that cannot see
 * images. Synchronous on purpose: preflight calls it before any request goes
 * out, so a misconfigured tier never costs a call on the other one.
 */
function assertTierCanSeeScreenshot(entry: PreparedTier): void {
  const { tier, checks, config, provider, screenshot } = entry;
  const capabilities = provider.capabilities ?? UNDECLARED_CAPABILITIES;

  if (!screenshot || capabilities.vision) return;

  const visionCheckIds = checks.filter((c) => c.needsScreenshot).map((c) => c.id);
  throw new Error(
    `Semantic tier '${tier}' needs a screenshot for check(s) ${visionCheckIds.join(", ")}, ` +
      `but model '${provider.model ?? config.model ?? "unknown"}' on provider ` +
      `'${config.name}' does not support images. Pick a vision model for this tier ` +
      `or deselect those checks.`
  );
}

/**
 * Parse a tier's text answer. A provider that returns truncated text instead
 * of throwing leaves a bare JSON syntax error as the only symptom, so name
 * the budget that caused it.
 */
function parseTierText(
  tier: SemanticModelTier,
  response: ModelResponse,
  sentMaxTokens: number
): ParsedSemanticResponse {
  try {
    return parseSemanticResponse(response.text);
  } catch (error) {
    if (response.finishReason === "length") {
      throw new Error(
        `Semantic tier '${tier}': response was cut off by max_tokens (${sentMaxTokens}); ` +
          `raise maxTokens for this tier`
      );
    }
    throw error;
  }
}

/**
 * Send one tier's request and parse its response.
 */
async function runTier(entry: PreparedTier): Promise<TierRunResult> {
  const { tier, checks, config, provider, url, context, screenshot, timeout } = entry;

  const capabilities = provider.capabilities ?? UNDECLARED_CAPABILITIES;

  const prompt = buildSemanticPrompt({
    checks,
    url,
    context,
    formattedContext: context.sanitized,
  });

  if (provider.complete && capabilities.jsonSchema) {
    const sentMaxTokens = Math.max(config.maxTokens ?? DEFAULT_MAX_TOKENS, SEMANTIC_MIN_MAX_TOKENS);
    const response = await provider.complete({
      system: SEMANTIC_SYSTEM_PROMPT,
      text: prompt,
      images: screenshot ? [{ png: screenshot }] : undefined,
      responseSchema: buildSemanticResponseSchema(checks.map((c) => c.id)),
      maxTokens: sentMaxTokens,
      timeout,
    });

    return {
      tier,
      checks,
      // A model that ignored the schema still returns usable text.
      parsed:
        response.json !== undefined
          ? parseSemanticObject(response.json)
          : parseTierText(tier, response, sentMaxTokens),
      provider: config.name,
      model: response.model,
    };
  }

  if (!provider.analyzeSemantic) {
    throw new Error(`AI provider '${config.name}' does not implement analyzeSemantic()`);
  }

  const response = await provider.analyzeSemantic({
    prompt,
    screenshot,
    system: SEMANTIC_SYSTEM_PROMPT,
    timeout,
  });

  return {
    tier,
    checks,
    parsed: parseSemanticResponse(response.content),
    provider: config.name,
    model: response.model,
  };
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

  const groups = groupChecksByTier(checks);
  const activeTiers = TIER_ORDER.filter((tier) => groups.has(tier));

  // Phase 1 — preflight: resolve every tier and announce it before anything
  // is sent, so a configuration error costs no request on any tier.
  const prepared: PreparedTier[] = [];
  for (const [index, tier] of activeTiers.entries()) {
    await onProgress?.({
      percent: 50 + Math.round((index * 25) / activeTiers.length),
      message: `Calling AI provider (${tier})`,
    });

    const tierConfig = options.tiers?.[tier] ?? providerConfig;
    const groupChecks = groups.get(tier) ?? [];

    const entry: PreparedTier = {
      tier,
      checks: groupChecks,
      config: tierConfig,
      provider: resolveTierProvider(runContext, tier, tierConfig, options.timeout),
      screenshot: checksNeedScreenshot(groupChecks) ? screenshot : undefined,
      url,
      context: sanitized,
      timeout: options.timeout,
    };
    assertTierCanSeeScreenshot(entry);
    prepared.push(entry);
  }

  // Phase 2 — send: nothing is awaited between creating the request promises
  // and `Promise.all` attaching its handlers, so an early tier failure always
  // arrives through the returned promise instead of as an unhandled rejection.
  const results = await Promise.all(prepared.map((entry) => runTier(entry)));

  await onProgress?.({ percent: 80, message: "Parsing AI response" });

  // Decision 3A: drop findings whose checkType isn't in the requested set.
  // This guards against hallucinated check IDs, typos, and findings for
  // checks that weren't actually selected for this run — per tier, so a tier
  // cannot report on a check that went to the other model.
  const issues: Issue[] = [];
  const tiers: Partial<Record<SemanticModelTier, SemanticTierMeta>> = {};
  for (const result of results) {
    const { valid: validFindings, dropped: droppedTypes } = validateFindingsAgainstChecks(
      result.parsed.findings,
      result.checks
    );
    if (droppedTypes.length > 0) {
      console.warn(
        `Semantic runner dropped ${droppedTypes.length} finding(s) with unknown ` +
          `or unrequested checkType: ${[...new Set(droppedTypes)].join(", ")}`
      );
    }

    for (const finding of validFindings) {
      issues.push(mapFindingToIssue(finding, result.checks));
    }

    tiers[result.tier] = {
      provider: result.provider,
      model: result.model,
      checksRun: result.checks.map((c) => c.id),
    };
  }

  // Page-level metadata is a property of the whole page, so it comes from the
  // holistic tier whenever that one ran.
  const primary = results.find((r) => r.tier === "large") ?? results[0];

  const meta: SemanticMeta = {
    detectedLanguage: primary.parsed.detectedLanguage,
    declaredLanguage: primary.parsed.declaredLanguage,
    landmarks: primary.parsed.landmarks,
    overallAssessment: primary.parsed.overallAssessment,
    checksRun: checks.map((c) => c.id),
    provider: primary.provider,
    model: primary.model,
    tiers,
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
