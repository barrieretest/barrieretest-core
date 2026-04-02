/** Runtime type guards for browser page objects. */

/** Returns true for Playwright page-like objects. */
export function isPlaywrightPage(obj: unknown): boolean {
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
export function isPuppeteerPage(obj: unknown): boolean {
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

/** Returns true when the target is a URL string. */
export function isUrl(target: unknown): target is string {
  return typeof target === "string";
}

/** Shared shape used by the core when working with browser pages. */
export type BrowserPage = {
  evaluate: <T>(fn: () => T) => Promise<T>;
  goto: (url: string) => Promise<unknown>;
  screenshot: (options?: { type?: string; fullPage?: boolean }) => Promise<Uint8Array>;
  url: () => string;
  title: () => Promise<string>;
};
