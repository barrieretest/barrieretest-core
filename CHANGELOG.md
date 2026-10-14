# Changelog

All notable changes to `@barrieretest/core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Screenshot coordinate map.** `Issue.annotation` reports where an issue's element sits on the page screenshot: the resolved `selector`, a `state` (`"resolved"`, `"ambiguous"`, `"hidden"`, `"page"` for a rule that targets `html` or `body`, `"unresolved"`), a `rect` in whole CSS pixels in document space, a 1-based `mark` shared by all issues on the same element, and `anchored: true` for an element inside a `fixed` or `sticky` ancestor. Engine findings and semantic findings go through the same path, since both arrive as an `Issue.selector`; a semantic location the model wrote as prose comes out `unresolved` and stays in `issues`.
- `AuditResult.screenshotMeta` with the geometry of the capture — CSS pixel size, `deviceScaleFactor`, viewport, document scroll size and scroll offset at measurement time — so a consumer can place rects on the image without knowing how it was taken.
- **Static HTML report.** `renderHtmlReport(result, { locale })` returns one self-contained HTML document: the full-page screenshot with a numbered marker on every located element, and beside it the issue list grouped by marker, then page-level issues, then issues that could not be placed. Markers are positioned in percentages of `screenshotMeta`, so they stay on their elements at any rendered size. The renderer is pure and deterministic — no browser, no file system, no network — and the output has no JavaScript, inlines the screenshot as a `data:` URL, and carries `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'`. Every string from the audited page or a model is escaped, and only `http:`/`https:` URLs become links. A findings-by-rule table summarises the rules, and from 1024 px the screenshot panel is sticky with its own scroll, so it stays in view while the list scrolls. Report labels come in English (default) and German (`locale: 'de'`, including a German score interpretation per severity level); issue texts stay as the engine or the model wrote them. A result without `screenshotMeta` renders the screenshot without markers and the list ungrouped; a result without a screenshot renders the list only.
- CLI flags `--html <file>` (writes the report, creating parent directories like `-o`, combinable with `--json` and `-o`) and `--html-locale <en|de>`. The text output names the written file.
- **Lazy content is loaded before auditing.** A page the audit navigated is scrolled through once — after the cookie banner is dismissed, before axe runs and before anything is captured or measured — so images with `loading="lazy"`, script-based lazy loaders and reveal-on-scroll effects below the first viewport have loaded. One viewport per step, capped at 20 000 CSS px or 40 steps with a short settle per step, then up to 2 s for images that are still loading, all inside an overall budget of about 6 s enforced in the page and again by a Node-side timeout. The whole loop is one `page.evaluate` and the page ends at scroll position 0, so axe, the semantic context, the screenshot and the annotations see the same loaded page. It never fails an audit: an error or timeout costs one warning starting with `Lazy content`, after a best-effort scroll back to the top. `AuditOptions.loadLazyContent` and `SemanticOptions.loadLazyContent` (both default `true`) turn it off. The step runs whenever the audit navigates: the axe engine navigates only when the page is not already at the target URL, the pa11y engine always navigates, and standalone `semanticAudit(url)` launches its own page — so a page you pass in is scrolled unless it is already at the target URL and the axe engine is used. The step also adds one constructed stylesheet to `document.adoptedStyleSheets` (at most once per page, not blocked by a page's `style-src` policy, no element added) that forces `content-visibility: visible` and stays in place for the rest of the audit, because content marked `auto` is loaded but paints blank outside the viewport and would be empty in the full-page capture; leaving it in keeps one layout for axe, the screenshot and the annotations, and a page the audit did not navigate is not touched and keeps the blank capture. Only the `auto` case is overridden: content that is deliberately unrendered with `content-visibility: hidden` at the time of the step stays hidden (an element a site hides only afterwards is not covered; see the README), so collapsed content is not audited as if it were open — `hidden="until-found"` elements are excluded by the selector, and elements whose computed `content-visibility` is `hidden` are marked `data-barrieretest-keep-hidden` in one pass before the stylesheet goes in. Also exported as `loadLazyContent(page, options?)`, whose summary now reports `renderAll` and `keptHidden`. Known limitations: scroll-triggered pop-ups can appear in the capture, content that loads later than the image wait stays unloaded, and pages with scroll hijacking may not reach their end within the caps.
- `AuditOptions.annotate` (default `true`). Effective with `captureScreenshot`, the axe engine, and a captured screenshot; one browser round trip measures every selector after baseline processing, read-only. For a URL target with the axe engine, `audit()` now owns the Puppeteer session when annotation is effective, as it already did for `semantic`. `engine: 'pa11y'` and standalone `semanticAudit()` are not annotated. Annotation never fails an audit: a screenshot whose size cannot be read means no annotations, a failed or timed-out measurement leaves every issue `unresolved`, each with one warning starting with `Annotation`. Baseline files and the last-run cache never contain annotations.

### Changed

- **Marker numbers follow the page, not the issue list.** `Issue.annotation.mark` is numbered by the marked element's `rect` — top edge ascending, then left edge, then first appearance in `issues` for a tie — so marker 1 is the topmost marked element and the numbers read top to bottom on the screenshot. One number per element and contiguity from 1 are unchanged, as is the order of `issues`; a consumer that relied on marks running in issue order (within this unreleased coordinate map) must not.
- **Audit results can include content that was previously unloaded.** Because the page is now scrolled through before auditing, lazy images and reveal-on-scroll sections are part of the DOM axe sees and of the screenshot, so a page can report issues it did not report before and existing baselines can shift. Set `loadLazyContent: false` for the old behavior.

## [0.8.0]

### Added

- **`mistral` provider.** `MISTRAL_API_KEY`, default model `mistral-large-4`. Mistral is now the first option and the lexical default in the `init` wizard.
- **`openai-compatible` provider.** Any chat-completions endpoint, configured with `baseUrl` + `model` (`OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`).
- `baseUrl`, `capabilities`, and `timeout` on the provider config, plus a built-in model capability table (vision, JSON schema). A model that lacks a capability the run needs — a screenshot check on a text-only model, for example — now throws a configuration error naming the provider, the model, and what is missing, before any network call. The table is advisory; `capabilities` always wins.
- **Native structured output.** With a JSON-schema-capable provider the semantic runner passes the response schema to the model and uses the parsed object instead of parsing JSON out of prose. Providers without it keep the prose-described schema and the text parser.
- **Two model tiers for the semantic pass.** `SemanticCheck.tier` (`"small"` | `"large"`, default `"large"`), `SemanticOptions.tiers` for per-tier provider configs, and `SemanticMeta.tiers` reporting the provider, model, and check ids each tier ran. No built-in check runs on the small tier by default — in live runs `mistral-small-2603` was not reliable enough for the alt-text judgement even with complete evidence — so the tier is there for custom checks that opt in with `"tier": "small"`.
- CLI flags `--semantic-base-url`, `--semantic-small-provider`, `--semantic-small-model`, `--semantic-large-provider`, `--semantic-large-model`, and config keys `semantic.baseUrl`, `semantic.tiers.{small,large}.{provider,model,baseUrl}`. Project config merges tier overrides leaf by leaf.
- `barrieretest check add` asks for the model tier, and `check list` shows it.
- **Prompt caching.** The semantic user prompt now leads with everything that depends only on the check set (guardrails, numbered check instructions, response contract) and puts the URL, the prompt-hardening summary, and the page context last, so the instruction block — about 1,900 tokens with all built-in checks — is a literal shared prefix across pages — provider prefix caches match on exactly that, and with the page facts in the middle no live run ever reported a hit. Each tier additionally sends `prompt_cache_key: barrieretest-semantic-<tier>-<hash of the constant prompt>` to `mistral` and `openai` as a routing hint, and `SemanticMeta.tiers.<tier>.usage` reports `inputTokens`, `outputTokens`, and `cachedInputTokens` when the provider reports them — both for every provider that implements the unified request path, whether or not its model takes a JSON schema. As measured in October 2026, Mistral serves no cache hit for a request that contains an image, in any position and with or without a schema, while the identical request without one hits on the second call; every built-in check except `lang-attribute` sends the screenshot, so a default run on Mistral sees no caching. Text-only tiers on Mistral and OpenAI's cache, which covers image requests, do benefit.
- **Reasoning control.** `reasoningEffort` on the provider and semantic-tier configs (passed verbatim; documented values `"none"` and `"high"`), config keys `semantic.reasoningEffort` and `semantic.tiers.{small,large}.reasoningEffort`, and a `reasoning` model capability for models that emit reasoning by default. `mistral-large-4` is declared as one.

### Changed

- **`nebius` is an alias for `openai-compatible`** with the Nebius base URL and its existing default model. Existing configurations keep working unchanged. That default model, `openai/gpt-oss-120b`, is declared text-only, so a Nebius configuration that selects a screenshot check now throws a configuration error instead of silently sending images to a text model. Pick a vision model, declare `capabilities: { vision: true }`, or deselect those checks.
- **Reasoning is off by default on known reasoning models.** A chat-completions request for a model the capability table marks as `reasoning` sends `reasoning_effort: "none"` unless `reasoningEffort` says otherwise. The semantic pass is a one-shot structured extraction, and on `mistral-large-4` the reasoning pass alone consumed the whole 2000-token budget and returned no answer. Set `reasoningEffort: "high"` plus a larger `maxTokens` to opt back in.
- **Semantic responses have a 4000-token floor, and truncation says so.** `maxTokens` for the semantic pass is lifted to at least 4000 (was 2000); a page with many images or form fields produced more than 2000 tokens of findings. A response the model cut off mid-JSON now throws an error naming `max_tokens` and the budget that was sent instead of surfacing as a bare JSON parse error, on the schema path and the text path alike; only providers that expose nothing but the legacy `analyzeSemantic()` still surface a parse error.
- **Built-in check prompts state their failure criteria.** Each built-in check now says what counts as a failure, what does not, and which severity applies, and the shared prompt states that an empty issues array is the expected answer for a page without failures. Live runs reported passing elements as issues and re-derived their verdict inside the message.
- **Form fields and images reach the model as structured lines instead of truncated HTML.** Each form control is one line that leads with its accessible name and how it was resolved (`label for=`, wrapping `<label>`, `aria-labelledby`, `aria-label`, the `alt` of an `input[type=image]` or of an icon button's image, `title`, button text or value, and the native `Submit`/`Reset` defaults), with an explicit `label: (none)` when there is none; each image is one line with a unique selector, verified against the live document, and its `alt` value up to 1000 characters (a longer one is truncated with an ellipsis). Images taken out of the accessibility tree (`aria-hidden="true"` on the element or an ancestor, `role="presentation"`/`"none"`) and images not rendered at the audited viewport are left out of the list and reported as counts instead, and a list cut off by its cap says how many are missing. A truncated `outerHTML` snippet had hidden exactly the attributes the judgement needs, which produced "missing label" and "missing alt" findings for elements that had both.
- **Each tier sees only the context sections its own checks need.** A tier handed the union of all sections found elements it was not asked about and reported them under its own checks.
- **Findings the model rates below 10% confidence are dropped**, with one warning per tier. Models used a near-zero confidence for entries whose own message concluded the element was fine.
- **Findings for the same element and check are merged into one issue**, keeping the strongest severity and appending the later messages, with one warning per tier.
- Empty or whitespace-only API keys throw at provider creation instead of failing as an authentication error on the first request.
- Every provider request has a timeout and an abort path, and retries once on HTTP 429 and 5xx with a short jittered backoff. Errors carry the HTTP status and at most 500 characters of the response body; request bodies, headers, and keys are never logged.

### Fixed

- `navigateTo` no longer throws for HTTP status `>= 400` (introduced in 0.7.0). It returns the status, warns `Target returned HTTP <status> for <url>; auditing the served page (bot protection or rate limiting may be in effect).`, and the page is audited as served; the axe-load failure message includes the status among its diagnostics.

## [0.7.0]

### Added

- **Diagnostic axe-load failures.** When axe-core does not become available after injection (commonly a strict CSP on a bot-protection / WAF challenge page), the thrown error now includes the final URL, HTTP status, page title, a snippet of the served HTML, and captured browser `console`/`pageerror` output — instead of a bare `axe-core failed to load.` Browser console and page errors are captured during the run for this purpose.
- `navigateTo` now returns the navigation HTTP status (`number | undefined`).

### Changed

- **Fail fast on non-OK navigations.** A navigation that resolves with an HTTP status `>= 400` throws `Target returned HTTP <status> for <url> — navigation blocked (possibly bot protection or rate limiting).` before the audit proceeds. Reverted in 0.8.0 (see the Fixed entry there).
- Browser pages now send a realistic desktop Chrome user-agent (no `HeadlessChrome` token) to reduce the chance of being served a bot-protection challenge.

### Fixed

- `runAxe` no longer leaks its timeout timer when the audit completes before the timeout fires.

## [0.6.1]

### Changed

- Documentation updates: clarified that `@barrieretest/core` powers the free single-page checks on [barrieretest.at](https://barrieretest.at) and added a "Try it" pointer.

## [0.6.0]

### Added

- **Custom semantic checks.** Author your own vision-LLM accessibility checks declaratively (`UserCheckConfig`: id, title, description, prompt, optional `needsScreenshot` and `context` sections) and run them alongside the built-ins. Findings are returned as normal `Issue` entries with ids `semantic:<check-id>`.
- `barrieretest check` command with `add` (interactive wizard), `list` (built-in + user checks), `remove <id>`, and `test <id> --url <url>` (dry-run a single check) subcommands.
- Project-level config file `.barrieretest.json`, intended to be committed so a team shares one check set. Custom checks can live in the global config (`~/.barrieretest/config.json`) or per-project.
- `semantic.customChecks` config key, with validation of its shape at load time.

### Changed

- Config merge semantics for global + project: scalar keys (`provider`, `model`, `timeout`, `checks`) resolve project-over-global; `customChecks` are concatenated, with a project entry overriding a global one of the same id (and a stderr warning). Built-in check ids cannot be overridden by a user check — colliding ids are rejected at `check add` and at load time.

### Notes

- User-check ids must match `^[a-z0-9][a-z0-9-]{1,39}$` so they are safe as filenames, prompt labels, and `Issue.id` suffixes.
- The semantic runner drops findings whose `checkType` was not in the resolved check set (hallucinated or unrequested ids) and warns.

## [0.5.0]

### Added

- `barrieretest init` — interactive TUI wizard that walks users through semantic setup (provider, model, checks, timeout) and writes `~/.barrieretest/config.json`. Auto-detects existing config and provider API-key env vars to pre-select sensible defaults. Suggested model per provider: `nebius` → `openai/gpt-oss-120b`, `openai` → `gpt-4o`, `anthropic` → `claude-sonnet-4-5`. Ctrl+C aborts cleanly with exit code 130; non-TTY environments get a clear error instead of a hang.
- `--semantic` flag and `--semantic-*` overrides (`--semantic-provider`, `--semantic-model`, `--semantic-checks`, `--semantic-timeout`) on the `barrieretest` CLI. Any `--semantic-*` flag implicitly enables semantic mode; config defaults alone never do.
- Provider resolution order for the CLI: explicit `--semantic-provider` > `semantic.provider` in user config > inferred from env when exactly one of `NEBIUS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` is set. Missing or ambiguous resolution fails with a clear error.
- `barrieretest config <get|set|unset|path>` subcommand for managing non-secret defaults at `~/.barrieretest/config.json`. Supported keys: `semantic.provider`, `semantic.model`, `semantic.checks`, `semantic.timeout`.
- CLI text output now includes a short semantic summary block (provider, model, checks run, findings count) when a run returned `semanticMeta`.
- `npm run debug:cli -- <args>` to build the package and launch the local compiled CLI (`dist/cli/bin.js`) under Node's inspector with `--inspect-brk` for easier debugging.

### Changed

- `runCli()`'s second parameter is now an options object (`{ cacheDir?, env?, configPath? }`) instead of a bare `cacheDir` string. Callers passing `cacheDir` positionally should migrate to `runCli(args, { cacheDir })`.

### Notes

- `--semantic` with `--engine pa11y` is rejected with a clear error in this release; pa11y manages its own browser internally and cannot share a page with the semantic pass.

## [0.4.0]

### Added

- `Issue.failureSummary` — per-node failure text describing what is wrong with a specific element, when the underlying engine provides one. Axe-core populates this directly from `NodeResult.failureSummary`; pa11y and the semantic engine leave it `undefined`.
- `ActionableIssue.help` and `FixReadyIssue.help` — surface the rule-level remediation summary (axe's `help`) alongside the short `description`. Previously this field was captured on `Issue` but never printed.
- `FixReadyIssue.failureSummary` — replaces the old `suggestedFix` field with the real per-node failure text from the engine.
- CLI `fix-ready` output now prints the rule-level `Help:` line, the multi-line `failureSummary` block, and keeps the documentation URL.

### Changed

- `FixReadyIssue.documentationUrl` is now derived directly from `Issue.helpUrl` instead of a guessed WCAG-slug URL built from the rule id.
- `transformAxeViolation` now propagates `node.failureSummary` onto every produced `Issue`.
- `formatFixReady()` and CLI `fix-ready` output now keep distinct elements separate when their selector, snippet, or failure summary differs, instead of collapsing every occurrence of a rule into a single representative row.

### Removed

- **Breaking:** `FixReadyIssue.suggestedFix`. The field previously returned either a hand-written WCAG lookup string or a generic severity-based platitude; neither was real guidance. Consumers should read `failureSummary` (concrete per-node failure), `help` (rule-level summary), and `documentationUrl` instead.
- The internal `generateSuggestedFix` helper and its hardcoded WCAG-criterion fix table.
- The internal `getDocumentationUrl` helper and its WCAG-slug URL guessing logic.

### Migration

If you consumed `FixReadyIssue.suggestedFix`, migrate as follows:

```diff
- issue.suggestedFix
+ issue.failureSummary ?? issue.help
```

`failureSummary` is the most actionable string when it is present (engine-reported, per-element). `help` is the rule-level remediation summary and is always populated.

## [0.3.0]

### Added

- Semantic audit engine with vision-LLM checks for issues that static rules cannot catch (alt-text quality, landmark usage, aria-mismatch, language correctness, page title quality, form label clarity).
- `AuditOptions.semantic` to opt into a semantic pass alongside the regular engine run; merges results into `AuditResult.issues` and attaches `semanticMeta`.

## [0.2.1]

### Changed

- Documentation: expanded the README to specify the new engine and option defaults introduced in 0.2.0.

## [0.2.0]

### Added

- Native `axe-core` runner that injects axe directly into the browser page and works with any Puppeteer or Playwright-compatible page.

### Changed

- **Breaking:** `axe` is now the default `engine`. Pass `engine: 'pa11y'` to keep the previous behaviour.
- Tightened type safety across the public API.

### Deprecated

- `AuditOptions.runners: ['axe']` — use `engine: 'axe'` instead.

## [0.1.0]

- Initial public release of `@barrieretest/core`.
