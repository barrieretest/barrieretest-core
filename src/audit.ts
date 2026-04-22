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
import { type LaunchedSession, closeSession, launchPuppeteerSession } from "./puppeteer-launch.js";
import {
  calculateScore,
  getScoreInterpretation,
  getSeverityLevel,
  shouldFilterPa11yIssue,
  transformPa11yIssue,
} from "./scoring.js";
import { runSemanticAudit } from "./semantic/runner.js";
import type { SemanticMeta } from "./semantic/types.js";
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
    semantic: semanticOptions,
  } = options;

  let url: string;
  let page: BrowserPage | undefined;
  // When `semantic` is requested with a URL target, audit() owns the browser
  // so the engine and semantic passes can share a single page (no second
  // browser launch). The session is created inside the try/finally below
  // so any failure before the engine pass still releases it.
  //
  // Note: we deliberately do NOT navigate or dismiss cookie banners here.
  // The engine pass (axe / pa11y) does both right after we hand it the page,
  // so doing it twice would be wasted work and could leave the semantic
  // pass with a stale screenshot vs fresh DOM.
  let ownedSession: LaunchedSession | null = null;

  if (isUrl(target)) {
    url = target;
  } else if (isPuppeteerPage(target) || isPlaywrightPage(target) || isBrowserPage(target)) {
    page = target;
    url = target.url();
  } else {
    throw new Error("Invalid target: expected a URL string or browser page");
  }

  try {
    if (isUrl(target) && semanticOptions && engine === "axe") {
      ownedSession = await launchPuppeteerSession({ headless, viewport });
      page = ownedSession.page;
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
    //
    // Order:
    // 1. Early-filter engine issues with the user's `minSeverity`/`ignore` so
    //    we don't burn localization or per-issue AI on issues that wouldn't
    //    show up in the final result anyway.
    // 2. Localize / AI-enhance the surviving engine issues. Semantic findings
    //    are NOT localized or per-issue-enhanced in this release (decision 7A).
    // 3. Run the semantic pass and collect its issues separately.
    // 4. Merge engine + semantic, then re-apply the same filter to the
    //    combined set so semantic findings also obey `minSeverity`/`ignore`.
    // 5. Run baseline processing on the final merged + filtered list.

    let engineIssues: Issue[] = filterIssues(engineResult.issues, { minSeverity, ignore });

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

      engineIssues = await localizeIssues(page, engineIssues, localizationOpts);
    }

    if (aiOptions) {
      try {
        await onProgress?.({ percent: 80, message: "Running AI analysis" });
      } catch {
        /* ignore progress callback errors */
      }

      try {
        engineIssues = await enhanceWithAI(engineIssues, {
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

    let semanticIssues: Issue[] = [];
    let semanticMeta: SemanticMeta | undefined;
    if (semanticOptions && page) {
      try {
        await onProgress?.({ percent: 88, message: "Running semantic audit" });
      } catch {
        /* ignore progress callback errors */
      }

      try {
        const semanticResult = await runSemanticAudit(
          {
            url: engineResult.pageUrl,
            page,
            ownsBrowser: false,
            screenshot: engineResult.screenshot,
            // The engine pass (axe / pa11y) just navigated and dismissed cookie
            // banners on this page; tell the semantic runner to skip its own
            // preparation step instead of doing it again.
            pagePrepared: true,
          },
          semanticOptions
        );
        semanticIssues = semanticResult.issues;
        semanticMeta = semanticResult.meta;
      } catch (error) {
        // Decision 2A: semantic failure must not fail the whole audit.
        console.warn(
          `Semantic audit failed: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    } else if (semanticOptions && !page) {
      // URL target with non-axe engine: we don't own the page, so semantic
      // would have to launch a second browser. Surface this clearly rather
      // than silently doing the wasteful thing.
      console.warn(
        "audit({ semantic }) currently requires engine: 'axe' or a pre-existing browser page; semantic pass skipped."
      );
    }

    // Merge engine (already filtered) with semantic findings, then re-apply
    // the same filter so semantic findings also obey `minSeverity` / `ignore`.
    // The second pass over engine issues is a no-op since they were already
    // filtered above.
    const mergedIssues = [...engineIssues, ...semanticIssues];
    const filteredIssues = filterIssues(mergedIssues, { minSeverity, ignore });

    const baselineResult = await processAuditWithBaseline(filteredIssues, engineResult.pageUrl, {
      baseline,
      updateBaseline,
    });

    const score = calculateScore(filteredIssues);
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
      issues: filteredIssues,
      screenshot: captureScreenshot ? engineResult.screenshot : undefined,
      timestamp: new Date().toISOString(),
      baseline: baselineResult.baseline,
      semanticMeta,
    };
  } finally {
    if (ownedSession) {
      await closeSession(ownedSession);
    }
  }
}
