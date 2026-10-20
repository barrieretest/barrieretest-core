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
import type { BrowserLaunchOptions, NavigationInfo } from "./types.js";

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

/** Proxy URL schemes Chromium understands for `--proxy-server`. */
const PROXY_SERVER_SCHEMES = ["http:", "https:", "socks:", "socks4:", "socks5:"];

/**
 * Arguments that would undo the proxy — another proxy, a bypass list, a
 * resolver override, WebRTC back on direct UDP. Matched by switch name, so
 * both `--no-proxy-server` and `--proxy-server=…` are caught.
 */
const PROXY_CONTRADICTING_SWITCHES = new Set([
  "proxy-server",
  "proxy-bypass-list",
  "no-proxy-server",
  "proxy-pac-url",
  "proxy-auto-detect",
  "host-resolver-rules",
  "host-rules",
  "force-webrtc-ip-handling-policy",
]);

/**
 * The switch name of a Chromium argument, as Chromium itself reads it: any
 * number of leading dashes (on POSIX `-switch` works as well as `--switch`),
 * the part before `=`, lower-cased (Windows lower-cases switch names).
 */
function switchName(argument: string): string {
  return argument.trim().replace(/^-+/, "").split("=")[0].toLowerCase();
}

/**
 * Reject caller arguments that would reach the network without the proxy.
 *
 * Both argument sources are checked: `browser.extraArgs` and the base list,
 * which the pa11y engine lets the caller replace through `chromeArgs`. Core's
 * own defaults contain none of these, so checking them too costs nothing.
 */
function rejectProxyContradictions(args: readonly string[]): void {
  // Everything after a bare `--` is a positional argument rather than a
  // switch, so core's own switches after it would stop being switches.
  if (args.some((argument) => argument.trim() === "--")) {
    throw new Error(
      "Chromium launch arguments may not contain the argument terminator '--' while " +
        "browser.proxyServer is set: every argument after it would be positional, " +
        "which could neutralise the proxy switches."
    );
  }

  const contradicting = args.filter((argument) =>
    PROXY_CONTRADICTING_SWITCHES.has(switchName(argument))
  );
  if (contradicting.length > 0) {
    throw new Error(
      `Chromium launch arguments may not contain ${contradicting.join(", ")} while ` +
        "browser.proxyServer is set: it would let the browser reach the network without " +
        "the proxy. Check browser.extraArgs, and chromeArgs on the pa11y engine."
    );
  }
}

/**
 * The one proxy endpoint `--proxy-server` may name, as `scheme://host:port`.
 *
 * Chromium reads the switch value as a *rule list*, not as a single URL:
 * commas and semicolons separate rules, and a rule may be per-scheme
 * (`https=…`) or `direct://`. So `http://proxy/,direct://` would configure a
 * proxy and a direct route, which is exactly the bypass this option exists to
 * prevent. The value handed to Chromium is therefore rebuilt from the parsed
 * scheme and host rather than passed through, and anything a single endpoint
 * does not need — a rule delimiter, credentials (core never configures proxy
 * authentication), a path, a query, a fragment — is rejected.
 */
/** A proxy host as `URL` normalises it: a name or IPv4, or `[IPv6]`, and an optional port. */
const PROXY_HOST_PATTERN = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d+)?$/i;

function validatedProxyServer(proxyServer: string): string {
  const trimmed = proxyServer.trim();
  if (trimmed === "") {
    throw new Error(
      "browser.proxyServer was supplied but empty; omit the option to launch without a proxy."
    );
  }

  const singleEndpointRule =
    "browser.proxyServer must be a single proxy URL of the form scheme://host:port " +
    "(e.g. http://127.0.0.1:4750)";
  const rejectRuleList = (value: string): void => {
    if (/[,;\s]/.test(value)) {
      throw new Error(
        `${singleEndpointRule}, got '${proxyServer}'. Chromium reads the value as a list of ` +
          "proxy rules, so a second entry (e.g. 'direct://') would let traffic reach the " +
          "network without the proxy."
      );
    }
  };

  // Checked on the raw value: `URL` strips tab and newline characters, so a
  // rule list smuggled past with them would parse as one endpoint.
  rejectRuleList(trimmed);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `browser.proxyServer must be a URL with an explicit scheme (e.g. http://127.0.0.1:4750), got '${proxyServer}'.`
    );
  }

  if (!PROXY_SERVER_SCHEMES.includes(parsed.protocol)) {
    throw new Error(
      `browser.proxyServer scheme '${parsed.protocol.replace(":", "")}' is not supported; use one of ` +
        `${PROXY_SERVER_SCHEMES.map((scheme) => scheme.replace(":", "")).join(", ")}.`
    );
  }

  if (parsed.hostname === "") {
    throw new Error(`${singleEndpointRule}, got '${proxyServer}': it names no host.`);
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      `${singleEndpointRule} and without credentials, got '${proxyServer}': core never ` +
        "configures proxy authentication, and a proxy that demands it is treated as refusing."
    );
  }

  if (
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${singleEndpointRule} and without a path, query or fragment, got '${proxyServer}'.`
    );
  }

  // An allow-list rather than a list of delimiters: `URL` percent-decodes a
  // host, and Chromium's rule parser splits on more than `,` and `;` (`=`
  // starts a per-scheme rule whose unmatched schemes then go direct).
  if (!PROXY_HOST_PATTERN.test(parsed.host)) {
    throw new Error(
      `${singleEndpointRule}, got '${proxyServer}': the host may only contain letters, ` +
        "digits, '.', '-' and '_', or be a bracketed IPv6 address."
    );
  }

  // `host` carries the port and the brackets of an IPv6 literal, which is
  // what Chromium's own proxy URI parser expects.
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * The final Chromium argument list for a launch core performs: the caller's
 * base arguments, then the proxy arguments, then the caller's extra ones.
 *
 * Every launch path goes through this, so no path can end up with a browser
 * that reaches the network on its own. Without `proxyServer` the list is
 * `baseArgs` plus `extraArgs`, which for no options at all is exactly what
 * the path used before this option existed.
 */
export function buildLaunchArgs(
  options: BrowserLaunchOptions | undefined,
  baseArgs: readonly string[] = DEFAULT_LAUNCH_ARGS
): string[] {
  const { proxyServer, extraArgs = [] } = options ?? {};

  // A supplied but empty value is a misconfiguration, not "no proxy": only
  // leaving the option out launches without one.
  if (proxyServer === undefined) {
    return [...baseArgs, ...extraArgs];
  }

  const proxyUrl = validatedProxyServer(proxyServer);

  rejectProxyContradictions([...baseArgs, ...extraArgs]);

  return [
    ...baseArgs,
    `--proxy-server=${proxyUrl}`,
    // Chromium bypasses localhost, 127.0.0.1 and [::1] by default;
    // `<-loopback>` removes that implicit bypass, so a page cannot reach the
    // host the browser runs on behind the proxy's back.
    "--proxy-bypass-list=<-loopback>",
    // WebRTC would otherwise open direct UDP sockets, which no HTTP proxy sees.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ...extraArgs,
  ];
}

export interface LaunchedSession {
  browser: PuppeteerBrowserLike;
  page: PuppeteerPageLike;
}

export interface LaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Proxy and extra Chromium arguments for the browser this call launches. */
  browser?: BrowserLaunchOptions;
}

/**
 * Launch a Puppeteer browser and create a fresh page with the given viewport.
 *
 * Caller is responsible for closing the browser.
 */
export async function launchPuppeteerSession(
  options: LaunchOptions = {}
): Promise<LaunchedSession> {
  const {
    headless = true,
    viewport = { width: 1280, height: 720 },
    browser: browserOptions,
  } = options;
  // Before the import, so a contradicting argument or a malformed proxy URL
  // fails without starting a browser.
  const args = buildLaunchArgs(browserOptions);

  let puppeteerModule: unknown;
  try {
    puppeteerModule = await import("puppeteer");
  } catch {
    throw new Error("This operation requires 'puppeteer'. Install it or pass an existing page.");
  }

  const puppeteer = resolvePuppeteerLauncher(puppeteerModule);
  const browser = await puppeteer.launch({
    headless,
    args,
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
  /**
   * The launch options this audit runs with. They decide how a network-level
   * failure is described: whether a proxy was involved at all, and which
   * response header marks the proxy's own error answers.
   */
  browser?: BrowserLaunchOptions;
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

/**
 * Net errors a consumer may usefully retry: a timeout, a reset, a proxy that
 * was not reachable. A refused destination, a name that does not resolve and
 * a certificate error are permanent as far as a retry goes.
 */
const RETRYABLE_NET_ERRORS = new Set([
  "ERR_TIMED_OUT",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_PROXY_CONNECTION_FAILED",
]);

/**
 * What Chromium reports when the proxy answered the `CONNECT` with 407, which
 * is how Smokescreen denies a destination. Measured against Chromium 141
 * (Puppeteer 24.25) on 2026-10-20: 407 without a `Proxy-Authenticate` header
 * (as Smokescreen sends it) is `ERR_PROXY_AUTH_UNSUPPORTED`, with one it is
 * `ERR_INVALID_AUTH_CREDENTIALS`. Core never configures proxy
 * authentication, so a proxy demanding it is refusing (or misconfigured).
 */
const PROXY_REFUSAL_NET_ERRORS = new Set([
  "ERR_PROXY_AUTH_UNSUPPORTED",
  "ERR_INVALID_AUTH_CREDENTIALS",
  "ERR_PROXY_AUTH_REQUESTED",
]);

/**
 * A `CONNECT` the proxy did not complete, with the reason behind the tunnel.
 * Measured in the same run: 502, 504, 429 and 403 all collapse into this one
 * name, and neither the status nor the body nor a header reaches the page or
 * CDP. With Smokescreen, which denies with 407, this means the proxy could
 * not reach the destination; another proxy may well refuse a `CONNECT` with
 * 403, so a refusal cannot be ruled out either and nothing is claimed.
 */
const AMBIGUOUS_TUNNEL_NET_ERROR = "ERR_TUNNEL_CONNECTION_FAILED";

/** Whether a proxy was configured for the launch this navigation ran in. */
function hasProxy(browser: BrowserLaunchOptions | undefined): boolean {
  return !!browser?.proxyServer?.trim();
}

/**
 * Whether the proxy refused the destination: `true` for the names a refusal
 * produces, `undefined` for a tunnel failure, which hides its reason, and
 * without a proxy, where there is nothing to claim.
 */
function refusedByProxyFor(
  netError: string,
  browser: BrowserLaunchOptions | undefined
): boolean | undefined {
  if (!hasProxy(browser)) {
    return undefined;
  }
  if (PROXY_REFUSAL_NET_ERRORS.has(netError)) {
    return true;
  }
  return netError === AMBIGUOUS_TUNNEL_NET_ERROR ? undefined : false;
}

/** Statuses of a proxy's own error answer a consumer may usefully retry. */
const RETRYABLE_PROXY_STATUSES = new Set([429, 504]);

/** Bound on the proxy message quoted in a `NavigationNetworkError`. */
const MAX_PROXY_ERROR_DETAIL = 200;

interface NavigationNetworkErrorInit {
  netError: string | null;
  url: string;
  failedUrl?: string;
  retryable: boolean;
  refusedByProxy?: boolean;
  proxyStatus?: number;
  /** The proxy's own message, for the error text only. */
  detail?: string;
  cause?: unknown;
}

function buildNetworkErrorMessage(init: NavigationNetworkErrorInit): string {
  const { netError, url, failedUrl, refusedByProxy, proxyStatus, detail } = init;
  const where = failedUrl && failedUrl !== url ? ` (failing URL ${failedUrl})` : "";

  if (netError === null) {
    const status = proxyStatus === undefined ? "an error" : `HTTP ${proxyStatus}`;
    // The status is what the proxy said; `refusedByProxy` only repeats it
    // when a proxy is configured, so the reason reads off the status.
    const reason =
      proxyStatus === 407
        ? "refused the destination"
        : "could not deliver the request to the destination";
    const quoted = detail ? ` Proxy message: ${detail}` : "";
    return (
      `The proxy answered ${status} for ${url}${where} itself and ${reason}; ` +
      `the page was not audited.${quoted}`
    );
  }

  const refusalNote =
    refusedByProxy === true
      ? " The proxy refused the destination (it demanded proxy authentication, " +
        "which core never configures, so the proxy is either refusing the " +
        "destination or misconfigured)."
      : netError === AMBIGUOUS_TUNNEL_NET_ERROR && refusedByProxy === undefined
        ? " The proxy did not open the tunnel and the browser cannot see why: " +
          "the proxy refused the destination with a status it does not expose, " +
          "or could not reach it (no such host, connection refused, timed out)."
        : "";

  return `Navigation to ${url}${where} failed at the network level: net::${netError}.${refusalNote}`;
}

/**
 * Thrown instead of auditing anything when a main-document navigation failed
 * at the network level — a proxy refusal, a DNS failure, a TLS error, a
 * connection refused or reset, a proxy that was not reachable — or when a
 * configured proxy answered the request itself.
 *
 * Match `code` (or use `isNavigationNetworkError`) rather than the message.
 *
 * Behind a proxy the browser does not resolve names itself, so a destination
 * the proxy refused, a hostname that does not exist and a connection the
 * destination refused can all arrive as the same `netError`; `refusedByProxy`
 * is set only where the browser could still tell them apart.
 */
export class NavigationNetworkError extends Error {
  readonly code = "NAVIGATION_NETWORK_ERROR";
  /**
   * Chromium's error name (`ERR_TUNNEL_CONNECTION_FAILED`,
   * `ERR_NAME_NOT_RESOLVED`, `ERR_CERT_*`, …), or `null` when the failure is
   * the proxy's own HTTP answer rather than a browser-level failure.
   */
  readonly netError: string | null;
  /** The URL the audit was asked for. */
  readonly url: string;
  /** The URL the browser blamed, when its error named a different one. */
  readonly failedUrl?: string;
  readonly retryable: boolean;
  /**
   * Only set when a proxy was configured, and only when it is known: true
   * when the proxy refused the destination, false when it was involved and
   * did not refuse it, absent when the failure hides which of the two it was.
   */
  readonly refusedByProxy?: boolean;
  /** Status of the proxy's own error answer, when it sent one. */
  readonly proxyStatus?: number;

  constructor(init: NavigationNetworkErrorInit) {
    super(
      buildNetworkErrorMessage(init),
      init.cause === undefined ? undefined : { cause: init.cause }
    );

    this.name = "NavigationNetworkError";
    this.netError = init.netError;
    this.url = init.url;
    this.retryable = init.retryable;
    if (init.failedUrl !== undefined && init.failedUrl !== init.url) {
      this.failedUrl = init.failedUrl;
    }
    if (init.refusedByProxy !== undefined) {
      this.refusedByProxy = init.refusedByProxy;
    }
    if (init.proxyStatus !== undefined) {
      this.proxyStatus = init.proxyStatus;
    }
  }
}

/**
 * Recognise a `NavigationNetworkError`, including one thrown by a duplicated
 * copy of this module, where `instanceof` does not hold.
 */
export function isNavigationNetworkError(error: unknown): error is NavigationNetworkError {
  if (error instanceof NavigationNetworkError) {
    return true;
  }

  return (
    isRecord(error) &&
    error.code === "NAVIGATION_NETWORK_ERROR" &&
    (typeof error.netError === "string" || error.netError === null) &&
    typeof error.url === "string"
  );
}

/** Chromium's error name out of a Puppeteer or Playwright `goto` rejection. */
function readNetErrorName(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  return /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1] ?? null;
}

/** The URL both drivers append to the net error name, when they do. */
function readFailedUrl(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  return /net::ERR_[A-Z0-9_]+ at (\S+)/.exec(message)?.[1];
}

/**
 * A failed `goto` as a `NavigationNetworkError`, or `null` when the failure
 * was not a network one.
 *
 * A Puppeteer navigation timeout (the `networkidle2` wait running out) is not
 * a network failure — the page may well have loaded — so it carries no
 * `net::` name and keeps its existing behaviour. An unknown `ERR_` name is
 * still a network failure, just not a retryable one.
 */
function toNavigationNetworkError(
  error: unknown,
  url: string,
  browser: BrowserLaunchOptions | undefined
): NavigationNetworkError | null {
  const netError = readNetErrorName(error);
  if (netError === null) {
    return null;
  }

  return new NavigationNetworkError({
    netError,
    url,
    failedUrl: readFailedUrl(error),
    retryable: RETRYABLE_NET_ERRORS.has(netError),
    refusedByProxy: refusedByProxyFor(netError, browser),
    cause: error,
  });
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
 * Throw when the main-document response is the proxy's own error answer
 * rather than the site's, recognised by the header the proxy sets on it.
 *
 * For an `http://` target a proxy answers the browser with an HTTP response
 * instead of failing the tunnel, so without this the proxy's 407 would be
 * audited as the site's own error page — or, with `failOnHttpError`, reported
 * as the site's status.
 */
function checkProxyAnswer(
  response: unknown,
  url: string,
  browser: BrowserLaunchOptions | undefined
): void {
  const header = browser?.proxyErrorHeader;
  if (!header) {
    return;
  }

  const detail = readResponseHeader(response, header);
  if (detail === undefined) {
    return;
  }

  const status = readResponseStatus(response);

  throw new NavigationNetworkError({
    netError: null,
    url,
    retryable: status !== null && RETRYABLE_PROXY_STATUSES.has(status),
    // Documented as absent without a proxy: with only the header configured,
    // the answer is still the proxy's, but core was not told to route
    // through one, so it claims nothing about it.
    refusedByProxy: hasProxy(browser) ? status === 407 : undefined,
    proxyStatus: status ?? undefined,
    detail: detail.trim().slice(0, MAX_PROXY_ERROR_DETAIL),
  });
}

/**
 * Navigate a page to a URL and report the facts of that navigation.
 *
 * A Puppeteer page is navigated with the `networkidle2` heuristic and the
 * timeout; a generic page (Playwright) gets a bare `goto`, whose response
 * carries `status()` and `headers()` just the same.
 *
 * A navigation that failed at the network level, or that a configured proxy
 * answered itself, throws `NavigationNetworkError` here — before the caller
 * does any work on the page.
 */
export async function navigateAndInspect(
  page: BrowserPage | PuppeteerPageLike,
  url: string,
  options: NavigateOptions = {}
): Promise<NavigationOutcome> {
  let response: unknown;
  try {
    response = isPuppeteerPage(page)
      ? await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: options.timeout ?? DEFAULT_NAVIGATION_TIMEOUT,
        })
      : await page.goto(url);
  } catch (error) {
    const networkError = toNavigationNetworkError(error, url, options.browser);
    if (networkError) {
      throw networkError;
    }
    throw error;
  }

  checkProxyAnswer(response, url, options.browser);

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
