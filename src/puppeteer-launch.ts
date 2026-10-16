/**
 * Shared Puppeteer launch and navigation helpers.
 *
 * Used by `runAxeCore` and `audit()` (in semantic mode) so a single audit
 * pass owning a single browser can hand the same page to multiple consumers
 * (e.g. axe-core + the semantic runner).
 *
 * `navigateAndInspect` plus `checkNavigationStatus` are the one navigation
 * path of the library: the axe engine, the pa11y engine and the standalone
 * semantic audit all go through them, so the status of an error page is
 * reported — and optionally made fatal — the same way everywhere.
 */

import type { BrowserPage, PuppeteerBrowserLike, PuppeteerPageLike } from "./browser.js";
import { isPuppeteerPage } from "./browser.js";
import type { NavigationInfo } from "./types.js";

export interface PuppeteerLauncher {
  launch: (options: { headless: boolean; args: string[] }) => Promise<PuppeteerBrowserLike>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isPuppeteerLauncher(value: unknown): value is PuppeteerLauncher {
  return isRecord(value) && typeof (value as Record<string, unknown>).launch === "function";
}

function resolvePuppeteerLauncher(module: unknown): PuppeteerLauncher {
  if (isPuppeteerLauncher(module)) return module;
  if (isRecord(module) && isPuppeteerLauncher(module.default)) {
    return module.default;
  }
  throw new Error("This operation requires 'puppeteer'. Install it or pass an existing page.");
}

const DEFAULT_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

const REALISTIC_DESKTOP_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface LaunchedSession {
  browser: PuppeteerBrowserLike;
  page: PuppeteerPageLike;
}

export interface LaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
}

/**
 * Launch a Puppeteer browser and create a fresh page with the given viewport.
 *
 * Caller is responsible for closing the browser.
 */
export async function launchPuppeteerSession(
  options: LaunchOptions = {}
): Promise<LaunchedSession> {
  const { headless = true, viewport = { width: 1280, height: 720 } } = options;

  let puppeteerModule: unknown;
  try {
    puppeteerModule = await import("puppeteer");
  } catch {
    throw new Error("This operation requires 'puppeteer'. Install it or pass an existing page.");
  }

  const puppeteer = resolvePuppeteerLauncher(puppeteerModule);
  const browser = await puppeteer.launch({
    headless,
    args: DEFAULT_LAUNCH_ARGS,
  });

  // The caller only learns about the browser through the return value, so a
  // setup step that rejects would strand a running Chromium: close it here
  // and let the original failure through.
  try {
    const page = await browser.newPage();
    await page.setUserAgent?.(REALISTIC_DESKTOP_CHROME_UA);
    await page.setViewport?.(viewport);

    return { browser, page };
  } catch (error) {
    try {
      await browser.close?.();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export interface NavigateOptions {
  timeout?: number;
}

const DEFAULT_NAVIGATION_TIMEOUT = 30_000;

/**
 * Statuses a consumer may usefully retry: a rate limit or a transient server
 * answer. Everything else (403, 404, …) is permanent as far as a retry goes.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** The facts of one navigation, plus the retry hint its response carried. */
export interface NavigationOutcome {
  navigation: NavigationInfo;
  /** `Retry-After` in seconds, when the response sent a usable one. */
  retryAfterSeconds?: number;
}

/**
 * Thrown instead of auditing the served page when the caller asked for
 * `failOnHttpError` and the main document answered with a status `>= 400`.
 *
 * Match `code` (or use `isNavigationHttpError`) rather than the message: the
 * message is for humans and may change.
 */
export class NavigationHttpError extends Error {
  readonly code = "NAVIGATION_HTTP_ERROR";
  readonly status: number;
  /** The URL the audit was asked for. */
  readonly url: string;
  readonly finalUrl: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(init: {
    status: number;
    url: string;
    finalUrl: string;
    retryAfterSeconds?: number;
  }) {
    const { status, url, finalUrl, retryAfterSeconds } = init;
    const redirectNote = finalUrl === url ? "" : ` (final URL ${finalUrl})`;
    const retryNote = retryAfterSeconds === undefined ? "" : ` Retry-After: ${retryAfterSeconds}s.`;
    super(
      `Target returned HTTP ${status} for ${url}${redirectNote}; the audit was stopped ` +
        `because failOnHttpError is set.${retryNote}`
    );

    this.name = "NavigationHttpError";
    this.status = status;
    this.url = url;
    this.finalUrl = finalUrl;
    this.retryable = RETRYABLE_STATUSES.has(status);
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

/**
 * Recognise a `NavigationHttpError`, including one thrown by a duplicated
 * copy of this module (two installed versions, a bundled consumer), where
 * `instanceof` does not hold.
 */
export function isNavigationHttpError(error: unknown): error is NavigationHttpError {
  if (error instanceof NavigationHttpError) {
    return true;
  }

  return (
    isRecord(error) &&
    error.code === "NAVIGATION_HTTP_ERROR" &&
    typeof error.status === "number" &&
    typeof error.url === "string"
  );
}

/** Read `status()` off a Puppeteer or Playwright navigation response. */
function readResponseStatus(response: unknown): number | null {
  if (!isRecord(response) || typeof response.status !== "function") {
    return null;
  }

  try {
    const status = response.status.call(response);
    return typeof status === "number" ? status : null;
  } catch {
    return null;
  }
}

/** Read one header off a Puppeteer or Playwright navigation response. */
function readResponseHeader(response: unknown, name: string): string | undefined {
  if (!isRecord(response) || typeof response.headers !== "function") {
    return undefined;
  }

  let headers: unknown;
  try {
    headers = response.headers.call(response);
  } catch {
    return undefined;
  }

  if (!isRecord(headers)) {
    return undefined;
  }

  // Both drivers lower-case their header names, but a stub or a future
  // version need not, and a missed `Retry-After` would silently drop the
  // retry hint.
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return typeof value === "string" ? value : undefined;
    }
  }

  return undefined;
}

/**
 * `Retry-After` as whole seconds from now: the header is either a number of
 * seconds or an HTTP date. A date in the past gives 0 rather than a negative
 * wait; anything unparsable gives `undefined`.
 */
export function parseRetryAfterSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  // A number that is not a count of whole, non-negative seconds is malformed,
  // not a date: `Date.parse("-5")` reads it as a year and would answer 0.
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}

/**
 * Compare two URLs for `NavigationInfo.redirected`. Conservative on purpose:
 * only a trailing slash on the path and a default port are ignored (`URL`
 * drops the latter itself), so a redirect to another host, path or query
 * always shows up, and a cosmetic one does not.
 *
 * The fragment is ignored as well, because the browser requests no new
 * document for it: a page that only moves the fragment was not redirected in
 * the sense this field reports, and `finalUrl` still carries it.
 */
function normalizedLocation(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

function isRedirected(requestedUrl: string, finalUrl: string): boolean {
  if (requestedUrl === finalUrl) {
    return false;
  }

  const requested = normalizedLocation(requestedUrl);
  const final = normalizedLocation(finalUrl);
  // Something that does not parse as a URL is only "the same place" when the
  // two strings are identical, which was checked above.
  if (requested === null || final === null) {
    return true;
  }

  return requested !== final;
}

/**
 * Navigate a page to a URL and report the facts of that navigation.
 *
 * A Puppeteer page is navigated with the `networkidle2` heuristic and the
 * timeout; a generic page (Playwright) gets a bare `goto`, whose response
 * carries `status()` and `headers()` just the same.
 */
export async function navigateAndInspect(
  page: BrowserPage | PuppeteerPageLike,
  url: string,
  options: NavigateOptions = {}
): Promise<NavigationOutcome> {
  const response = isPuppeteerPage(page)
    ? await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: options.timeout ?? DEFAULT_NAVIGATION_TIMEOUT,
      })
    : await page.goto(url);

  let finalUrl = url;
  try {
    finalUrl = page.url();
  } catch {
    // A page that cannot report its URL is described by the requested one.
  }

  return {
    navigation: {
      navigated: true,
      requestedUrl: url,
      finalUrl,
      status: readResponseStatus(response),
      redirected: isRedirected(url, finalUrl),
    },
    retryAfterSeconds: parseRetryAfterSeconds(readResponseHeader(response, "retry-after")),
  };
}

/**
 * The facts for a page the library did not navigate: there is no response to
 * judge, so the status is `null` and `failOnHttpError` has nothing to act on.
 */
export function describeUnnavigatedPage(url: string, finalUrl: string): NavigationInfo {
  return {
    navigated: false,
    requestedUrl: url,
    finalUrl,
    status: null,
    redirected: isRedirected(url, finalUrl),
  };
}

/**
 * Judge a navigation's status, once, for every navigating path.
 *
 * With `failOnHttpError` a main-document status `>= 400` throws before the
 * caller does any further work on the page; without it the status is warned
 * about exactly as it has been since 0.8.0 and the served page is audited.
 */
export function checkNavigationStatus(
  outcome: NavigationOutcome,
  options: { failOnHttpError?: boolean } = {}
): void {
  const { navigation, retryAfterSeconds } = outcome;
  const { status, requestedUrl, finalUrl } = navigation;

  if (status === null || status < 400) {
    return;
  }

  if (options.failOnHttpError) {
    throw new NavigationHttpError({ status, url: requestedUrl, finalUrl, retryAfterSeconds });
  }

  console.warn(
    `Target returned HTTP ${status} for ${requestedUrl}; auditing the served page (bot protection or rate limiting may be in effect).`
  );
}

/**
 * Best-effort cleanup: close page then browser, swallowing errors.
 */
export async function closeSession(session: LaunchedSession): Promise<void> {
  if (session.page.close) {
    try {
      await session.page.close();
    } catch {
      /* ignore */
    }
  }
  if (session.browser.close) {
    try {
      await session.browser.close();
    } catch {
      /* ignore */
    }
  }
}
