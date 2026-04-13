# @barrieretest/core

Open-source core for single-page accessibility audits.

`@barrieretest/core` powers the free single-page checks behind barrieretest.at. It includes:

- axe-core audits for single pages
- optional pa11y fallback support
- scoring and severity levels
- screenshots
- baseline workflows for CI
- optional AI analysis for a single page
- semantic audits via vision LLMs (`semanticAudit`) with an extensible check registry
- cookie banner dismissal before audits

It does not include:

- multi-page crawling or page discovery
- cross-page AI synthesis
- PDF reports
- payments
- email delivery
- invoice generation

## Install

For most use cases, install the core plus Puppeteer:

```bash
npm install @barrieretest/core puppeteer
```

Add pa11y only if you want the optional pa11y engine:

```bash
npm install @barrieretest/core puppeteer pa11y
```

### What you need

- **URL audits and the CLI** need `puppeteer`
- **Existing Playwright or Puppeteer page audits** use the page you pass in
- **`engine: 'pa11y'`** needs both `pa11y` and `puppeteer`
- **Default engine is `axe`**

## Quick start

Audit a URL with the default axe engine:

```typescript
import { audit } from '@barrieretest/core'

const result = await audit('https://example.com')
console.log(`Score: ${result.score}/100`)
console.log(`Issues: ${result.issues.length}`)
```

Audit an existing page directly:

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

Default CLI engine: `axe`.

Baseline workflow:

```bash
# Create a baseline
npx barrieretest baseline https://example.com -o baseline.json

# Audit against a baseline (only new issues fail)
npx barrieretest https://example.com -b baseline.json

# Accept the last audit run into a baseline
npx barrieretest baseline:accept baseline.json

# Re-audit and update all baselines in a directory
npx barrieretest baseline:update ./baselines
```

`results.json` from `-o` is an audit result, not a baseline file.

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

Providers: `openai`, `anthropic`, `nebius`.

## Semantic audits

`semanticAudit()` runs vision + reasoning checks that rule engines like axe and
pa11y cannot find on their own. The current built-ins cover ARIA-label/visible-text
mismatches, page title quality, alt-text quality, form-label clarity, language
attribute correctness, and landmark labelling. Adding more is one new file plus
one registry entry — the architecture is built to grow.

Standalone:

```typescript
import { semanticAudit } from '@barrieretest/core'

const result = await semanticAudit('https://example.com', {
  provider: {
    name: 'nebius',
    apiKey: process.env.NEBIUS_API_KEY!,
    model: 'Qwen/Qwen2-VL-72B-Instruct',
  },
})

console.log(result.issues)        // standard core Issue[] with `semantic` metadata
console.log(result.meta.checksRun)
```

Or — usually preferred — combined with `audit()` so a single browser launch
serves both the engine and semantic passes:

```typescript
const result = await audit('https://example.com', {
  semantic: {
    provider: { name: 'nebius', apiKey: process.env.NEBIUS_API_KEY! },
    checks: ['aria-mismatch', 'page-title'], // optional: defaults to all built-ins
  },
})

// result.issues contains both engine findings and semantic findings as
// standard core Issue[] entries (semantic ones use the id "semantic:<check-id>").
// result.semanticMeta exposes pass-level metadata.
```

Supported `audit({ semantic })` combinations:

| Target | `engine` | Behavior |
|---|---|---|
| URL string | `'axe'` (default) | `audit()` owns the browser; engine and semantic share one page |
| Existing browser page | `'axe'` | Both passes use the page you passed in |
| URL string | `'pa11y'` | **Semantic is skipped with a warning.** pa11y manages its own browser internally; running semantic would require a second launch in this release |

### How semantic findings are processed

Semantic findings are first-class `Issue` values and participate in the same
post-engine pipeline as engine findings:

- **`minSeverity` and `ignore` apply to them.** Semantic issues are merged with
  engine issues *before* filtering, so `minSeverity: 'serious'` will drop a
  `notice`-severity semantic finding the same way it drops a minor engine one.
- **Baselines include them.** Baseline diffing runs on the merged + filtered
  list, so semantic issues appear in `newIssues`, `knownIssues`, and
  `fixedIssues` like any other issue.
- **They are not currently localized.** Source-file localization
  (`detail: 'fix-ready'`) runs on engine issues only in this release.
- **They are not currently passed through per-issue AI enhancement.** The
  `audit({ ai })` per-issue enhancer also runs on engine issues only.
- **Hallucinated or unrequested check IDs are dropped.** If the model returns
  a finding with a `checkType` that wasn't part of the resolved check set
  for this run, the runner discards it and warns.
- **Semantic failure never fails the whole audit.** If the semantic pass
  throws (timeout, malformed JSON, provider error), `audit()` warns and
  returns the engine results without `semanticMeta`.

### Screenshot behavior

Screenshot capture differs slightly between entrypoints in this release:

- `audit({ semantic })` reuses the screenshot the engine path captured (full
  page by default), so the semantic pass and the rest of `audit()` see the
  same image.
- Standalone `semanticAudit()` may capture its own screenshot above the fold
  if a selected check needs one.

The two paths can therefore feed differently sized images to the model.

### Built-in checks

| ID | What it looks for |
|---|---|
| `aria-mismatch` | aria-label / aria-labelledby that contradicts visible text |
| `page-title` | Whether the `<title>` is descriptive and meaningful |
| `alt-text-quality` | Whether `alt` text actually describes the image |
| `form-label-clarity` | Whether form labels are clear and unambiguous |
| `lang-attribute` | Whether `<html lang>` matches the actual page language |
| `landmarks` | Whether landmark regions are present and properly labelled |

### Adding a custom check

```typescript
import { semanticAudit, type SemanticCheck } from '@barrieretest/core'

const skipLinkCheck: SemanticCheck = {
  id: 'skip-link-quality',
  title: 'Skip-link Quality',
  description: 'Skip links should be visible on focus and lead to the main content.',
  promptSection: '**Skip Link Quality**: Check that skip links are present, visible on focus, and target main content',
  needsScreenshot: true,
  needsContext: ['head', 'body'],
}

const result = await semanticAudit('https://example.com', {
  provider: { name: 'nebius', apiKey: process.env.NEBIUS_API_KEY! },
  customChecks: [skipLinkCheck],
  checks: ['skip-link-quality'],
})
```

Custom checks can also override built-ins by reusing the same `id` — useful for
tweaking prompt wording without forking the package.

### Provider support

| Provider | `analyzeSemantic` |
|---|---|
| `nebius` | Full support (production-tested) |
| `openai` | Implemented; pass a vision-capable model (e.g. `gpt-4o`) |
| `anthropic` | Implemented; pass a vision-capable Claude model |

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
