import { enhanceWithAI } from "./ai/index.js";
import { processAuditWithBaseline } from "./baseline/integration.js";
import {
  type BrowserPage,
  isBrowserPage,
  isPlaywrightPage,
  isPuppeteerPage,
  isUrl,
} from "./browser.js";
import { runAxeCore } from "./engines/axe.js";
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
 * // Uses axe-core by default
 * const result = await audit('https://example.com');
 *
 * // Use pa11y engine (requires puppeteer + pa11y)
 * const pa11yResult = await audit('https://example.com', { engine: 'pa11y' });
 *
 * // Pass a Playwright or Puppeteer page directly
 * const fromPage = await audit(page);
 * ```
 */
export async function audit(target: AuditTarget, options: AuditOptions = {}): Promise<AuditResult> {
  const {
    engine = "axe",
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
  } else if (isPuppeteerPage(target) || isPlaywrightPage(target) || isBrowserPage(target)) {
    page = target;
    url = target.url();
  } else {
    throw new Error("Invalid target: expected a URL string or browser page");
  }

  // ---- Run the selected engine ----

  let engineResult: {
    issues: Issue[];
    documentTitle: string;
    pageUrl: string;
    screenshot?: Uint8Array;
  };

  if (engine === "axe") {
    engineResult = await runAxeCore(url, {
      viewport,
      headless,
      timeout,
      onProgress,
      page,
    });
  } else {
    // pa11y engine — dynamic import so pa11y/puppeteer are optional
    const runners = options.runners ?? ["htmlcs"];

    if (page && !isPuppeteerPage(page)) {
      throw new Error(
        "Pa11y engine only supports Puppeteer pages. Use engine: 'axe' for Playwright."
      );
    }

    let runPa11yFn: typeof import("./engines/pa11y.js").runPa11y;
    try {
      const mod = await import("./engines/pa11y.js");
      runPa11yFn = mod.runPa11y;
    } catch {
      throw new Error(
        "Pa11y engine requires 'pa11y' and 'puppeteer' packages. Install them or use engine: 'axe'."
      );
    }

    const pa11yResult = await runPa11yFn(url, {
      runners,
      viewport,
      headless,
      timeout,
      onProgress,
      page,
    });

    const filteredIssues = pa11yResult.issues.filter((issue) => !shouldFilterPa11yIssue(issue));

    engineResult = {
      issues: filteredIssues.map(transformPa11yIssue),
      documentTitle: pa11yResult.documentTitle,
      pageUrl: pa11yResult.pageUrl,
      screenshot: pa11yResult.screenshot,
    };
  }

  // ---- Post-engine processing (engine-agnostic) ----

  let transformedIssues: Issue[] = filterIssues(engineResult.issues, { minSeverity, ignore });

  const baselineResult = await processAuditWithBaseline(
    transformedIssues,
    engineResult.pageUrl,
    {
      baseline,
      updateBaseline,
    }
  );

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
    url: engineResult.pageUrl,
    documentTitle: engineResult.documentTitle,
    score,
    severityLevel,
    scoreInterpretation,
    issues: transformedIssues,
    screenshot: captureScreenshot ? engineResult.screenshot : undefined,
    timestamp: new Date().toISOString(),
    baseline: baselineResult.baseline,
  };
}
