import pa11y from "pa11y";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { type BrowserPage, isPuppeteerPage } from "../browser.js";
import { dismissCookieBanner } from "../cookie-banner.js";

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
  page?: BrowserPage;
};

export type Pa11yRunResult = {
  issues: Pa11yIssue[];
  documentTitle: string;
  pageUrl: string;
  screenshot?: Uint8Array;
};

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
  let browser: Browser | null = null;
  let page: Page | null = null;

  await onProgress?.({ percent: 10, message: `Starting audit for ${url}` });

  try {
    if (existingPage && isPuppeteerPage(existingPage)) {
      await onProgress?.({ percent: 20, message: "Using existing browser page" });
      page = existingPage as unknown as Page;
      browser = page.browser();
    } else {
      await onProgress?.({ percent: 20, message: "Launching browser" });
      ownsBrowser = true;
      browser = await puppeteer.launch({
        headless,
        args: chromeArgs,
      });
      page = await browser.newPage();
      await page.setViewport(viewport);
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
      if (page) {
        try {
          await page.close();
        } catch {
          // Ignore close errors.
        }
      }
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Ignore close errors.
        }
      }
    }
  }
}
