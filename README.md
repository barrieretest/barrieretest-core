# @barrieretest/core

Open-source core for single-page accessibility audits.

`@barrieretest/core` powers the free single-page checks behind [barrieretest.at](https://barrieretest.at). It includes:

- axe-core audits for single pages
- optional pa11y support
- scoring and severity levels
- screenshots
- baseline workflows for CI
- optional AI analysis for individual issues
- semantic audits via vision LLMs
- cookie banner dismissal before audits

## Try it

You can try testing your (already deployed) site on [barrieretest.at](https://barrieretest.at) first.

## Install

For most use cases, install the core plus Puppeteer:

```bash
npm install @barrieretest/core puppeteer
```

Add pa11y only if you want the optional pa11y engine:

```bash
npm install @barrieretest/core puppeteer pa11y
```

## Quick start

Audit a URL with the axe engine (default):

```typescript
import { audit } from '@barrieretest/core'

const result = await audit('https://example.com')
console.log(`Score: ${result.score}/100`)
console.log(`Issues: ${result.issues.length}`)
```

Audit an existing Puppeteer or Playwright page directly:

```typescript
const result = await audit(page)
```

Use pa11y explicitly:

```typescript
const result = await audit('https://example.com', {
  engine: 'pa11y',
})
```

## CLI

Run a single-page audit:

```bash
npx barrieretest https://example.com
npx barrieretest https://example.com --json
npx barrieretest https://example.com -d minimal
npx barrieretest https://example.com -s serious
npx barrieretest https://example.com -o results.json
npx barrieretest https://example.com --engine pa11y
```

### Semantic AI from the CLI

Semantic AI adds vision and reasoning checks for accessibility issues rule engines do not reliably detect. It can review visible text, labels, page language, image descriptions, form-label clarity, and landmark structure, which is useful for catching meaning and context problems beyond DOM rules.

The easiest way to configure semantic audits is the interactive wizard:

```bash
npx barrieretest init
```

It walks through provider selection, checks for the provider API-key env var,
lets you pick which checks to run, and writes non-secret defaults to
`~/.barrieretest/config.json`.

After that, run:

```bash
npx barrieretest https://example.com --semantic
```

For manual setup, pass `--semantic` or any `--semantic-*` flag and provide a
provider API key via env. The CLI resolves the provider from:

1. `--semantic-provider`
2. `semantic.provider` in user config
3. Env inference — exactly one of `MISTRAL_API_KEY`, `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `NEBIUS_API_KEY`

```bash
export MISTRAL_API_KEY=...
npx barrieretest https://example.com --semantic
```

Override provider or model per run:

```bash
npx barrieretest https://example.com \
  --semantic \
  --semantic-provider openai \
  --semantic-model gpt-4o
```

Restrict which checks run:

```bash
npx barrieretest https://example.com \
  --semantic \
  --semantic-checks aria-mismatch,page-title
```

Flags:

| Flag | Description |
|------|-------------|
| `--semantic` | Enable semantic audit |
| `--semantic-provider <name>` | `mistral` \| `openai` \| `anthropic` \| `openai-compatible` \| `nebius` |
| `--semantic-model <id>` | Provider-specific model identifier |
| `--semantic-base-url <url>` | API endpoint. Required for `openai-compatible`, an override for the rest |
| `--semantic-small-provider <name>` | Provider for the small tier |
| `--semantic-small-model <id>` | Model for the small tier |
| `--semantic-large-provider <name>` | Provider for the large tier |
| `--semantic-large-model <id>` | Model for the large tier |
| `--semantic-checks <ids>` | Comma-separated check IDs |
| `--semantic-timeout <ms>` | AI call timeout |

Any `--semantic-*` flag implicitly enables semantic mode. Config defaults alone
never auto-enable it.

Env vars:

| Variable | Used for |
|---|---|
| `MISTRAL_API_KEY` | `--semantic-provider mistral` |
| `OPENAI_API_KEY` | `--semantic-provider openai` |
| `ANTHROPIC_API_KEY` | `--semantic-provider anthropic` |
| `OPENAI_COMPATIBLE_API_KEY` | `--semantic-provider openai-compatible` |
| `OPENAI_COMPATIBLE_BASE_URL` | Base URL fallback for `openai-compatible` |
| `NEBIUS_API_KEY` | `--semantic-provider nebius` |

API keys are read from the environment only — never from a config file or a flag.

#### Model tiers

Every check declares a model tier. `small` is for cheap per-element judgements,
`large` for the holistic page review and the default for checks that do not say.
`alt-text-quality` is the only built-in on the small tier; custom checks opt in
with `"tier": "small"`.

A tier you do not configure uses the default provider and model, so one model
for everything stays the default behaviour. Put the cheap checks on a cheap
model per run:

```bash
npx barrieretest https://example.com \
  --semantic \
  --semantic-provider mistral \
  --semantic-model mistral-large-4 \
  --semantic-small-model mistral-small-2603
```

Or in config, including two different providers:

```json
{
  "semantic": {
    "provider": "mistral",
    "model": "mistral-large-4",
    "tiers": {
      "small": { "provider": "openai", "model": "gpt-4o-mini" }
    }
  }
}
```

A tier entry without `provider` means "same provider as the default", and then
inherits the default model and base URL too. A tier that switches provider
starts from that provider's own default model, since a model id is not portable
between providers.

### Built-in semantic checks

Built-in semantic checks are predefined prompts that ask a vision-capable LLM to inspect a single page for meaning and context issues. They run as part of semantic audits and return normal `Issue` entries with ids like `semantic:<check-id>`.

| ID | What it looks for |
|---|---|
| `aria-mismatch` | aria-label / aria-labelledby that contradicts visible text |
| `page-title` | Whether the `<title>` is descriptive and meaningful |
| `alt-text-quality` | Whether `alt` text actually describes the image |
| `form-label-clarity` | Whether form labels are clear and unambiguous |
| `lang-attribute` | Whether `<html lang>` matches the actual page language |
| `landmarks` | Whether landmark regions are present and properly labelled |

### CLI user config

Use `config` to configure without the interactive wizard.

The CLI reads non-secret defaults from `~/.barrieretest/config.json`. API keys
live only in env vars — `config set` rejects anything else.

```bash
# Set defaults you don't want to type every time
npx barrieretest config set semantic.provider mistral
npx barrieretest config set semantic.model mistral-large-4
npx barrieretest config set semantic.tiers.small.model mistral-small-2603
npx barrieretest config set semantic.checks aria-mismatch,page-title
npx barrieretest config set semantic.timeout 120000

# Read back
npx barrieretest config get
npx barrieretest config get semantic.provider

# Clear a default
npx barrieretest config unset semantic.model

# Where does it live
npx barrieretest config path
```

Supported keys: `semantic.provider`, `semantic.model`, `semantic.baseUrl`,
`semantic.reasoningEffort`, `semantic.checks`, `semantic.timeout`, and per tier
`semantic.tiers.small.provider`, `semantic.tiers.small.model`,
`semantic.tiers.small.baseUrl`, `semantic.tiers.small.reasoningEffort` plus the
four `semantic.tiers.large.*` equivalents.

`reasoningEffort` is passed to the provider verbatim, because the accepted
values differ per vendor (Mistral takes `"none"` and `"high"`). A model the
built-in table marks as a reasoning model is sent `"none"` unless you set it:
the semantic pass is a single structured extraction, where reasoning adds cost
and latency and can consume the whole token budget before the answer starts.

CLI flags always override config values.

### Custom semantic checks (CLI)

Every project has its own accessibility language and edge cases. Add custom semantic checks from the CLI and run them alongside the built-ins.

The fastest path is the wizard:

```bash
npx barrieretest check add
```

Example custom check:

```json
{
  "id": "button-verbs",
  "title": "Button Action Verbs",
  "description": "Buttons should use clear action verbs.",
  "prompt": "For each visible button or link-as-button, verify the label is a clear action verb. Flag labels like 'Click here', 'OK' when ambiguous, or generic text.",
  "needsScreenshot": false,
  "context": ["body"]
}
```

The wizard asks for an id, title, description, prompt, whether the check needs
a screenshot, and which page-context sections the AI should receive. It writes
the check to your **global** config (`~/.barrieretest/config.json`) or a
**project-local** file (`.barrieretest.json` at the repo root).

Subcommands:

```bash
npx barrieretest check list                    # show built-in + user checks
npx barrieretest check remove <id>             # remove from global or project
npx barrieretest check test <id> --url <url>   # dry-run one check
```

#### Config merge rules

The CLI loads both files and merges them. Precedence for each field:

- **Scalars** (`provider`, `model`, `baseUrl`, `reasoningEffort`, `timeout`, `checks`): project wins when set, otherwise global.
- **`tiers`**: merged leaf by leaf, so a project can retarget one tier's model without restating its provider. A tier inherits `reasoningEffort` from the merged defaults only while it stays on the default provider, like `model`.
- **`customChecks`**: concatenated. If the same id appears in both, the project entry overrides the global one and audit runs print a warning to stderr.
- **Built-in ids** cannot be overridden by a user check. The CLI rejects colliding ids at `check add` and at load time.

Project-local files are meant to be committed with the repo so teams share one check set.

#### The JSON shape

If you prefer hand-editing, add this shape to `.barrieretest.json` or
`~/.barrieretest/config.json`:

```json
{
  "semantic": {
    "customChecks": [
      {
        "id": "button-verbs",
        "title": "Button Action Verbs",
        "description": "Buttons should use clear action verbs.",
        "prompt": "For each visible button or link-as-button, verify the label is a clear action verb. Flag labels like 'Click here', 'OK' when ambiguous, or generic text.",
        "needsScreenshot": false,
        "context": ["body"]
      }
    ]
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `id` | yes | — | 2-40 lowercase alphanumerics or hyphens. Cannot match a built-in. |
| `title` | yes | — | Short title shown in reports and prompts. |
| `description` | yes | — | One-line description. |
| `prompt` | yes | — | Free-form instruction for the AI. Be specific about what to flag. |
| `needsScreenshot` | no | `false` | Set `true` if the check needs visual reasoning. |
| `tier` | no | `"large"` | `"small"` for a cheap per-element check, `"large"` for the holistic page review. |
| `context` | no | `["body"]` | Page-context sections to include. One or more of: `head`, `body`, `aria`, `forms`, `images`, `landmarks`. |
| `helpUrl` | no | — | Optional WCAG or internal help link. |

> **Recommendation:** Keep semantic audits under about 20 active checks.
>
> All active checks are sent in one prompt per model tier. There is no limit in code, so you can add as many checks as you need. Larger check sets make the prompt harder for the model to follow, which can reduce finding quality.

## API

### `audit(target, options?)`

Run a single-page accessibility audit.

```typescript
import { audit } from '@barrieretest/core'

const result = await audit('https://example.com')

const filtered = await audit('https://example.com', {
  engine: 'axe',
  minSeverity: 'serious',
  ignore: ['color-contrast'],
  detail: 'fix-ready',
  baseline: './baseline.json',
})

const fromPage = await audit(page)

const pa11yResult = await audit('https://example.com', {
  engine: 'pa11y',
})
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `engine` | `'axe' \| 'pa11y'` | `'axe'` | Audit engine |
| `runners` | `('htmlcs' \| 'axe')[]` | `['htmlcs']` | Pa11y runners, only used with `engine: 'pa11y'` |
| `viewport` | `{ width, height }` | `1280×720` | Browser viewport when launching a browser |
| `headless` | `boolean` | `true` | Headless browser when launching a browser |
| `timeout` | `number` | `60000` | Timeout in ms |
| `detail` | `'minimal' \| 'actionable' \| 'fix-ready'` | `'actionable'` | Formatting detail level |
| `minSeverity` | `'critical' \| 'serious' \| 'moderate' \| 'minor'` | — | Minimum severity to include |
| `ignore` | `string[]` | — | Rule IDs to skip |
| `baseline` | `string` | — | Baseline file path |
| `updateBaseline` | `boolean` | — | Update baseline with results |
| `captureScreenshot` | `boolean` | `true` | Capture a page screenshot |
| `onProgress` | `function` | — | Progress callback |

Notes:

- `engine: 'axe'` is the default and recommended engine
- `engine: 'pa11y'` requires `pa11y` and `puppeteer`
- URL audits with the axe engine require `puppeteer`
- `detail: 'fix-ready'` adds rule help text, per-element failure summaries, code snippets, and documentation links to formatted output
- Source localization only runs when auditing an existing Puppeteer page

#### Returns

```typescript
{
  url: string
  documentTitle: string
  score: number
  severityLevel: string
  scoreInterpretation: { ... }
  issues: Issue[]
  screenshot?: Uint8Array
  timestamp: string
  baseline?: BaselineInfo
}
```

## Browser pages

The default axe engine can run directly on an existing browser page.

That means:

- Puppeteer pages are supported directly
- Playwright pages are supported directly
- the current session state is preserved
- cookie banner dismissal still runs before the audit

If you use `engine: 'pa11y'`, only Puppeteer pages are supported.

## Baselines

Use baselines to treat existing issues as known and fail only on regressions.

```typescript
const result = await audit('https://example.com', {
  baseline: './accessibility-baseline.json',
})

if (result.baseline) {
  console.log(`New: ${result.baseline.newIssues.length}`)
  console.log(`Known: ${result.baseline.knownIssues.length}`)
  console.log(`Fixed: ${result.baseline.fixedIssues.length}`)
}
```

Update a baseline in code:

```typescript
await audit(url, { baseline: './baseline.json', updateBaseline: true })
```

Or with an environment variable:

```bash
BARRIERETEST_UPDATE_BASELINE=true npx barrieretest https://example.com -b baseline.json
```

Baseline CLI workflow:

```bash
# Create a baseline
npx barrieretest baseline https://example.com -o baseline.json

# Audit against a baseline; only new issues fail
npx barrieretest https://example.com -b baseline.json

# Accept the last audit run into a baseline
npx barrieretest baseline:accept baseline.json

# Re-audit and update all baselines in a directory
npx barrieretest baseline:update ./baselines
```

`results.json` from `-o` is an audit result, not a baseline file.

## Issue formatting helpers

```typescript
import { formatIssues } from '@barrieretest/core'

formatIssues(result.issues, 'minimal')
formatIssues(result.issues, 'actionable')
formatIssues(result.issues, 'fix-ready')
```

`formatFixReady()` preserves distinct element-level entries so per-element failure summaries and code snippets stay accurate.

## AI enhancement

```typescript
const result = await audit('https://example.com', {
  ai: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o',
    maxIssues: 10,
  },
})
```

Providers: `mistral`, `openai`, `anthropic`, `openai-compatible`, `nebius`.

## Semantic audits API

`semanticAudit()` runs the same semantic check system exposed by the CLI. Use it standalone when you only need semantic findings, or use `audit({ semantic })` to combine engine and semantic findings in one result.

Standalone:

```typescript
import { semanticAudit } from '@barrieretest/core'

const result = await semanticAudit('https://example.com', {
  provider: {
    name: 'mistral',
    apiKey: process.env.MISTRAL_API_KEY!,
    model: 'mistral-large-4',
  },
})

console.log(result.issues)        // standard core Issue[] with `semantic` metadata
console.log(result.meta.checksRun)
```

Combined with `audit()` so a single browser launch serves both the engine and semantic passes:

```typescript
const result = await audit('https://example.com', {
  semantic: {
    provider: { name: 'mistral', apiKey: process.env.MISTRAL_API_KEY! },
    checks: ['aria-mismatch', 'page-title'], // optional: defaults to all built-ins
  },
})

// result.issues contains both engine findings and semantic findings as
// standard core Issue[] entries. Semantic ones use the id "semantic:<check-id>".
// result.semanticMeta exposes pass-level metadata.
```

`provider` is the default for every tier. `tiers` overrides it per tier; an
override is a complete config and inherits nothing, so each entry names its own
provider, key, and model:

```typescript
const result = await semanticAudit('https://example.com', {
  provider: {
    name: 'mistral',
    apiKey: process.env.MISTRAL_API_KEY!,
    model: 'mistral-large-4',
  },
  tiers: {
    small: {
      name: 'mistral',
      apiKey: process.env.MISTRAL_API_KEY!,
      model: 'mistral-small-2603',
    },
  },
})

// result.meta.tiers.small / .large report the provider, model, and check ids
// each tier actually ran.
```

Supported `audit({ semantic })` combinations:

| Target | `engine` | Behavior |
|---|---|---|
| URL string | `'axe'` (default) | `audit()` owns the browser; engine and semantic share one page |
| Existing browser page | `'axe'` | Both passes use the page you passed in |
| URL string | `'pa11y'` | Semantic is skipped with a warning because pa11y manages its own browser internally |

### How semantic findings are processed

Semantic findings are first-class `Issue` values and participate in the same post-engine pipeline as engine findings:

- **`minSeverity` and `ignore` apply to them.** Semantic issues are merged with engine issues before filtering.
- **Baselines include them.** Baseline diffing runs on the merged and filtered list, so semantic issues appear in `newIssues`, `knownIssues`, and `fixedIssues` like any other issue.
- **They are not currently localized.** Source-file localization (`detail: 'fix-ready'`) runs on engine issues only.
- **They are not currently passed through per-issue AI enhancement.** The `audit({ ai })` per-issue enhancer also runs on engine issues only.
- **Hallucinated or unrequested check IDs are dropped.** If the model returns a finding with a `checkType` that was not part of the resolved check set, the runner discards it and warns.
- **Semantic failure never fails the whole audit.** If the semantic pass throws, `audit()` warns and returns the engine results without `semanticMeta`.

### Screenshot behavior

Screenshot capture differs slightly between entrypoints:

- `audit({ semantic })` reuses the screenshot the engine path captured, full page by default.
- Standalone `semanticAudit()` may capture its own above-the-fold screenshot if a selected check needs one.

### Adding a custom check programmatically

> CLI users: prefer [`barrieretest check add`](#custom-semantic-checks-cli). The programmatic API below is for embedders of `@barrieretest/core`.

```typescript
import { semanticAudit, type SemanticCheck } from '@barrieretest/core'

const skipLinkCheck: SemanticCheck = {
  id: 'skip-link-quality',
  title: 'Skip-link Quality',
  description: 'Skip links should be visible on focus and lead to the main content.',
  promptSection: '**Skip Link Quality**: Check that skip links are present, visible on focus, and target main content',
  needsScreenshot: true,
  needsContext: ['head', 'body'],
  tier: 'large', // 'small' for a cheap per-element check; 'large' is the default
}

const result = await semanticAudit('https://example.com', {
  provider: { name: 'mistral', apiKey: process.env.MISTRAL_API_KEY! },
  customChecks: [skipLinkCheck],
  checks: ['skip-link-quality'],
})
```

Custom checks can override built-ins by reusing the same `id`. This applies only to the programmatic API; the CLI rejects colliding ids to keep global and project behavior predictable.

### Provider support

| Provider | Suggested model | Notes |
|---|---|---|
| `mistral` | `mistral-large-4` (small tier: `mistral-small-2603`) | Default suggestion in the `init` wizard; `MISTRAL_API_KEY`. `mistral-large-4` is a reasoning model; reasoning is off by default, set `reasoningEffort: "high"` and a larger `maxTokens` to enable it. With a JSON schema, a response the model cuts off mid-JSON raises an error naming `maxTokens` and the budget that was sent; on the text path it still surfaces as a parse error |
| `openai` | `gpt-4o` | Pass a vision-capable model |
| `anthropic` | `claude-sonnet-4-5` | Pass a vision-capable Claude model |
| `openai-compatible` | — | Any chat-completions endpoint. Needs `baseUrl` and `model`; capabilities default to text-only, so set `capabilities: { vision: true, jsonSchema: true }` when the model has more |
| `nebius` | `openai/gpt-oss-120b` | Alias for `openai-compatible` with the Nebius base URL. Its default model is declared text-only, so selecting a screenshot check fails loudly instead of sending an image to a text model |

Capabilities come from a small built-in table that is advisory — model lineups
move faster than releases, so `capabilities` in the provider config always wins.
An unknown model id on `mistral`, `openai`, or `anthropic` is assumed to do
vision and structured output; on `openai-compatible` it is assumed to do
neither.

## Cookie banner dismissal

Cookie banner dismissal runs before audits for both:

- URL audits
- existing browser page audits

You can also call it directly:

```typescript
import { dismissCookieBanner } from '@barrieretest/core'

await dismissCookieBanner(page)
```

## Playwright integration

See `@barrieretest/playwright` for Playwright test integration on live Playwright pages.

## Requirements

- Node.js 18+
- `puppeteer` for URL audits and CLI usage
- `pa11y` only if you want the optional pa11y engine

## License

MIT
