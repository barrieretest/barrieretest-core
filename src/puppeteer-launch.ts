/**
 * Shared Puppeteer launch helper.
 *
 * Used by `runAxeCore` and `audit()` (in semantic mode) so a single audit
 * pass owning a single browser can hand the same page to multiple consumers
 * (e.g. axe-core + the semantic runner).
 */

import type { PuppeteerBrowserLike, PuppeteerPageLike } from "./browser.js";

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

  const page = await browser.newPage();
  await page.setViewport?.(viewport);

  return { browser, page };
}

export interface NavigateOptions {
  timeout?: number;
}

/**
 * Navigate the given Puppeteer page to a URL using the `networkidle2` heuristic.
 */
export async function navigateTo(
  page: PuppeteerPageLike,
  url: string,
  options: NavigateOptions = {}
): Promise<void> {
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: options.timeout ?? 30_000,
  });
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
