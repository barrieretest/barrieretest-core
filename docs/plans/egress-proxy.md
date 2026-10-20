# Contract: route every browser core launches through a caller-supplied egress proxy

Status: implemented in the working tree on 2026-10-20, not released (the release is a separate, minor version bump when Andreas asks). Written 2026-10-20 for the barrieretest.at launch (consumer side: `barrieretest/docs/plans/egress-proxy.md`).

## Problem

A consumer that scans URLs submitted by strangers validates the URL once, before the audit. After that the browser core launches follows redirects and loads iframes, images, scripts, fetches and WebSockets wherever the page points, including private and link-local addresses: the cloud metadata service (`169.254.169.254`), `localhost`, the Docker network, the host. The full-page screenshot, the HTML snippets in findings and the AI context then hand whatever came back to the requester. Validating every request in Node cannot close this: Chrome resolves DNS itself, so a hostname that answers publicly to the check and privately to Chrome (DNS rebinding) slips through.

The robust place to enforce "public internet only" is a filtering egress proxy that resolves each hostname itself, refuses non-public addresses and connects to exactly the address it checked. The consumer runs that proxy. Core's part is to make sure a browser it launches cannot reach anything except through it, and to tell the caller clearly when a navigation was refused or failed at the network level.

## Outcome

1. A caller can pass a proxy, and every Chromium instance core launches (all paths: `launchPuppeteerSession` in `src/puppeteer-launch.ts`, the axe engine `src/engines/axe.ts`, `audit()`'s own session in `src/audit.ts`, the pa11y engine `src/engines/pa11y.ts` with its own `chromeArgs`, and the standalone semantic audit in `src/semantic/runner.ts`) sends all its traffic through it, loopback included.
2. A main-document navigation that fails at the network level (proxy refusal, DNS failure, TLS error, connection refused or reset, proxy unreachable) throws a typed error the caller can recognise by code, with the Chromium error name and a retry hint, instead of a generic `page.goto` error string.

## Invariants

1. **No bypass when a proxy is set.** The launch arguments are `--proxy-server=<url>` and `--proxy-bypass-list=<-loopback>` (Chromium bypasses `localhost`, `127.0.0.1` and `[::1]` by default; `<-loopback>` removes that implicit bypass). WebRTC must not open direct UDP: `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. No other bypass entries are added, and caller-supplied extra arguments that contradict these (`--proxy-server`, `--proxy-bypass-list`, `--no-proxy-server`, `--proxy-pac-url`, `--proxy-auto-detect`, `--host-resolver-rules`, `--host-rules`) are rejected with a clear error when a proxy is configured.
2. **Opt-in, default unchanged.** Without the option nothing about launching changes. CLI users keep today's behaviour.
3. **A page the caller supplies is the caller's business.** Core does not reconfigure a browser it did not launch; the option only applies to launches core performs, and the docs say so.
4. **Typed network errors, matched by code.** A main-document navigation failure caused by the network throws `NavigationNetworkError` with `code: "NAVIGATION_NETWORK_ERROR"`, `netError` (the Chromium name, e.g. `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_PROXY_CONNECTION_FAILED`, `ERR_NAME_NOT_RESOLVED`, `ERR_CERT_*`, `ERR_CONNECTION_REFUSED`, `ERR_CONNECTION_RESET`, `ERR_TIMED_OUT`), `url`, `retryable` (true for timeouts, resets and proxy-unreachable; false for name-not-resolved, certificate and tunnel/refusal errors) and, when the error came from the proxy refusing the destination, `refusedByProxy: true`. An `isNavigationNetworkError()` guard works across duplicated package copies like `isNavigationHttpError()`. Navigation timeouts that core already reports keep their current behaviour unless they are better expressed by this error (state the choice).
5. **Proxy refusal over plain HTTP is recognisable.** For `http://` targets a proxy answers the browser with an HTTP response instead of failing the tunnel. With `failOnHttpError` that becomes a `NavigationHttpError`; a caller must be able to tell a proxy refusal apart from the site's own 403. Define how: e.g. an optional `proxyRefusalHeader` option (header name the proxy sets on its refusals, such as Smokescreen's error header) that turns a matching response into `NavigationNetworkError` with `refusedByProxy: true`. Verify the header Smokescreen actually sends and document it.
6. **Subresources are not errors.** A refused image, script, iframe or fetch does not fail the audit; the page is audited as rendered. Optionally count refused subresource requests on `result.navigation` (e.g. `blockedRequests: number`) without listing URLs.

## Scope

- Option shape (proposal, the implementer may refine and must document): `AuditOptions.browser?: { proxyServer?: string; proxyRefusalHeader?: string; extraArgs?: string[] }`, the same on `SemanticOptions`, threaded through every launch path in Outcome 1. One shared helper builds the final argument list from `DEFAULT_LAUNCH_ARGS`, the proxy arguments and the extra arguments, so the five call sites cannot drift.
- `NavigationNetworkError`, `isNavigationNetworkError` exported from the package root, next to `NavigationHttpError`.
- `result.navigation` keeps its shape; add `blockedRequests` only if it is cheap and reliable.
- CLI: `--proxy-server <url>` on `audit` (optional, for local testing).
- README section "Running behind an egress proxy" with the Smokescreen example and the bypass rule; CHANGELOG `[Unreleased]` Added entries.

## Non-goals

Running or bundling a proxy; proxy authentication; per-request allow lists in core; changing user agent, viewport or the existing `failOnHttpError` semantics; Playwright browsers a caller brings.

## Acceptance

1. Integration test with a local test proxy (a tiny CONNECT/HTTP proxy in the test that records requested hosts and can refuse some): with `browser.proxyServer` set, a page whose HTML loads an image from `http://127.0.0.1:<port>/x.png` and an iframe from `http://localhost:<port>/` produces proxy requests for both (proof that loopback is not bypassed) and no direct connection to that port (the target server records zero hits).
2. A navigation the test proxy refuses with a tunnel failure throws `NavigationNetworkError` with `refusedByProxy: true` and `retryable: false`; an `http://` navigation refused with the configured refusal header does the same.
3. A navigation to an unresolvable hostname without a proxy throws `NavigationNetworkError` with `netError: "ERR_NAME_NOT_RESOLVED"`.
4. Each of the five launch paths gets the proxy arguments (unit test on the shared helper plus one assertion per path).
5. Without the option, launch arguments and behaviour are byte-for-byte what they were (snapshot test of the argument list).
6. Typecheck, lint and the full test suite green; version bump per the repo's release process (minor).

## Amendments (2026-10-20, barrieretest-core)

These override the sections above where they differ.

### A1. Behind a proxy, Chrome does not resolve names, so failures look alike

With a proxy, the browser hands the hostname to the proxy and never resolves it. For an `https://` target the proxy answers the browser's `CONNECT` with a status, and Chromium does not expose that response to the page or to CDP: a refused destination, a hostname that does not exist and a connection the destination refused can all surface as the same `ERR_TUNNEL_CONNECTION_FAILED`. `ERR_NAME_NOT_RESOLVED` and `ERR_CONNECTION_REFUSED` only occur without a proxy. A typo'd domain must not be reported as "refused by the proxy".

Smokescreen (verified in `pkg/smokescreen/smokescreen.go`, `rejectResponse`) answers every error of its own with the header `X-Smokescreen-Error: <message>` and these statuses: **407** "Request rejected by proxy" for a denied destination (`denyError`), **502** for a failed name resolution or connection, **504** for a connection timeout, **429** (with `Retry-After: 1`) for its tunnel limit, **500** otherwise. A deny is therefore distinguishable by status, if the browser lets the status through.

### A2. `refusedByProxy` is only claimed when it is known

`NavigationNetworkError.refusedByProxy?: boolean` is set only when a proxy is configured: `true` when the proxy refused the destination, `false` when the proxy was involved and did not refuse it, absent when it cannot be told. Without a proxy it is absent.

- **https (tunnel).** The implementer measures what Chromium reports for a `CONNECT` answered with 407 (no `Proxy-Authenticate` header, as Smokescreen sends it) versus 502, 504 and 429, using the test proxy, and records the results in this file. If 407 surfaces as a distinct net error (an `ERR_PROXY_AUTH_*` name, say), that name means `refusedByProxy: true`; what `ERR_TUNNEL_CONNECTION_FAILED` means is decided by the measurement below, and it carries no `refusedByProxy` (unknown) if a refusal cannot be ruled out. Core never configures proxy authentication, so a 407 on the tunnel can only be a refusal (or a misconfigured proxy, which the error message mentions).

  **Measured** (2026-10-20, Chromium 141.0.7390.78 via Puppeteer 24.25, headless, test proxy in the test process, `https://` target, `page.goto` rejection message):

  | `CONNECT` answered with | Chromium reports |
  | --- | --- |
  | 407, no `Proxy-Authenticate` (Smokescreen's deny) | `net::ERR_PROXY_AUTH_UNSUPPORTED` |
  | 407 with `Proxy-Authenticate: Basic …` | `net::ERR_INVALID_AUTH_CREDENTIALS` |
  | 502 | `net::ERR_TUNNEL_CONNECTION_FAILED` |
  | 504 | `net::ERR_TUNNEL_CONNECTION_FAILED` |
  | 429 (with `Retry-After: 1`) | `net::ERR_TUNNEL_CONNECTION_FAILED` |
  | 403 (not a Smokescreen status, measured for completeness) | `net::ERR_TUNNEL_CONNECTION_FAILED` |

  Neither 407 answer exposes the status, the body or the `X-Smokescreen-Error` header to the page or to CDP; only the error name differs. So the implemented branch is:

  - `ERR_PROXY_AUTH_UNSUPPORTED`, `ERR_INVALID_AUTH_CREDENTIALS` and `ERR_PROXY_AUTH_REQUESTED` (the third not measured, same meaning) → `refusedByProxy: true`.
  - `ERR_TUNNEL_CONNECTION_FAILED` → `refusedByProxy` **absent** (unknown). The 403 row is why: the option takes any caller-supplied proxy, and a proxy other than Smokescreen may well refuse a `CONNECT` with 403, which Chromium reports identically to the 502, 504 and 429 of a proxy that could not reach the destination. Nothing behind the tunnel reaches the browser, so neither "refused" nor "not refused" can be claimed. With Smokescreen, which refuses with 407, a tunnel failure does mean the proxy could not reach the destination: no such host, connection refused, connection timed out, or its tunnel limit (429).
  - every other net error behind a proxy (certificate errors, timeouts, resets after the tunnel was open) → `refusedByProxy: false`, and `ERR_PROXY_CONNECTION_FAILED` (proxy unreachable) → `false`.

  `retryable` is false for all of the tunnel and refusal cases.

  Also measured, same run: a proxy on a closed port → `net::ERR_PROXY_CONNECTION_FAILED` (for both an `http://` and an `https://` target, and for an unresolvable host, because the browser never resolves it); without a proxy, an unresolvable host → `net::ERR_NAME_NOT_RESOLVED`. With `--proxy-bypass-list=<-loopback>` an image from `http://127.0.0.1:<port>` and an iframe from `http://localhost:<port>` both arrive at the proxy and the target server records no direct hit.
- **http (proxied request).** The option is renamed `proxyErrorHeader` (Smokescreen sets its header on all of its own errors, not only refusals). A main-document response carrying that header is the proxy's own answer, never the site's: it throws `NavigationNetworkError` regardless of `failOnHttpError`, with `netError: null`, `proxyStatus` (the status), `refusedByProxy: proxyStatus === 407` when a proxy is configured (absent when only the header is, because the field is documented as absent without a proxy), and `retryable` true for 429 and 504, false otherwise. The page is not audited. The header value goes into the error message (trimmed), not into a field consumers should parse.
- **Proxy unreachable** (`ERR_PROXY_CONNECTION_FAILED`): `refusedByProxy: false`, `retryable: true`.

`netError` is therefore `string | null`: the Chromium name for a browser-level failure, `null` for a proxy's HTTP error answer.

### A3. Retry and timeout choices

`retryable` follows invariant 4, with tunnel failures not retryable. A Puppeteer navigation timeout (the `networkidle2` wait running out) keeps today's behaviour: it is not a network error, the page may have loaded. Only a Chromium `ERR_TIMED_OUT` / `ERR_CONNECTION_TIMED_OUT` becomes `NavigationNetworkError` (retryable).

### A4. Scope changes

- `blockedRequests` is dropped: with A1, a count of failed proxied subresources cannot say "blocked" reliably.
- CLI: `--proxy-server <url>` and `--proxy-error-header <name>`.
- No version bump in the implementation; the release (minor) happens when Andreas asks.
- Acceptance 2 becomes: a tunnel the test proxy refuses with 407 and one it fails with 502 produce the errors A2 prescribes for the measured browser behaviour; an `http://` navigation answered with the configured header and 407 throws with `refusedByProxy: true`, `netError: null`, `proxyStatus: 407`, and with 502 throws with `refusedByProxy: false`, even without `failOnHttpError`.
- The consumer contract (`barrieretest/docs/plans/egress-proxy.md`, section 5) needs the same correction: behind the proxy, "DNS name does not exist" and "connection refused" arrive as the tunnel failure (https) or a 502 proxy answer (http), not as `ERR_NAME_NOT_RESOLVED` / `ERR_CONNECTION_REFUSED`.
