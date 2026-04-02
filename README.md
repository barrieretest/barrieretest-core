# @barrieretest/core

Open-source core for single-page accessibility audits.

`@barrieretest/core` powers the free single-page checks behind barrieretest.at. It includes:

- pa11y-based single-page audits
- scoring and severity levels
- screenshots
- baseline workflows for CI
- optional AI analysis for a single page

It does not include:

- multi-page crawling or page discovery
- cross-page AI synthesis
- PDF reports
- payments
- email delivery
- invoice generation

## Install

```bash
npm install @barrieretest/core
```

## Quick start

```typescript
import { audit } from '@barrieretest/core'

const result = await audit('https://example.com')
console.log(`Score: ${result.score}/100`)
console.log(`Issues: ${result.issues.length}`)
```

## CLI

Run a single-page audit:

```bash
npx barrieretest https://example.com
npx barrieretest https://example.com --json
npx barrieretest https://example.com -d minimal
npx barrieretest https://example.com -s serious
npx barrieretest https://example.com -o results.json
```

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
  minSeverity: 'serious',
  ignore: ['WCAG2AA.Principle1.Guideline1_4.1_4_3'],
  detail: 'fix-ready',
  baseline: './baseline.json',
})

const fromPage = await audit(page)
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `runners` | `('htmlcs' \| 'axe')[]` | `['htmlcs']` | Pa11y runners |
| `viewport` | `{ width, height }` | `1280×720` | Browser viewport |
| `headless` | `boolean` | `true` | Headless browser |
| `timeout` | `number` | `60000` | Timeout in ms |
| `detail` | `'minimal' \| 'actionable' \| 'fix-ready'` | `'actionable'` | Formatting detail level |
| `minSeverity` | `'critical' \| 'serious' \| 'moderate' \| 'minor'` | — | Minimum severity to include |
| `ignore` | `string[]` | — | Rule IDs to skip |
| `baseline` | `string` | — | Baseline file path |
| `updateBaseline` | `boolean` | — | Update baseline with results |
| `captureScreenshot` | `boolean` | `true` | Capture a page screenshot |
| `onProgress` | `function` | — | Progress callback |

`detail: 'fix-ready'` adds fix suggestions to formatted output. Source localization only runs when auditing an existing Puppeteer page.

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

### Baselines

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

### Issue formatting helpers

```typescript
import { formatIssues } from '@barrieretest/core'

formatIssues(result.issues, 'minimal')
formatIssues(result.issues, 'actionable')
formatIssues(result.issues, 'fix-ready')
```

### AI enhancement

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

### Cookie banner dismissal

```typescript
import { dismissCookieBanner } from '@barrieretest/core'

await dismissCookieBanner(puppeteerPage)
```

## Playwright integration

See `@barrieretest/playwright` for Playwright test integration.

## Requirements

- Node.js 18+
- Puppeteer

## License

MIT
