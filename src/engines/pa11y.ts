import type { PuppeteerBrowserLike, PuppeteerPageLike } from "../browser.js";
import { isPuppeteerPage } from "../browser.js";
import { dismissCookieBanner } from "../cookie-banner.js";

export type Pa11yIssue = {
  code: string;
  type: string;
  message: string;
  context: string;
  selector?: string | null;
};

export type Pa11yResults = {
  issues: Pa11yIssue[];
  documentTitle: string;
  pageUrl: string;
};

export type Pa11yOptions = {
  runners?: ("htmlcs" | "axe")[];
  browser?: PuppeteerBrowserLike | null;
  page?: PuppeteerPageLike | null;
  viewport?: { width: number; height: number };
  timeout?: number;
  ignoreUrl?: boolean;
};

type Pa11yFn = (url: string, options?: Pa11yOptions) => Promise<Pa11yResults>;

const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 720,
};

const DEFAULT_CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

const PA11Y_INSTALL_ERROR =
  "Pa11y engine requires 'pa11y' and 'puppeteer' packages. Install them or use engine: 'axe'.";

export type Pa11yRunnerOptions = {
  /** Pa11y runners to use. */
  runners?: ("htmlcs" | "axe")[];

  /** Viewport dimensions when launching a browser. */
  viewport?: { width: number; height: number };

  /** Whether to run headless when launching a browser. */
  headless?: boolean;

  /** Audit timeout in milliseconds. */
  timeout?: number;

  /** Custom Chrome launch arguments. */
  chromeArgs?: string[];

  /** Optional progress callback. */
  onProgress?: (data: { percent: number; message: string }) => void | Promise<void>;

  /** Existing Puppeteer page to reuse. */
  page?: PuppeteerPageLike;
};

export type Pa11yRunResult = {
  issues: Pa11yIssue[];
  documentTitle: string;
  pageUrl: string;
  screenshot?: Uint8Array;
};

type PuppeteerLauncher = {
  launch: (options: {
    headless: boolean;
    args: string[];
  }) => Promise<PuppeteerBrowserLike>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isPa11yFn(value: unknown): value is Pa11yFn {
  return typeof value === "function";
}

function resolvePa11yFn(module: unknown): Pa11yFn {
  if (isPa11yFn(module)) {
    return module;
  }

  if (isRecord(module) && isPa11yFn(module.default)) {
    return module.default;
  }

  throw new Error(PA11Y_INSTALL_ERROR);
}

function isPuppeteerLauncher(value: unknown): value is PuppeteerLauncher {
  return isRecord(value) && typeof value.launch === "function";
}

function resolvePuppeteerLauncher(module: unknown): PuppeteerLauncher {
  if (isPuppeteerLauncher(module)) {
    return module;
  }

  if (isRecord(module) && isPuppeteerLauncher(module.default)) {
    return module.default;
  }

  throw new Error(PA11Y_INSTALL_ERROR);
}

/** Runs pa11y on a single page. */
export async function runPa11y(
  url: string,
  options: Pa11yRunnerOptions = {}
): Promise<Pa11yRunResult> {
  const {
    runners = ["htmlcs"],
    viewport = DEFAULT_VIEWPORT,
    headless = true,
    timeout,
    chromeArgs = DEFAULT_CHROME_ARGS,
    onProgress,
    page: existingPage,
  } = options;

  let ownsBrowser = false;
  let browser: PuppeteerBrowserLike | null = null;
  let page: PuppeteerPageLike | null = null;

  await onProgress?.({ percent: 10, message: `Starting audit for ${url}` });

  let pa11yFn: Pa11yFn;
  try {
    const pa11yModule = await import("pa11y");
    pa11yFn = resolvePa11yFn(pa11yModule);
  } catch {
    throw new Error(PA11Y_INSTALL_ERROR);
  }

  try {
    if (existingPage && isPuppeteerPage(existingPage)) {
      await onProgress?.({ percent: 20, message: "Using existing browser page" });
      page = existingPage;
      browser = page.browser();
    } else {
      await onProgress?.({ percent: 20, message: "Launching browser" });
      ownsBrowser = true;

      let puppeteerModule: unknown;
      try {
        puppeteerModule = await import("puppeteer");
      } catch {
        throw new Error(PA11Y_INSTALL_ERROR);
      }

      const puppeteer = resolvePuppeteerLauncher(puppeteerModule);
      browser = await puppeteer.launch({
        headless,
        args: chromeArgs,
      });
      page = await browser.newPage();
      await page.setViewport?.(viewport);
    }

    await onProgress?.({ percent: 30, message: "Loading page" });

    const navigationTimeout = timeout ?? 30_000;
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: navigationTimeout,
    });

    await onProgress?.({ percent: 40, message: "Checking for cookie consent banners" });
    await dismissCookieBanner(page);

    await onProgress?.({ percent: 50, message: "Running accessibility tests" });

    const pa11yOptions: Pa11yOptions = {
      runners,
      browser,
      page,
      viewport,
      timeout,
      ignoreUrl: true,
    };

    const result = await pa11yFn(url, pa11yOptions);

    await onProgress?.({ percent: 70, message: "Capturing screenshot" });

    let screenshot: Uint8Array | undefined;
    if (page) {
      try {
        screenshot = await page.screenshot({
          type: "png",
          fullPage: true,
        });
      } catch {
        // Ignore screenshot failures.
      }
    }

    await onProgress?.({ percent: 90, message: "Analyzing accessibility issues" });

    return {
      issues: result.issues,
      documentTitle: result.documentTitle,
      pageUrl: result.pageUrl,
      screenshot,
    };
  } finally {
    if (ownsBrowser) {
      if (page?.close) {
        try {
          await page.close();
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
