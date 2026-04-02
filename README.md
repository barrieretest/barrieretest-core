# @barrieretest/core

Open-source core for single-page accessibility audits.

`@barrieretest/core` powers the free single-page checks behind barrieretest.at. It includes:

- axe-core audits for single pages
- optional pa11y fallback support
- scoring and severity levels
- screenshots
- baseline workflows for CI
- optional AI analysis for a single page
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
- `detail: 'fix-ready'` adds fix suggestions to formatted output
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
