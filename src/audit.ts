import { enhanceWithAI } from "./ai";
import { processAuditWithBaseline } from "./baseline/integration";
import { type BrowserPage, isPlaywrightPage, isPuppeteerPage, isUrl } from "./browser";
import { runPa11y } from "./engines/pa11y";
import { type LocalizationOptions, localizeIssues } from "./localization";
import {
  calculateScore,
  getScoreInterpretation,
  getSeverityLevel,
  shouldFilterPa11yIssue,
  transformPa11yIssue,
} from "./scoring";
import type { AuditOptions, AuditResult, AuditTarget, Issue, IssueSeverity } from "./types";

/** Severity hierarchy for comparison (higher index = more severe) */
const severityOrder: IssueSeverity[] = ["minor", "moderate", "serious", "critical"];

/**
 * Check if an issue's severity meets the minimum threshold
 */
function meetsSeverityThreshold(issueSeverity: IssueSeverity, minSeverity: IssueSeverity): boolean {
  const issueIndex = severityOrder.indexOf(issueSeverity);
  const minIndex = severityOrder.indexOf(minSeverity);
  return issueIndex >= minIndex;
}

/**
 * Filter issues based on severity and ignore rules
 */
function filterIssues(
  issues: Issue[],
  options: { minSeverity?: IssueSeverity; ignore?: string[] }
): Issue[] {
  const { minSeverity, ignore = [] } = options;

  return issues.filter((issue) => {
    // Filter by ignore list
    if (ignore.includes(issue.id)) {
      return false;
    }

    // Filter by minimum severity
    if (minSeverity && !meetsSeverityThreshold(issue.impact, minSeverity)) {
      return false;
    }

    return true;
  });
}

/**
 * Run an accessibility audit on a URL or browser page
 *
 * @example
 * ```typescript
 * import { audit } from '@barrieretest/core';
 *
 * // Audit a URL (launches browser automatically)
 * const result = await audit('https://example.com');
 * console.log(`Score: ${result.score}/100`);
 *
 * // Audit an existing Puppeteer page
 * const page = await browser.newPage();
 * await page.goto('https://example.com');
 * const result = await audit(page);
 *
 * // Filter by severity
 * const result = await audit('https://example.com', {
 *   minSeverity: 'serious' // Only critical and serious issues
 * });
 *
 * // Ignore specific rules
 * const result = await audit('https://example.com', {
 *   ignore: ['WCAG2AA.Principle1.Guideline1_4.1_4_3']
 * });
 * ```
 */
export async function audit(target: AuditTarget, options: AuditOptions = {}): Promise<AuditResult> {
  const {
    runners = ["htmlcs"],
    viewport = { width: 1280, height: 720 },
    headless = true,
    timeout,
    captureScreenshot = true,
    onProgress,
    detail = "actionable",
    minSeverity,
    ignore,
    baseline,
    updateBaseline,
    localization: localizationOptions,
    ai: aiOptions,
  } = options;

  // Determine if we have a page object or URL
  let url: string;
  let page: BrowserPage | undefined;

  if (isUrl(target)) {
    url = target;
  } else if (isPuppeteerPage(target)) {
    page = target;
    url = target.url();
  } else if (isPlaywrightPage(target)) {
    // Playwright pages are not directly supported by Pa11y
    // We'll need to convert or use a different approach
    throw new Error("Playwright pages are not yet supported. Please use a Puppeteer page or URL.");
  } else {
    throw new Error("Invalid target: expected URL string, Puppeteer page, or Playwright page");
  }

  // Run Pa11y audit
  const pa11yResult = await runPa11y(url, {
    runners,
    viewport,
    headless,
    timeout,
    onProgress,
    page,
  });

  // Filter false positives and transform issues
  const filteredIssues = pa11yResult.issues.filter((issue) => !shouldFilterPa11yIssue(issue));
  let transformedIssues: Issue[] = filteredIssues.map(transformPa11yIssue);

  // Apply user-specified filters
  transformedIssues = filterIssues(transformedIssues, { minSeverity, ignore });

  // Process baseline integration
  const baselineResult = await processAuditWithBaseline(transformedIssues, pa11yResult.pageUrl, {
    baseline,
    updateBaseline,
  });

  // Run localization when detail is 'fix-ready' and we have a page
  // Localization requires a page object to query the DOM
  const shouldLocalize = detail === "fix-ready" && page && localizationOptions?.enabled !== false;

  if (shouldLocalize && page) {
    try {
      await onProgress?.({ percent: 70, message: "Localizing issues" });
    } catch {
      /* callback error shouldn't crash audit */
    }

    const localizationOpts: LocalizationOptions = {
      captureScreenshots: localizationOptions?.captureScreenshots ?? true,
      projectRoot: localizationOptions?.projectRoot,
      customAttributes: localizationOptions?.customAttributes,
      enabledStrategies: localizationOptions?.enabledStrategies,
    };

    const localizedIssues = await localizeIssues(page, transformedIssues, localizationOpts);

    // Update issues with localization data
    transformedIssues = localizedIssues;
  }

  // Run AI enhancement if configured
  if (aiOptions) {
    try {
      await onProgress?.({ percent: 85, message: "Running AI analysis" });
    } catch {
      /* callback error shouldn't crash audit */
    }

    try {
      const enhancedIssues = await enhanceWithAI(transformedIssues, {
        provider: aiOptions.provider,
        config: {
          apiKey: aiOptions.apiKey,
          model: aiOptions.model,
        },
        maxIssues: aiOptions.maxIssues,
        concurrency: aiOptions.concurrency,
        continueOnError: true,
      });

      transformedIssues = enhancedIssues;
    } catch (error) {
      // AI is best-effort, don't fail the audit
      console.warn(
        `AI enhancement failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  // Calculate score (based on filtered issues)
  const score = calculateScore(transformedIssues);
  const severityLevel = getSeverityLevel(score);
  const scoreInterpretation = getScoreInterpretation(score);

  // Report completion
  try {
    await onProgress?.({ percent: 100, message: "Audit complete" });
  } catch {
    /* callback error shouldn't crash audit */
  }

  return {
    url: pa11yResult.pageUrl,
    documentTitle: pa11yResult.documentTitle,
    score,
    severityLevel,
    scoreInterpretation,
    issues: transformedIssues,
    screenshot: captureScreenshot ? pa11yResult.screenshot : undefined,
    timestamp: new Date().toISOString(),
    baseline: baselineResult.baseline,
  };
}
