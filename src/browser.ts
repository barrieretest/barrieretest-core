/** Runtime type guards for browser page objects. */

export type BrowserEvaluate = {
  <T>(fn: () => T | Promise<T>): Promise<Awaited<T>>;
  <Arg, T>(fn: (arg: Arg) => T | Promise<T>, arg: Arg): Promise<Awaited<T>>;
};

export type BrowserScreenshotClip = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserPage = {
  evaluate: BrowserEvaluate;
  goto: (url: string) => Promise<unknown>;
  screenshot: (options?: {
    type?: "png" | "jpeg";
    fullPage?: boolean;
    clip?: BrowserScreenshotClip;
  }) => Promise<Uint8Array>;
  url: () => string;
  title: () => Promise<string>;
};

export type PuppeteerBrowserLike = {
  newPage: () => Promise<PuppeteerPageLike>;
  close?: () => Promise<unknown>;
};

export type PuppeteerPageLike = Omit<BrowserPage, "goto"> & {
  goto: (
    url: string,
    options?: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
      timeout?: number;
    }
  ) => Promise<unknown>;
  browser: () => PuppeteerBrowserLike;
  setViewport?: (viewport: { width: number; height: number }) => Promise<unknown>;
  close?: () => Promise<unknown>;
};

export type PlaywrightPageLike = BrowserPage & {
  context: () => unknown;
};

/** Returns true for Playwright page-like objects. */
export function isPlaywrightPage(obj: unknown): obj is PlaywrightPageLike {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const page = obj as Record<string, unknown>;

  return (
    typeof page.evaluate === "function" &&
    typeof page.goto === "function" &&
    typeof page.screenshot === "function" &&
    typeof page.context === "function" &&
    "_guid" in page
  );
}

/** Returns true for Puppeteer page-like objects. */
export function isPuppeteerPage(obj: unknown): obj is PuppeteerPageLike {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const page = obj as Record<string, unknown>;

  return (
    typeof page.evaluate === "function" &&
    typeof page.goto === "function" &&
    typeof page.screenshot === "function" &&
    typeof page.browser === "function" &&
    !("_guid" in page)
  );
}

/** Returns true for generic browser page-like objects. */
export function isBrowserPage(obj: unknown): obj is BrowserPage {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const page = obj as Record<string, unknown>;

  return (
    typeof page.evaluate === "function" &&
    typeof page.goto === "function" &&
    typeof page.screenshot === "function" &&
    typeof page.url === "function" &&
    typeof page.title === "function"
  );
}

/** Returns true when the target is a URL string. */
export function isUrl(target: unknown): target is string {
  return typeof target === "string";
}
