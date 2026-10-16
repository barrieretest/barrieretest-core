# Problem statement: callers cannot tell that a page answered with an HTTP error

Status: implemented (contract section at the end, 2026-10-16). Problem statement: Written 2026-10-16 from the barrieretest.at pre-launch audit. A contract (options, invariants, acceptance) follows from the agent that picks this up.

## What happens today

`navigateTo` (`src/puppeteer-launch.ts`) returns the navigation's HTTP status, and for a status `>= 400` it only writes a `console.warn` ("Target returned HTTP <status> for <url>; auditing the served page ...") and lets the audit continue on whatever the server returned. This is the behaviour since 0.8.0, which reverted the 0.7.0 fail-fast throw because auditing the served page is sometimes what a CLI user wants.

The status then disappears:

- `runAxeCore` (`src/engines/axe.ts`) keeps it in a local `navigationStatus` that is only used to enrich the "axe-core failed to load" error.
- `AuditResult` (`src/types.ts`) has no field for the navigation status, the final URL after redirects, or the warnings that were emitted. Warnings go to `console.warn` only.
- The semantic pass (`src/semantic/runner.ts`) navigates with `navigateTo` as well and drops the status the same way.

So a 403 bot-protection challenge, a 404, a 429 or a 503 maintenance page produces a normal `AuditResult` with a score and findings about the error page. Only when the error page also blocks axe (strict CSP) does the caller see an exception.

## Why it matters

barrieretest.at bills one credit per scanned page and runs paid multi-page scans with a "canary": the first page runs alone, and if the site blocks the scanner the scan stops and every credit is refunded. Its error classification still looks for the 0.7 wording ("navigation blocked" / "returned http") in a thrown error, which no longer comes. Consequences in production:

- A site whose firewall answers the scanner with 403 completes as a normal, charged scan of the challenge page, for every page of the scan.
- The canary never stops such scans, the refund never happens, and the help page that explains how to allow the scanner never triggers.
- Customers receive accessibility findings about a Cloudflare or WAF error page and may not notice.
- The AI pass is sent the error page's screenshot, which costs money and produces nonsense.

The consumer cannot fix this alone: it does not see the status, and parsing `console.warn` output from inside a library call is not an option.

## What a solution must give a consumer

1. **The facts of the navigation on the result**: at least the HTTP status of the main document response (or that there was none), and the final URL after redirects. Available for every engine path that navigates (axe engine, pa11y engine, standalone semantic audit). A caller-supplied page that core did not navigate reports that no navigation happened.
2. **A way to make an error status fatal, chosen by the caller**: e.g. an option that turns a `>= 400` main-document status into a typed, recognisable error before axe, the screenshot, annotation or the semantic pass run (no browser work and no AI cost spent on an error page). The default must stay as it is (audit the served page), so CLI behaviour and existing users do not change.
3. **A stable way to recognise it**: a typed error (class or `code` property) carrying the status and URL, not a message string a consumer has to match. If a message is kept for humans, it should not be the contract.
4. **Warnings as data**: the warnings that are currently only logged (HTTP status, lazy content, annotation, cookie banner) should be available on the result for consumers that want to show or log them. Optional for this change, but the status warning should at least be reachable without parsing console output.

## Questions the contract has to answer

- Which statuses count. `>= 400` covers 403/404/429/5xx; is a 3xx chain that ends on a different host relevant? What about a 200 response that is a known challenge page (Cloudflare "Just a moment", interstitials)? Probably out of scope for the first step, but the field design should not block adding a "suspected challenge" signal later.
- Where the check lives so that all three navigating paths behave the same (shared helper vs. per engine).
- Interaction with retries in consumers: a fatal HTTP error is usually permanent for minutes, so the error should make that clear (status-dependent: 429/503 may be retryable, 403/404 not).
- Whether `semanticAudit(url)` alone also gets the option.
- Versioning: additive result fields and an opt-in option are a minor release; the changelog must state the 0.8 behaviour is unchanged by default.

## Consumer follow-up (barrieretest.at, not part of this repo)

Once released, the backend passes the fail option for scans, maps the typed error to its `navigation_blocked` classification (German user message, canary stop, refund), and shows the final URL when it differs from the requested one. Tracked in `barrieretest/docs/launch-checklist-v2.md`, section 6.

## Contract (2026-10-16, barrieretest-core)

### Decisions on the open questions

- **Which statuses count:** a main-document response with status `>= 400`. A 3xx chain is followed by the browser and judged by its final response; the result records the final URL and whether a redirect happened, so a consumer can compare hosts. A 200 challenge page is out of scope; the result field is an object so a `suspectedChallenge` signal can be added later without a breaking change. No response at all (some `file:` URLs, a page that never committed) is `status: null` and never fatal.
- **Where the check lives:** one shared helper next to `navigateTo` in `src/puppeteer-launch.ts`, used by every path that navigates: the axe engine (Puppeteer `navigateTo` and the generic `page.goto` branch), the pa11y engine (which today calls `page.goto` directly) and the standalone `semanticAudit(url)`. The helper reads status, final URL and the `Retry-After` header from the navigation response.
- **Retries:** the error carries `retryable`, true for 408, 425, 429, 500, 502, 503 and 504 and false otherwise, plus `retryAfterSeconds` when the response sent a numeric or date `Retry-After`.
- **Standalone `semanticAudit(url)`:** gets the same option.
- **Warnings as data:** not part of this change. The HTTP status is reachable through the new result field; a general `warnings` array is a follow-up that should collect every warning source at once rather than one.
- **Versioning:** additive result field and opt-in option; minor release; CHANGELOG states that the default behaviour since 0.8.0 is unchanged.

### API

```ts
export interface NavigationInfo {
  /** True when core navigated the page itself; false for a caller-supplied page it left where it was. */
  navigated: boolean;
  /** The URL core was asked to audit. */
  requestedUrl: string;
  /** The page URL after navigation and redirects (page.url()). */
  finalUrl: string;
  /** HTTP status of the main document response; null when there was none or core did not navigate. */
  status: number | null;
  /**
   * True when finalUrl differs from requestedUrl after normalisation
   * (trailing slash, default port, fragment). A fragment-only difference is
   * not a redirect: the browser requests no new document for it, and the
   * fragment is still part of finalUrl.
   */
  redirected: boolean;
}

// AuditResult.navigation?: NavigationInfo  (always set when an engine ran)
// SemanticAuditResult.navigation?: NavigationInfo
// AuditOptions.failOnHttpError?: boolean   (default false)
// SemanticOptions.failOnHttpError?: boolean (default false)

export class NavigationHttpError extends Error {
  readonly code = "NAVIGATION_HTTP_ERROR";
  readonly status: number;
  readonly url: string;        // requested URL
  readonly finalUrl: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}
export function isNavigationHttpError(error: unknown): error is NavigationHttpError;
```

Both exported from the package root. The type guard checks `code` as well as `instanceof`, so it works across duplicated module copies.

### Invariants

1. **Default unchanged.** Without `failOnHttpError` an audit of an error page behaves exactly as today: one `console.warn`, the served page is audited, same score and findings. The only addition is `result.navigation`.
2. **Fail before any work.** With `failOnHttpError: true` and a status `>= 400`, the error is thrown immediately after navigation: no cookie-banner dismissal, no lazy-content scroll, no axe, no screenshot, no rendering pass, no annotation, no semantic pass (no AI request). An owned browser session is still closed (`audit()`'s existing `finally`).
3. **Same behaviour on every navigating path:** axe engine (Puppeteer and generic page), pa11y engine, standalone `semanticAudit(url)`.
4. **Caller-supplied pages:** when core does not navigate (axe engine with a page already at the URL, `semanticAudit(page)`), `navigation` is `{ navigated: false, status: null, finalUrl: page.url(), ... }` and `failOnHttpError` has no effect, since there is no response to judge.
5. **Recognisable error:** consumers match `code` or use the guard; the message is for humans and is not the contract.

### Surfaces

- CLI: `--fail-on-http-error` on `audit`; the CLI prints the error's message and exits non-zero (as for other audit errors). Default off.
- README: a short "Navigation status" section (field, option, error, retry hints). CHANGELOG `[Unreleased]`: Added entries, plus the explicit "default unchanged" sentence.

### Acceptance criteria

1. A local server (or route interception) answering 403 for the audited URL: default audit returns a result with `navigation.status === 403` and the usual findings; with `failOnHttpError` it rejects with a `NavigationHttpError` (`status 403`, `retryable false`), and no axe run, screenshot, rendering or semantic provider call happened (assert via spies/stubs).
2. 429 with `Retry-After: 30` and 503: `retryable true`, `retryAfterSeconds 30` for the first.
3. A redirect from `/old` to `/new`: `navigation.redirected === true`, `finalUrl` ends in `/new`, status of the final response.
4. pa11y engine and standalone `semanticAudit(url)` behave the same for a 403 with and without the option (stubbed where the real tool is not needed).
5. A caller-supplied page already at its URL: `navigation.navigated === false`, `status null`, no throw with the option set.
6. CLI `--fail-on-http-error` exits non-zero with the status in its message.
7. All existing tests pass unchanged.

