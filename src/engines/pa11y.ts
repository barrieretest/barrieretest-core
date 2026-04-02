import pa11y from "pa11y";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { type BrowserPage, isPuppeteerPage } from "../browser.js";
import { dismissCookieBanner } from "../cookie-banner.js";

// Re-export pa11y types for convenience
export type Pa11yResults = Awaited<ReturnType<typeof pa11y>>;
export type Pa11yOptions = Parameters<typeof pa11y>[1];
export type Pa11yIssue = Pa11yResults["issues"][number];

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

export type Pa11yRunnerOptions = {
  /**
   * Pa11y runners to use. Defaults to ["htmlcs"].
   * Options: "htmlcs" (HTML CodeSniffer), "axe" (axe-core)
   */
  runners?: ("htmlcs" | "axe")[];

  /**
   * Viewport dimensions for the browser.
   * Ignored when an existing page is provided.
   */
  viewport?: { width: number; height: number };

  /**
   * Whether to run headless. Defaults to true.
   * Ignored when an existing page is provided.
   */
  headless?: boolean;

  /**
   * Pa11y timeout in milliseconds
   */
  timeout?: number;

  /**
   * Custom Chrome launch arguments.
   * Ignored when an existing page is provided.
   */
  chromeArgs?: string[];

  /**
   * Optional progress callback
   */
  onProgress?: (data: { percent: number; message: string }) => void | Promise<void>;

  /**
   * Existing browser page to use.
   * When provided, skips browser launch and uses this page.
   * Currently only Puppeteer pages are supported.
   */
  page?: BrowserPage;
};

export type Pa11yRunResult = {
  issues: Pa11yIssue[];
  documentTitle: string;
  pageUrl: string;
  screenshot?: Uint8Array;
};

/**
 * Run Pa11y accessibility audit on a URL or existing page
 */
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

  // Track whether we own the browser (and should clean it up)
  let ownsBrowser = false;
  let browser: Browser | null = null;
  let page: Page | null = null;

  await onProgress?.({ percent: 10, message: `Starting audit for ${url}` });

  try {
    if (existingPage && isPuppeteerPage(existingPage)) {
      // Use the existing Puppeteer page
      await onProgress?.({
        percent: 20,
        message: "Using existing browser page",
      });
      page = existingPage as unknown as Page;
      browser = page.browser();
    } else {
      // Launch a new browser
      await onProgress?.({
        percent: 20,
        message: "Launching browser",
      });
      ownsBrowser = true;
      browser = await puppeteer.launch({
        headless,
        args: chromeArgs,
      });
      page = await browser.newPage();
      await page.setViewport(viewport);
    }

    // Navigate to the URL ourselves so we can dismiss cookie banners
    // before pa11y injects its test runners.
    await onProgress?.({
      percent: 30,
      message: "Loading page",
    });

    const navigationTimeout = timeout ?? 30_000;
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: navigationTimeout,
    });

    // Attempt to close cookie consent banners so they don't interfere
    // with the audit results or obscure page content in the screenshot.
    await onProgress?.({
      percent: 40,
      message: "Checking for cookie consent banners",
    });

    await dismissCookieBanner(page);

    // Run pa11y with ignoreUrl so it doesn't navigate again — the page
    // is already loaded and cookie banners are out of the way.
    await onProgress?.({
      percent: 50,
      message: "Running accessibility tests",
    });

    const pa11yOptions: Pa11yOptions = {
      runners,
      browser,
      page,
      viewport,
      timeout,
      ignoreUrl: true,
    };

    const result = await pa11y(url, pa11yOptions);

    await onProgress?.({ percent: 70, message: "Capturing screenshot" });

    let screenshot: Uint8Array | undefined;
    if (page) {
      try {
        screenshot = await page.screenshot({
          type: "png",
          fullPage: true,
        });
      } catch {
        // Screenshot capture is optional, don't fail the audit
      }
    }

    await onProgress?.({
      percent: 90,
      message: "Analyzing accessibility issues",
    });

    return {
      issues: result.issues,
      documentTitle: result.documentTitle,
      pageUrl: result.pageUrl,
      screenshot,
    };
  } finally {
    // Only clean up if we own the browser
    if (ownsBrowser) {
      if (page) {
        try {
          await page.close();
        } catch {
          // Ignore close errors
        }
      }
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }
}
