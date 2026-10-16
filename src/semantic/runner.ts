/**
 * Semantic-audit runner.
 *
 * Orchestrates the steps of a semantic accessibility pass:
 *   1. Resolve the requested checks (built-ins ∪ custom) and group them by
 *      model tier ("small" for cheap per-element checks, "large" otherwise).
 *   2. Extract only the HTML context categories the selected checks need.
 *   3. Capture one screenshot for all tiers.
 *   4. Per tier: format and sanitize only the context sections that tier's
 *      checks need, build a prompt listing that tier's checks, and send one
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
import {
  checkNavigationStatus,
  closeSession,
  describeUnnavigatedPage,
  launchPuppeteerSession,
  navigateAndInspect,
} from "../puppeteer-launch.js";
import type { Issue } from "../types.js";
import { resolveChecks } from "./checks/index.js";
import { type ExtractedContext, extractHtmlContext, formatExtractedContext } from "./context.js";
import {
  type ParsedSemanticResponse,
  parseSemanticObject,
  parseSemanticResponse,
} from "./parse.js";
import {
  buildSemanticPrompt,
  buildSemanticPromptPrefix,
  SEMANTIC_SYSTEM_PROMPT,
} from "./prompt.js";
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
 * Findings below this normalized confidence are dropped: models use a
 * near-zero confidence for entries they have themselves concluded are not
 * failures, and those reached the report as false positives.
 */
const MIN_FINDING_CONFIDENCE = 0.1;

/**
 * Confidence comes back as 0-100 (`RawSemanticFinding.confidence`, and the
 * prompt asks for that range); normalize to 0-1 and clamp so the documented
 * `SemanticIssueMeta.confidence` contract holds even when the model returns
 * out-of-range values. The scale is never guessed from the magnitude: read as
 * "already normalized", a `confidence` of 1 — one percent, the value a model
 * uses for an entry it has itself dismissed — became full confidence and
 * passed the guard below. A finding without a confidence is treated as
 * moderately confident.
 */
function normalizeConfidence(finding: RawSemanticFinding): number {
  const rawConfidence = typeof finding.confidence === "number" ? finding.confidence : 50;
  return Math.min(1, Math.max(0, rawConfidence / 100));
}

/**
 * Default mapping from a raw finding into the standard `Issue` shape.
 */
function defaultFindingToIssue(
  finding: RawSemanticFinding,
  check: SemanticCheck | undefined
): Issue {
  const checkId = check?.id ?? finding.checkType;
  const normalizedConfidence = normalizeConfidence(finding);

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

/**
 * Split findings into the ones confident enough to report and the count of
 * those the model rated below `MIN_FINDING_CONFIDENCE`.
 */
function filterByConfidence(findings: RawSemanticFinding[]): {
  confident: RawSemanticFinding[];
  droppedCount: number;
} {
  const confident = findings.filter(
    (finding) => normalizeConfidence(finding) >= MIN_FINDING_CONFIDENCE
  );
  return { confident, droppedCount: findings.length - confident.length };
}

/** Severity ranking used when two findings for the same element are merged. */
const SEVERITY_RANK: Record<RawSemanticFinding["severity"], number> = {
  notice: 0,
  warning: 1,
  error: 2,
};

/**
 * Key two findings as the same element: same check, same location ignoring
 * surrounding whitespace. Nothing else is normalized: a location is a CSS
 * selector, where case (`#Logo` vs `#logo`) and inner whitespace (`.a .b` vs
 * `.a.b`) address different elements, so collapsing either merged the
 * findings for two elements into one issue.
 */
function elementKey(finding: RawSemanticFinding): string {
  return `${finding.checkType}\u0000${finding.location.trim()}`;
}

/**
 * Merge findings that report the same element for the same check. Models
 * split one element's failure into one entry per reason; the report should
 * carry one issue per element, so the later messages are appended to the
 * first and the strongest severity wins. A finding without a location cannot
 * be attributed to an element and is never merged.
 */
function dedupeByElement(findings: RawSemanticFinding[]): {
  merged: RawSemanticFinding[];
  mergedCount: number;
} {
  const byElement = new Map<string, RawSemanticFinding>();
  const merged: RawSemanticFinding[] = [];
  let mergedCount = 0;

  for (const finding of findings) {
    if (!finding.location.trim()) {
      merged.push(finding);
      continue;
    }

    const key = elementKey(finding);
    const first = byElement.get(key);
    if (!first) {
      const copy = { ...finding };
      byElement.set(key, copy);
      merged.push(copy);
      continue;
    }

    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[first.severity]) {
      first.severity = finding.severity;
    }
    const addition = finding.message.trim();
    if (addition && !first.message.includes(addition)) {
      first.message = `${first.message.trim()} ${addition}`.trim();
    }
    mergedCount++;
  }

  return { merged, mergedCount };
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
  /** Only the `complete()` path reports usage; `analyzeSemantic()` does not. */
  usage?: SemanticTierMeta["usage"];
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
  /** The shared extraction, narrowed to the sections this tier's checks need. */
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
 * FNV-1a over the constant part of the request. Not a security hash: it only
 * has to change when the prompt text changes, so a cache key never outlives
 * the prefix it stands for.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable routing hint for the provider's prefix cache. Derived from the
 * constant part of the request only — system prompt plus check-dependent
 * prefix — so two pages audited with the same check set share a key and
 * nothing page-specific or sensitive leaves with it.
 */
function tierCacheKey(tier: SemanticModelTier, promptPrefix: string): string {
  return `barrieretest-semantic-${tier}-${fnv1a(`${SEMANTIC_SYSTEM_PROMPT}${promptPrefix}`)}`;
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

  // `complete()` carries the cache key, the maxTokens floor, the timeout and
  // the usage report, all of which apply whether or not the model can be
  // schema-constrained; only `responseSchema` depends on that capability.
  if (provider.complete) {
    const sentMaxTokens = Math.max(config.maxTokens ?? DEFAULT_MAX_TOKENS, SEMANTIC_MIN_MAX_TOKENS);
    const response = await provider.complete({
      system: SEMANTIC_SYSTEM_PROMPT,
      text: prompt,
      images: screenshot ? [{ png: screenshot }] : undefined,
      ...(capabilities.jsonSchema
        ? { responseSchema: buildSemanticResponseSchema(checks.map((c) => c.id)) }
        : {}),
      maxTokens: sentMaxTokens,
      cacheKey: tierCacheKey(tier, buildSemanticPromptPrefix(checks)),
      timeout,
    });

    return {
      tier,
      checks,
      // No schema sent, or a model that ignored one: the answer is text.
      parsed:
        response.json !== undefined
          ? parseSemanticObject(response.json)
          : parseTierText(tier, response, sentMaxTokens),
      provider: config.name,
      model: response.model,
      ...(response.usage ? { usage: response.usage } : {}),
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

    // One extraction serves every tier, but each tier only sees the sections
    // its own checks need: a tier handed the union found the elements it was
    // asked about again in another tier's section and reported them there.
    const tierContext = sanitizePromptContext(
      formatExtractedContext(rawContext, unionContextSections(groupChecks))
    );

    const entry: PreparedTier = {
      tier,
      checks: groupChecks,
      config: tierConfig,
      provider: resolveTierProvider(runContext, tier, tierConfig, options.timeout),
      screenshot: checksNeedScreenshot(groupChecks) ? screenshot : undefined,
      url,
      context: tierContext,
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

    const { confident, droppedCount } = filterByConfidence(validFindings);
    if (droppedCount > 0) {
      console.warn(
        `Semantic runner dropped ${droppedCount} finding(s) the model rated below ` +
          `${Math.round(MIN_FINDING_CONFIDENCE * 100)}% confidence`
      );
    }

    const { merged, mergedCount } = dedupeByElement(confident);
    if (mergedCount > 0) {
      console.warn(
        `Semantic runner merged ${mergedCount} duplicate finding(s) for the same element`
      );
    }

    for (const finding of merged) {
      issues.push(mapFindingToIssue(finding, result.checks));
    }

    tiers[result.tier] = {
      provider: result.provider,
      model: result.model,
      checksRun: result.checks.map((c) => c.id),
      ...(result.usage ? { usage: result.usage } : {}),
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
    // This entry point never navigates: it is handed a page and audits it
    // where it is. `runSemanticAuditOnUrl` replaces this with the facts of
    // the navigation it performed.
    navigation: describeUnnavigatedPage(url, page.url()),
  };
}

/**
 * Launch a fresh Puppeteer browser, navigate to `url`, dismiss cookie banners,
 * load lazy content, and hand the page to `runSemanticAudit`. Used by the
 * standalone `semanticAudit(url, options)` entry point.
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
    const outcome = await navigateAndInspect(session.page, url, { timeout: options.timeout });
    // Before the banner, the scroll, the context extraction and the
    // screenshot: with `failOnHttpError` an error page must cost no further
    // work and no AI request.
    checkNavigationStatus(outcome, { failOnHttpError: options.failOnHttpError });

    // This path navigated itself, so it prepares the page here instead of
    // leaving banner dismissal to `runSemanticAudit`: lazy content has to be
    // loaded after the banner is gone (a banner can lock body scrolling) and
    // before the context extraction and the screenshot.
    try {
      const { dismissCookieBanner } = await import("../cookie-banner.js");
      await dismissCookieBanner(session.page);
    } catch {
      // Banner dismissal is best-effort; never fail the run because of it.
    }

    if (options.loadLazyContent !== false) {
      const { loadLazyContent } = await import("../lazy-content.js");
      await loadLazyContent(session.page);
    }

    const result = await runSemanticAudit(
      {
        url,
        page: session.page,
        ownsBrowser: true,
        pagePrepared: true,
      },
      options
    );

    return { ...result, navigation: outcome.navigation };
  } finally {
    await closeSession(session);
  }
}
