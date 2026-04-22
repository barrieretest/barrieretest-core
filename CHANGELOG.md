# Changelog

All notable changes to `@barrieretest/core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
