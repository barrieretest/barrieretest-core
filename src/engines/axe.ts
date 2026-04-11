/**
 * Axe-core accessibility engine.
 *
 * Injects axe-core into a browser page (Puppeteer or Playwright) and runs
 * a full accessibility audit. Results are transformed into the standardised
 * `Issue` format used throughout the library.
 */

import type {
  BrowserPage,
  PuppeteerBrowserLike,
  PuppeteerPageLike,
} from "../browser.js";
import { isPuppeteerPage } from "../browser.js";
import { launchPuppeteerSession, navigateTo } from "../puppeteer-launch.js";
import type { Issue, IssueSeverity } from "../types.js";

export type AxeNodeResult = {
  html: string;
  impact?: string | null;
  target: (string | string[])[];
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
};

export type AxeRunResult = {
  issues: Issue[];
  documentTitle: string;
  pageUrl: string;
  screenshot?: Uint8Array;
};

type AxeResults = {
  violations: AxeViolation[];
};

type AxeSourceExport = {
  source: string;
};

type AxeRuntime = {
  axe?: {
    run: (context: Document) => Promise<AxeResults>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function hasAxeSource(value: unknown): value is AxeSourceExport {
  return isRecord(value) && typeof value.source === "string";
}

function resolveAxeSource(module: unknown): string {
  if (hasAxeSource(module)) {
    return module.source;
  }

  if (isRecord(module) && hasAxeSource(module.default)) {
    return module.default.source;
  }

  throw new Error("Unable to load axe-core source.");
}

function toIssueSeverity(impact?: string | null): IssueSeverity {
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

function flattenTarget(target: (string | string[])[]): string | null {
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
    selector: flattenTarget(node.target),
    nodes: [{ html: node.html }],
  }));
}

async function runAxe(page: BrowserPage, timeout?: number): Promise<AxeResults> {
  const run = () =>
    page.evaluate(() => {
      const axeRuntime = globalThis as typeof globalThis & AxeRuntime;
      if (!axeRuntime.axe) {
        throw new Error("axe-core failed to load.");
      }
      return axeRuntime.axe.run(document);
    });

  if (!timeout) {
    return run();
  }

  return Promise.race([
    run(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`axe-core timed out after ${timeout}ms`)), timeout);
    }),
  ]);
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
  } = options;

  let ownsBrowser = false;
  let browser: PuppeteerBrowserLike | null = null;
  let page: BrowserPage | null = null;
  let ownedPage: PuppeteerPageLike | null = null;

  try {
    await onProgress?.({ percent: 10, message: `Starting axe-core audit for ${url}` });

    if (existingPage) {
      await onProgress?.({ percent: 20, message: "Using existing browser page" });
      page = existingPage;
    } else {
      await onProgress?.({ percent: 20, message: "Launching browser" });
      ownsBrowser = true;

      const session = await launchPuppeteerSession({ headless, viewport });
      browser = session.browser;
      ownedPage = session.page;
      page = ownedPage;
    }

    const currentUrl = page.url();
    if (!currentUrl || currentUrl === "about:blank" || currentUrl !== url) {
      await onProgress?.({ percent: 30, message: "Loading page" });
      if (isPuppeteerPage(page)) {
        await navigateTo(page, url, { timeout });
      } else {
        await page.goto(url);
      }
    }

    await onProgress?.({ percent: 40, message: "Checking for cookie consent banners" });
    const { dismissCookieBanner } = await import("../cookie-banner.js");
    await dismissCookieBanner(page);

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
    const results = await runAxe(page, timeout);

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

    return { issues, documentTitle, pageUrl, screenshot };
  } finally {
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
