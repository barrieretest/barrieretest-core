import { enhanceWithAI } from "./ai/index.js";
import { processAuditWithBaseline } from "./baseline/integration.js";
import { type BrowserPage, isPlaywrightPage, isPuppeteerPage, isUrl } from "./browser.js";
import { runPa11y } from "./engines/pa11y.js";
import { type LocalizationOptions, localizeIssues } from "./localization/index.js";
import {
  calculateScore,
  getScoreInterpretation,
  getSeverityLevel,
  shouldFilterPa11yIssue,
  transformPa11yIssue,
} from "./scoring.js";
import type { AuditOptions, AuditResult, AuditTarget, Issue, IssueSeverity } from "./types.js";

const severityOrder: IssueSeverity[] = ["minor", "moderate", "serious", "critical"];

function meetsSeverityThreshold(issueSeverity: IssueSeverity, minSeverity: IssueSeverity): boolean {
  const issueIndex = severityOrder.indexOf(issueSeverity);
  const minIndex = severityOrder.indexOf(minSeverity);
  return issueIndex >= minIndex;
}

function filterIssues(
  issues: Issue[],
  options: { minSeverity?: IssueSeverity; ignore?: string[] }
): Issue[] {
  const { minSeverity, ignore = [] } = options;

  return issues.filter((issue) => {
    if (ignore.includes(issue.id)) {
      return false;
    }

    if (minSeverity && !meetsSeverityThreshold(issue.impact, minSeverity)) {
      return false;
    }

    return true;
  });
}

/**
 * Runs a single-page accessibility audit.
 *
 * @example
 * ```typescript
 * import { audit } from '@barrieretest/core';
 *
 * const result = await audit('https://example.com');
 * const filtered = await audit('https://example.com', { minSeverity: 'serious' });
 * const fromPage = await audit(page);
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

  let url: string;
  let page: BrowserPage | undefined;

  if (isUrl(target)) {
    url = target;
  } else if (isPuppeteerPage(target)) {
    page = target;
    url = target.url();
  } else if (isPlaywrightPage(target)) {
    throw new Error("Playwright pages are not supported directly. Pass a URL or Puppeteer page.");
  } else {
    throw new Error("Invalid target: expected a URL string or Puppeteer page");
  }

  const pa11yResult = await runPa11y(url, {
    runners,
    viewport,
    headless,
    timeout,
    onProgress,
    page,
  });

  const filteredIssues = pa11yResult.issues.filter((issue) => !shouldFilterPa11yIssue(issue));
  let transformedIssues: Issue[] = filteredIssues.map(transformPa11yIssue);

  transformedIssues = filterIssues(transformedIssues, { minSeverity, ignore });

  const baselineResult = await processAuditWithBaseline(transformedIssues, pa11yResult.pageUrl, {
    baseline,
    updateBaseline,
  });

  const shouldLocalize = detail === "fix-ready" && page && localizationOptions?.enabled !== false;

  if (shouldLocalize && page) {
    try {
      await onProgress?.({ percent: 70, message: "Localizing issues" });
    } catch {
      /* ignore progress callback errors */
    }

    const localizationOpts: LocalizationOptions = {
      captureScreenshots: localizationOptions?.captureScreenshots ?? true,
      projectRoot: localizationOptions?.projectRoot,
      customAttributes: localizationOptions?.customAttributes,
      enabledStrategies: localizationOptions?.enabledStrategies,
    };

    transformedIssues = await localizeIssues(page, transformedIssues, localizationOpts);
  }

  if (aiOptions) {
    try {
      await onProgress?.({ percent: 85, message: "Running AI analysis" });
    } catch {
      /* ignore progress callback errors */
    }

    try {
      transformedIssues = await enhanceWithAI(transformedIssues, {
        provider: aiOptions.provider,
        config: {
          apiKey: aiOptions.apiKey,
          model: aiOptions.model,
        },
        maxIssues: aiOptions.maxIssues,
        concurrency: aiOptions.concurrency,
        continueOnError: true,
      });
    } catch (error) {
      console.warn(
        `AI enhancement failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  const score = calculateScore(transformedIssues);
  const severityLevel = getSeverityLevel(score);
  const scoreInterpretation = getScoreInterpretation(score);

  try {
    await onProgress?.({ percent: 100, message: "Audit complete" });
  } catch {
    /* ignore progress callback errors */
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
