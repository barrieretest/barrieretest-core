/**
 * Axe-core accessibility engine.
 *
 * Injects axe-core into a browser page (Puppeteer or Playwright) and runs
 * a full accessibility audit. Results are transformed into the standardised
 * `Issue` format used throughout the library.
 */

import type { BrowserPage, PuppeteerBrowserLike, PuppeteerPageLike } from "../browser.js";
import {
  checkNavigationStatus,
  describeUnnavigatedPage,
  launchPuppeteerSession,
  navigateAndInspect,
} from "../puppeteer-launch.js";
import type { BrowserLaunchOptions, Issue, IssueSeverity, NavigationInfo } from "../types.js";

export type AxeNodeResult = {
  html: string;
  impact?: string | null;
  target: (string | string[])[];
  failureSummary?: string;
};

export type AxeViolation = {
  id: string;
  impact?: string | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeNodeResult[];
};

export type AxeRunnerOptions = {
  viewport?: { width: number; height: number };
  headless?: boolean;
  timeout?: number;
  onProgress?: (data: { percent: number; message: string }) => void | Promise<void>;
  page?: BrowserPage;
  /** Scroll the page once before auditing so lazy content loads. Default true. */
  loadLazyContent?: boolean;
  /**
   * Throw a `NavigationHttpError` when the navigation this call performs
   * answers with a status `>= 400`, before any other work on the page.
   * Default false (audit the served page, warn once).
   */
  failOnHttpError?: boolean;
  /**
   * Proxy and extra Chromium arguments for a browser this call launches. A
   * page passed in through `page` keeps the configuration its owner gave it.
   */
  browser?: BrowserLaunchOptions;
};

export type AxeRunResult = {
  issues: Issue[];
  documentTitle: string;
  pageUrl: string;
  screenshot?: Uint8Array;
  /** What the navigation did, or that this run navigated nothing. */
  navigation: NavigationInfo;
};

type AxeResults = {
  violations: AxeViolation[];
};

/** What `axe.run` takes as its second argument; only what we set. */
export type AxeRunOptions = {
  rules?: Record<string, { enabled: boolean }>;
  runOnly?: { type: "rule"; values: string[] };
};

/**
 * Rules the pass turns on beyond axe's defaults.
 *
 * `target-size` (WCAG 2.5.8) ships disabled in axe-core, so nothing in the
 * stack ever reported an undersized touch target. Enabling it here is the
 * contract's decision 2 of 2026-10-14: it applies to every audit, not only
 * to one with `rendering`, and it changes the score of audits that have
 * small targets.
 */
export const AXE_ENABLED_RULES: Record<string, { enabled: boolean }> = {
  "target-size": { enabled: true },
};

type AxeSourceExport = {
  source: string;
};

type AxeRuntime = {
  axe?: {
    run: (context: Document, options?: AxeRunOptions) => Promise<AxeResults>;
  };
};

export type AxeLoadFailureMessageInput = {
  url?: string;
  status?: number;
  title?: string;
  htmlSnippet?: string;
  consoleLines?: string[];
};

const AXE_LOAD_FAILURE_PREFIX = "axe-core failed to load.";
const MAX_DIAGNOSTIC_LINES = 20;
const MAX_DIAGNOSTIC_LINE_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function pushDiagnosticLine(lines: string[], line: string): void {
  const bounded =
    line.length > MAX_DIAGNOSTIC_LINE_LENGTH
      ? `${line.slice(0, MAX_DIAGNOSTIC_LINE_LENGTH)}…`
      : line;
  lines.push(bounded);
  if (lines.length > MAX_DIAGNOSTIC_LINES) {
    lines.splice(0, lines.length - MAX_DIAGNOSTIC_LINES);
  }
}

function callStringMethod(value: unknown, methodName: "text" | "type"): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const method = value[methodName];
  if (typeof method !== "function") {
    return null;
  }

  try {
    return String(method.call(value));
  } catch {
    return null;
  }
}

function formatDiagnosticValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatConsoleEvent(args: unknown[]): string {
  const event = args[0];
  const type = callStringMethod(event, "type");
  const text = callStringMethod(event, "text") ?? args.map(formatDiagnosticValue).join(" ");

  return type ? `[console:${type}] ${text}` : `[console] ${text}`;
}

function formatPageErrorEvent(args: unknown[]): string {
  return `[pageerror] ${args.map(formatDiagnosticValue).join(" ")}`;
}

function attachAxeDiagnostics(
  page: BrowserPage,
  consoleLines: string[]
): { event: string; handler: (...args: unknown[]) => void }[] {
  if (!page.on) {
    return [];
  }

  const listeners: { event: string; handler: (...args: unknown[]) => void }[] = [];
  const consoleHandler = (...args: unknown[]) => {
    pushDiagnosticLine(consoleLines, formatConsoleEvent(args));
  };
  const pageErrorHandler = (...args: unknown[]) => {
    pushDiagnosticLine(consoleLines, formatPageErrorEvent(args));
  };

  try {
    page.on("console", consoleHandler);
    listeners.push({ event: "console", handler: consoleHandler });
  } catch {
    // Diagnostics must never affect the audit itself.
  }

  try {
    page.on("pageerror", pageErrorHandler);
    listeners.push({ event: "pageerror", handler: pageErrorHandler });
  } catch {
    // Diagnostics must never affect the audit itself.
  }

  return listeners;
}

function detachAxeDiagnostics(
  page: BrowserPage | null,
  listeners: { event: string; handler: (...args: unknown[]) => void }[]
): void {
  if (!page || listeners.length === 0) {
    return;
  }

  const removeListener = page.off ?? page.removeListener;
  if (!removeListener) {
    return;
  }

  for (const { event, handler } of listeners) {
    try {
      removeListener.call(page, event, handler);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export function buildAxeLoadFailureMessage({
  url = "unknown",
  status,
  title = "unknown",
  htmlSnippet = "",
  consoleLines = [],
}: AxeLoadFailureMessageInput): string {
  const lines = [
    AXE_LOAD_FAILURE_PREFIX,
    `Final URL: ${url}`,
    `HTTP status: ${status ?? "unknown"}`,
    `Page title: ${title}`,
    `Served HTML (first 500 chars): ${htmlSnippet.slice(0, 500)}`,
  ];

  if (consoleLines.length > 0) {
    lines.push("Console/page errors:", ...consoleLines.map((line) => `- ${line}`));
  } else {
    lines.push("Console/page errors: none captured");
  }

  return lines.join("\n");
}

async function buildAxeLoadFailureMessageForPage(
  page: BrowserPage,
  status: number | undefined,
  consoleLines: string[]
): Promise<string> {
  let finalUrl = "unavailable";
  try {
    finalUrl = page.url();
  } catch (error) {
    finalUrl = `unavailable (${formatDiagnosticValue(error)})`;
  }

  let title = "unavailable";
  try {
    title = await page.title();
  } catch (error) {
    title = `unavailable (${formatDiagnosticValue(error)})`;
  }

  let htmlSnippet = "unavailable";
  try {
    htmlSnippet = await page.evaluate(
      () => document.documentElement?.outerHTML?.slice(0, 500) ?? ""
    );
  } catch (error) {
    htmlSnippet = `unavailable (${formatDiagnosticValue(error)})`;
  }

  return buildAxeLoadFailureMessage({
    url: finalUrl,
    status,
    title,
    htmlSnippet,
    consoleLines,
  });
}

function isAxeLoadFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes("axe-core failed to load");
}

function hasAxeSource(value: unknown): value is AxeSourceExport {
  return isRecord(value) && typeof value.source === "string";
}

export function resolveAxeSource(module: unknown): string {
  if (hasAxeSource(module)) {
    return module.source;
  }

  if (isRecord(module) && hasAxeSource(module.default)) {
    return module.default.source;
  }

  throw new Error("Unable to load axe-core source.");
}

export function toIssueSeverity(impact?: string | null): IssueSeverity {
  switch (impact) {
    case "critical":
    case "serious":
    case "moderate":
    case "minor":
      return impact;
    default:
      return "moderate";
  }
}

/**
 * One selector string for an axe target. Also the key a rendering condition's
 * axe run is compared with the engine pass by, so both have to flatten the
 * same way.
 */
export function flattenTarget(target: (string | string[])[]): string | null {
  if (!target || target.length === 0) return null;

  const parts: string[] = target.map((segment) =>
    Array.isArray(segment) ? segment.join(" > ") : segment
  );

  return parts.join(" > ");
}

export function transformAxeViolation(violation: AxeViolation): Issue[] {
  const impact = toIssueSeverity(violation.impact);

  if (!violation.nodes || violation.nodes.length === 0) {
    return [
      {
        id: violation.id,
        impact,
        description: violation.description,
        help: violation.help,
        helpUrl: violation.helpUrl,
        selector: null,
        nodes: [],
      },
    ];
  }

  return violation.nodes.map((node) => ({
    id: violation.id,
    impact,
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    failureSummary: node.failureSummary,
    selector: flattenTarget(node.target),
    nodes: [{ html: node.html }],
  }));
}

async function runAxe(page: BrowserPage, timeout?: number): Promise<AxeResults> {
  const run = () =>
    page.evaluate(
      (options: AxeRunOptions) => {
        const axeRuntime = globalThis as typeof globalThis & AxeRuntime;
        if (!axeRuntime.axe) {
          // NOTE: this runs in the browser via page.evaluate — it cannot
          // reference Node-scope constants, so the message must be a literal.
          // Keep it in sync with AXE_LOAD_FAILURE_PREFIX / isAxeLoadFailure().
          throw new Error("axe-core failed to load.");
        }
        return axeRuntime.axe.run(document, options);
      },
      { rules: AXE_ENABLED_RULES }
    );

  if (!timeout) {
    return run();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`axe-core timed out after ${timeout}ms`)),
          timeout
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function runAxeCore(
  url: string,
  options: AxeRunnerOptions = {}
): Promise<AxeRunResult> {
  const {
    viewport = { width: 1280, height: 720 },
    headless = true,
    timeout,
    onProgress,
    page: existingPage,
    loadLazyContent: shouldLoadLazyContent = true,
    failOnHttpError,
    browser: browserOptions,
  } = options;

  let ownsBrowser = false;
  let browser: PuppeteerBrowserLike | null = null;
  let page: BrowserPage | null = null;
  let ownedPage: PuppeteerPageLike | null = null;
  let navigation: NavigationInfo | null = null;
  const consoleLines: string[] = [];
  let diagnosticListeners: { event: string; handler: (...args: unknown[]) => void }[] = [];

  try {
    await onProgress?.({ percent: 10, message: `Starting axe-core audit for ${url}` });

    if (existingPage) {
      await onProgress?.({ percent: 20, message: "Using existing browser page" });
      page = existingPage;
    } else {
      await onProgress?.({ percent: 20, message: "Launching browser" });
      ownsBrowser = true;

      const session = await launchPuppeteerSession({ headless, viewport, browser: browserOptions });
      browser = session.browser;
      ownedPage = session.page;
      page = ownedPage;
    }

    if (!page) {
      throw new Error("Browser page was not initialized.");
    }

    diagnosticListeners = attachAxeDiagnostics(page, consoleLines);

    const currentUrl = page.url();
    if (!currentUrl || currentUrl === "about:blank" || currentUrl !== url) {
      await onProgress?.({ percent: 30, message: "Loading page" });
      const outcome = await navigateAndInspect(page, url, { timeout, browser: browserOptions });
      navigation = outcome.navigation;
      // Before the banner, the scroll, axe and the screenshot: with
      // `failOnHttpError` an error page must cost no further work.
      checkNavigationStatus(outcome, { failOnHttpError });
    } else {
      navigation = describeUnnavigatedPage(url, currentUrl);
    }

    await onProgress?.({ percent: 40, message: "Checking for cookie consent banners" });
    const { dismissCookieBanner } = await import("../cookie-banner.js");
    await dismissCookieBanner(page);

    // Only a page this call navigated: a caller-supplied page keeps the scroll
    // position its owner chose.
    if (navigation.navigated && shouldLoadLazyContent) {
      await onProgress?.({ percent: 45, message: "Loading lazy content" });
      const { loadLazyContent } = await import("../lazy-content.js");
      await loadLazyContent(page);
    }

    await onProgress?.({ percent: 50, message: "Injecting axe-core" });

    const axeModule = await import("axe-core");
    const axeSource = resolveAxeSource(axeModule);

    await page.evaluate((source: string) => {
      const existing = document.getElementById("__barrieretest-axe-core__");
      existing?.remove();

      const script = document.createElement("script");
      script.id = "__barrieretest-axe-core__";
      script.textContent = source;
      (document.head ?? document.documentElement).appendChild(script);
    }, axeSource);

    await onProgress?.({ percent: 60, message: "Running accessibility tests" });
    let results: AxeResults;
    try {
      results = await runAxe(page, timeout);
    } catch (error) {
      if (isAxeLoadFailure(error)) {
        let message = AXE_LOAD_FAILURE_PREFIX;
        try {
          message = await buildAxeLoadFailureMessageForPage(
            page,
            navigation.status ?? undefined,
            consoleLines
          );
        } catch {
          // Preserve the original axe-load failure even if diagnostics fail unexpectedly.
        }

        throw new Error(message);
      }

      throw error;
    }

    await onProgress?.({ percent: 70, message: "Capturing screenshot" });

    let screenshot: Uint8Array | undefined;
    try {
      screenshot = await page.screenshot({ type: "png", fullPage: true });
    } catch {
      // Ignore screenshot failures.
    }

    await onProgress?.({ percent: 80, message: "Transforming results" });

    const issues: Issue[] = results.violations.flatMap(transformAxeViolation);
    const documentTitle = await page.title();
    const pageUrl = page.url();

    await onProgress?.({ percent: 90, message: "Analyzing accessibility issues" });

    return { issues, documentTitle, pageUrl, screenshot, navigation };
  } finally {
    detachAxeDiagnostics(page, diagnosticListeners);

    if (ownsBrowser) {
      if (ownedPage?.close) {
        try {
          await ownedPage.close();
        } catch {
          // Ignore close errors.
        }
      }

      if (browser?.close) {
        try {
          await browser.close();
        } catch {
          // Ignore close errors.
        }
      }
    }
  }
}
