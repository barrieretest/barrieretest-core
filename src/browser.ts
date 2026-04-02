/**
 * Browser detection utilities for identifying page objects
 *
 * These functions detect Playwright and Puppeteer page objects at runtime
 * using duck typing, without requiring direct imports of either library.
 */

/**
 * Checks if an object is a Playwright Page
 *
 * Playwright pages have specific methods like `evaluate`, `goto`, `screenshot`,
 * and a `context()` method that returns a BrowserContext.
 */
export function isPlaywrightPage(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const page = obj as Record<string, unknown>;

  // Playwright pages have these distinctive characteristics:
  // - context() method returns BrowserContext
  // - evaluate, goto, screenshot are functions
  // - _guid property (internal Playwright identifier)
  return (
    typeof page.evaluate === "function" &&
    typeof page.goto === "function" &&
    typeof page.screenshot === "function" &&
    typeof page.context === "function" &&
    // Playwright has _guid, Puppeteer doesn't
    "_guid" in page
  );
}

/**
 * Checks if an object is a Puppeteer Page
 *
 * Puppeteer pages have specific methods like `evaluate`, `goto`, `screenshot`,
 * and a `browser()` method that returns the Browser instance.
 */
export function isPuppeteerPage(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const page = obj as Record<string, unknown>;

  // Puppeteer pages have these distinctive characteristics:
  // - browser() method returns Browser instance
  // - evaluate, goto, screenshot are functions
  // - No _guid property (that's Playwright)
  return (
    typeof page.evaluate === "function" &&
    typeof page.goto === "function" &&
    typeof page.screenshot === "function" &&
    typeof page.browser === "function" &&
    // Puppeteer doesn't have _guid
    !("_guid" in page)
  );
}

/**
 * Type guard to check if a target is a URL string
 */
export function isUrl(target: unknown): target is string {
  return typeof target === "string";
}

/**
 * Represents a page object from either Playwright or Puppeteer
 */
export type BrowserPage = {
  evaluate: <T>(fn: () => T) => Promise<T>;
  goto: (url: string) => Promise<unknown>;
  screenshot: (options?: { type?: string; fullPage?: boolean }) => Promise<Uint8Array>;
  url: () => string;
  title: () => Promise<string>;
};
