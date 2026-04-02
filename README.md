# @barrieretest/core

Accessibility audit engine. Runs [pa11y](https://pa11y.org/) audits, scores results, and optionally enhances them with AI.

## Install

```bash
npm install @barrieretest/core
```

## Quick Start

```typescript
import { audit } from '@barrieretest/core'

const result = await audit('https://example.com')
console.log(`Score: ${result.score}/100`)
console.log(`Issues: ${result.issues.length}`)
```

## CLI

```bash
npx barrieretest https://example.com
```

Audit a page and print results:

```bash
npx barrieretest https://example.com --json
npx barrieretest https://example.com -d minimal
npx barrieretest https://example.com -s serious
npx barrieretest https://example.com -o results.json
```

Baseline management:

```bash
# Create baseline
npx barrieretest baseline https://example.com -o baseline.json

# Audit against baseline (only new issues fail)
npx barrieretest https://example.com -b baseline.json

# Accept current issues into baseline
npx barrieretest baseline:accept baseline.json

# Re-audit and update all baselines in a directory
npx barrieretest baseline:update ./baselines
```

## API

### `audit(target, options?)`

Run an accessibility audit.

```typescript
import { audit } from '@barrieretest/core'

// Audit a URL (launches Puppeteer)
const result = await audit('https://example.com')

// With options
const result = await audit('https://example.com', {
  minSeverity: 'serious',
  ignore: ['WCAG2AA.Principle1.Guideline1_4.1_4_3'],
  detail: 'fix-ready',
  baseline: './baseline.json',
})

// With an existing Puppeteer page
const result = await audit(page)
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `runners` | `('htmlcs' \| 'axe')[]` | `['htmlcs']` | Pa11y runners |
| `viewport` | `{ width, height }` | `1280×720` | Browser viewport |
| `headless` | `boolean` | `true` | Headless browser |
| `timeout` | `number` | `60000` | Timeout in ms |
| `detail` | `'minimal' \| 'actionable' \| 'fix-ready'` | `'actionable'` | Output detail level |
| `minSeverity` | `'critical' \| 'serious' \| 'moderate' \| 'minor'` | — | Filter threshold |
| `ignore` | `string[]` | — | Rule IDs to skip |
| `baseline` | `string` | — | Baseline file path |
| `updateBaseline` | `boolean` | — | Update baseline with results |
| `captureScreenshot` | `boolean` | `true` | Capture page screenshot |
| `onProgress` | `function` | — | Progress callback |

**Returns `AuditResult`:**

```typescript
{
  url: string
  documentTitle: string
  score: number              // 0-100
  severityLevel: string      // 'excellent' | 'good' | 'needs-improvement' | 'critical' | 'severe'
  scoreInterpretation: { ... }
  issues: Issue[]
  screenshot?: Uint8Array
  timestamp: string
  baseline?: BaselineInfo
}
```

### Issues

Each issue:

```typescript
{
  id: string           // e.g. 'WCAG2AA.Principle1.Guideline1_4.1_4_3'
  impact: string       // 'critical' | 'serious' | 'moderate' | 'minor'
  description: string
  help: string
  helpUrl?: string
  selector: string | null
  nodes: { html: string }[]
}
```

### Scoring

Score is 0–100, derived from issue count and severity:
- **95–100** Excellent
- **70–94** Good
- **40–69** Needs improvement
- **15–39** Critical
- **0–14** Severe

Deductions: critical −26, serious −10, moderate −3. Diminishing returns after 2 occurrences of the same rule.

### Baseline

Track known issues so only regressions fail your CI:

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

Update baseline via code or env var:

```typescript
await audit(url, { baseline: './baseline.json', updateBaseline: true })
```

```bash
BARRIERETEST_UPDATE_BASELINE=true npx barrieretest https://example.com -b baseline.json
```

### Report Formatting

Format issues by detail level:

```typescript
import { formatIssues } from '@barrieretest/core'

formatIssues(result.issues, 'minimal')    // [{ id, impact, count }]
formatIssues(result.issues, 'actionable') // + description, selector, wcagCriterion
formatIssues(result.issues, 'fix-ready')  // + suggestedFix, codeSnippet, documentationUrl
```

### AI Enhancement

Optional AI-powered analysis:

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

### Cookie Banner Dismissal

Audits automatically dismiss cookie consent banners before testing. Uses 40+ known CMP selectors and text-based matching. Can also be used standalone:

```typescript
import { dismissCookieBanner } from '@barrieretest/core'

await dismissCookieBanner(puppeteerPage)
```

## Playwright Integration

See [@barrieretest/playwright](../playwright/) for Playwright test integration:

```typescript
import { test, expect } from '@barrieretest/playwright'

test('homepage is accessible', async ({ page }) => {
  await page.goto('/')
  await expect(page).toBeAccessible()
})
```

## Requirements

- Node.js 18+
- Puppeteer (installed as dependency)

## License

MIT
