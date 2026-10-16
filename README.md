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
- cookie banner dismissal and lazy-content loading before audits

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
npx barrieretest https://example.com --html report.html
npx barrieretest https://example.com --engine pa11y
npx barrieretest https://example.com --rendering
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
No built-in check runs on the small tier by default — all of them are on
`large`, because the small models tried so far were not reliable enough for
their judgements. Custom checks opt in with `"tier": "small"`.

A tier you do not configure uses the default provider and model, so one model
for everything stays the default behaviour. Point the small tier at a cheap
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

With only the built-in checks selected, both examples still run every check on
the large tier: the small model is called once a custom check declares
`"tier": "small"`.

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
| `annotate` | `boolean` | `true` | Map issues onto the screenshot (see [Annotations](#annotations)) |
| `loadLazyContent` | `boolean` | `true` | Scroll the page once before auditing (see [Lazy content](#lazy-content)) |
| `rendering` | `RenderingOptions \| true` | — | Render the page under named conditions and run geometry checks (see [Rendering checks](#rendering-checks)) |
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
  screenshotMeta?: ScreenshotMeta
  renderingCaptures?: RenderingCapture[]
  renderingMeta?: RenderingMeta
}
```

### Annotations

With `annotate` on (the default), every issue carries where its element sits on the page screenshot, and the result carries the geometry of that capture. One browser round trip measures all selectors; a viewer can draw numbered markers from it without knowing how the screenshot was taken.

```typescript
const result = await audit('https://example.com')

for (const issue of result.issues) {
  const { state, rect, mark } = issue.annotation ?? {}
  if (state === 'resolved' && rect) {
    console.log(`#${mark} at ${rect.x},${rect.y} (${rect.width}×${rect.height})`)
  }
}
```

```typescript
issue.annotation = {
  selector: string | null   // the selector that was resolved
  state: 'resolved' | 'ambiguous' | 'hidden' | 'page' | 'unresolved'
  rect?: { x, y, width, height }  // CSS px, document space, whole pixels
  mark?: number             // 1-based marker number
  anchored?: true           // the element or an ancestor is fixed or sticky
}

result.screenshotMeta = {
  width: number             // CSS px size of the image
  height: number
  deviceScaleFactor: number // image pixels per CSS pixel
  viewport: { width, height }
  fullPage: true
  document: { width, height }     // scroll size at measurement time
  scroll: { x, y }                // scroll offset at measurement time
}
```

States:

- `resolved` — the selector matched exactly one element with a usable rect inside the capture
- `ambiguous` — it matched several; `rect` and `mark` describe the first match
- `hidden` — it matched, but the element is not visibly rendered in the capture (`display: none`, `visibility: hidden`, `opacity: 0`, clipped to a pixel, or outside the captured area). No `rect`, no `mark`
- `page` — the issue is about the page itself: the selector resolved to `html` or `body`, as page-level axe rules such as `page-has-heading-one`, `landmark-one-main`, `html-has-lang` and `document-title` do. A box around the whole screenshot would say nothing, so there is no `rect` and no `mark`
- `unresolved` — no selector, an invalid one (a semantic finding whose location is prose lands here), no match, or the measurement failed. No `rect`, no `mark`

Marks are numbered in the page's reading order, one number per element: by the element's `rect`, top edge first, then left edge, then first appearance in `issues` for a tie. Two issues on the same element share a mark, so a viewer can group them under one marker, and marker 1 is the topmost marked element rather than the first issue in the list. The order of `issues` itself is unchanged. Coordinates are CSS pixels in document space, origin at the top-left of the full-page screenshot; multiply by `deviceScaleFactor` for image pixels.

Limitations:

- `engine: 'pa11y'` produces no annotations and no `screenshotMeta`: that engine manages its own browser, so there is no page left to measure
- standalone `semanticAudit()` does not annotate; its screenshot is viewport-only
- axe targets inside an iframe or a shadow root arrive as one flattened selector that cannot match, so they are `unresolved`
- annotation never fails an audit, and the two failure modes differ: a screenshot whose size cannot be read leaves `annotation` undefined on every issue and omits `screenshotMeta`; a measurement that fails or times out leaves every issue `unresolved` and omits `screenshotMeta`. Either way one warning starting with `Annotation` is logged and the rest of the result is normal
- `detail: 'fix-ready'` localization scrolls elements into view, so when it runs `screenshotMeta.scroll` can be non-zero and the rects of `anchored` elements may not match where they appear in the capture
- baseline files and the last-run cache never contain annotations

## Rendering checks

With `rendering` set, `audit()` renders the page under a set of named **rendering conditions** — viewports, media and vision-deficiency emulations, the WCAG text-spacing override — and runs deterministic geometry checks under each. Findings are ordinary issues with ids `render:<check-id>` and an annotation in the coordinate space of their own condition's capture, and the result carries one capture per condition, so a report can show the page as a mobile, dark-mode or colour-blind user sees it.

The pass is opt-in and changes nothing without it. It runs on the page the engine pass already loaded — one browser, one navigation — and applies, measures, captures and reverts each condition in turn, so the semantic pass and the annotations still see the original rendering.

```typescript
const result = await audit('https://example.com', { rendering: true })

for (const issue of result.issues) {
  if (!issue.rendering) continue
  const { checkId, condition, captureIndex, evidence } = issue.rendering
  const capture = result.renderingCaptures?.[captureIndex]
  console.log(`${checkId} under ${condition}`, evidence, issue.annotation?.rect, capture?.meta)
}

console.log(result.renderingMeta)
// { conditionsRun, conditionsSkipped, checksRun, durationMs }
// plus restorationFailed, pageUnsafe and truncatedConditions when any happened
// truncatedConditions names every condition where a cap dropped something
// eligible: the element walk, a collected group, the axe run or a check's cap
```

```typescript
await audit('https://example.com', {
  rendering: {
    conditions: ['viewport:320', 'viewport:320+text-spacing', 'media:forced-colors'],
    checks: ['reflow-horizontal-scroll'],
    captures: false,       // default true
    conditionTimeout: 8000 // per condition, covering apply, settle, measure and capture
  },
})
```

### Conditions

`rendering: true` means the lean default set: `viewport:1280`, `viewport:320`, `viewport:360`, `media:dark`, `cvd:protanopia`, `cvd:deuteranopia` and `text-spacing`. Pass `conditions` for any other combination; two or more ids joined with `+` compose into one condition, as in `viewport:320+text-spacing`. A composite whose parts contradict each other — `viewport:320+viewport:1280`, `cvd:protanopia+cvd:deuteranopia` — is rejected, in the library and on the CLI, instead of running the last part under the composite's name.

| Id | What it applies |
|----|-----------------|
| `viewport:320` | 320×720 CSS px — the WCAG 1.4.10 equivalent of 1280 px at 400% zoom |
| `viewport:360` | 360×800, phone |
| `viewport:768` | 768×1024, tablet |
| `viewport:1280` | 1280×720, the baseline size |
| `cvd:protanopia`, `cvd:deuteranopia`, `cvd:tritanopia`, `cvd:achromatopsia`, `cvd:reduced-contrast`, `cvd:blurred-vision` | Chromium's vision-deficiency emulation |
| `media:dark` | `prefers-color-scheme: dark` |
| `media:forced-colors` | `forced-colors: active` |
| `media:more-contrast` | `prefers-contrast: more` |
| `media:reduced-motion` | `prefers-reduced-motion: reduce` |
| `text-spacing` | WCAG 1.4.12: line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em, all `!important` |

After a condition is applied the pass waits two animation frames, then for the CSS transitions the condition started (up to 1 s) and for images that are still loading (up to 1 s), so a theme that cross-fades its colours is measured and captured settled rather than mid-fade. Conditions run viewports first, then media, then vision deficiencies, then text spacing and the composites. Each capture is a full-page JPEG at quality 85 with its own `meta` geometry; the audit's own `screenshot` stays PNG.

### Checks

| Check id | Runs under | Finding when |
|----------|-----------|--------------|
| `reflow-horizontal-scroll` | viewports of 320 px and narrower | an element extends past the viewport, or the document scrolls horizontally with no single element to blame |
| `overflow-clipped-text` | every viewport and `text-spacing` | a container with `overflow: hidden` or `clip` cuts off its text — `minor` for a single line truncated with an ellipsis, `serious` otherwise |
| `overlap-text` | every viewport and `text-spacing` | two text blocks in the same stacking context are drawn on top of each other, covering more than 10% of the smaller box |
| `content-hidden-at-viewport` | `viewport:1280` compared with `viewport:360` | text that is rendered wide is gone narrow, with no control to reveal it — one finding per hidden region, naming the hidden ancestor, boxed on the ancestor's own rectangle in the wide capture, and counting the text elements it took with it. Needs both conditions in the run; both are in the default set |
| `target-size` | `viewport:360` and `viewport:1280` | axe's `target-size` (WCAG 2.5.8) reports a touch target under 24×24 CSS px without enough space around it; impact as axe reports it, and axe's `incomplete` results come through as findings with `evidence.needsReview: true`. A target the engine pass already reported is left out at either viewport, since the engine pass runs the rule itself; what this adds is a target that passes at the desktop width and fails on the phone |
| `contrast-under-mode` | `media:dark`, `media:forced-colors`, `media:more-contrast` | axe's `color-contrast` or `link-in-text-block` fails under the mode on an element the engine pass did not already report for that rule; impact as axe reports it |
| `forced-colors-loss` | `media:forced-colors` | an element whose only visual rendering is a background image or a border, or one that sets `forced-color-adjust: none`; `serious` |
| `motion-not-reduced` | `media:reduced-motion` | an animation that repeats forever or lasts longer than 5 s per iteration is still running, a `<video autoplay>` has no `controls`, or the page has a `<marquee>`; `moderate` |
| `cvd-link-distinction` | `cvd:protanopia`, `cvd:deuteranopia`, `cvd:tritanopia`, `cvd:achromatopsia` | a link inside a text block is distinguished from the surrounding text by colour alone, that colour difference meets the 3:1 of the link-in-text-block technique as the page is normally rendered, and falls below it under the simulated deficiency; `moderate` |
| `cvd-state-by-color` | `cvd:protanopia`, `cvd:deuteranopia`, `cvd:tritanopia`, `cvd:achromatopsia` | an `aria-invalid`, `aria-selected`, `aria-current` or `required` state differs from a sibling of the same kind without it by colour only, and every colour that carries it collapses under the simulated deficiency; `moderate` |

Reflow exemptions follow the WCAG text by element type and role, never by heuristics on text content: tables and their parts, `svg`, `math`, `canvas`, `video`, `iframe`, `object`, `embed`, `textarea`, image maps, `contenteditable`, and the roles `table`, `grid`, `treegrid`, `row`, `rowgroup`, `cell`, `gridcell`, `columnheader`, `rowheader`, `toolbar`, `menubar`, `application` and `textbox`, each including everything inside them. Content whose overflow an ancestor clips away is not a reflow failure either, since it cannot be scrolled to. `content-hidden-at-viewport` reports one finding per hidden region: when several text elements go with one hidden ancestor — the links of a collapsed menu, the captions of a row of thumbnails — that ancestor is named once, with its own box in the wide capture and a marker of its own — never a member's, since a member can carry a clipping or overlap finding under the same condition — and `evidence.textElements` says how many text elements there were. It exempts only content a control can actually reveal: content inside a `nav` (element or `role="navigation"`) when the page has a visible disclosure control — an element with `aria-expanded` or `aria-controls`, the hamburger that usually sits next to the `nav` rather than inside it — or when the `nav` has a visible control of its own, content that is or sits inside the `aria-controls` target of a visible control, and content inside a closed `details` whose `summary` is visible. Only navigation regions get the page-wide rule: no other region is exempt for a control elsewhere, and none is exempt for merely containing some control, so a `header` with a search button still reports the opening hours the narrow layout drops. A label hidden inside a link or button that itself stays rendered at the narrow viewport is not reported either — the control keeps its function and its accessible name, and a control without a visible label is a different criterion. Content whose text is rendered somewhere else at the narrow viewport is exempt as well, and the check reports `moderate`, never `critical`. When the narrow measurement hit its element cap (`truncatedConditions` in `renderingMeta`), the check reports nothing rather than call capped-off content missing.

`target-size`, `contrast-under-mode` and the conditions they run under need axe's own verdict, so those conditions run axe again — restricted to the rules the check asked for, re-injected only if it is not on the page any more, inside the condition's own time budget. `target-size` is also enabled in the normal engine pass now, so an audit without `rendering` reports `target-size` where it used to report nothing (see the changelog); the rendering check adds the phone viewport, where targets sit closer together, and the capture the finding is drawn on.

`contrast-under-mode` reports what the mode broke: a node counts only when the engine pass did not already report the same rule on the same element. Those nodes are dropped while the run is collected, before its 50-nodes-per-rule cap applies, so a failure the mode introduced is not pushed out of the run by failures the page already has; a rule with more nodes left than fit the cap puts its condition in `renderingMeta.truncatedConditions`, which says the condition's axe data was capped rather than that a finding is certainly missing: a page with hundreds of undecidable contrast nodes (text on photographs) reaches the cap with `incomplete` results this check ignores. Axe's `incomplete` contrast results are left out — they are the cases axe cannot measure at all (text on an image or a gradient), in the baseline as much as under the mode. Under `media:forced-colors` one more group is left out: axe reads `-webkit-text-fill-color` in preference to `color`, and Chromium forces `color` and paints with it while leaving the fill colour at the author's value, so for an element the forced palette reaches whose two values disagree axe's ratio is about a colour that is not on the screen. An element that opted out of the forced palette (`forced-color-adjust: none`, its own or inherited) keeps both of its author-set values, so axe measured what is painted and the finding stands.

`motion-not-reduced` only counts motion that is visible: an animation, autoplaying video or `<marquee>` on an element that is `display: none`, `visibility: hidden` or off the page is left out — opacity is not part of that test, because a pulsing animation is transparent in some of its own frames — and an animated element inside another animated element that is reported is left out too, since an SVG spinner animates the `svg` and the `circle` in it and that is one spinner. The nesting is read from every animation the condition collected, not only from the ones that qualify, so a 300 ms fade on an element between two that repeat forever does not split one movement into two findings; the animations that fold into the outermost element are counted there, and the cap of 25 findings applies to the movements that are left.

`forced-colors-loss` means "only visual rendering" exactly: no text anywhere in the element, the element is not and does not contain an `img`, `svg`, `canvas`, `video`, `object` or image input, a non-`none` `background-image` or a border side that paints, not `aria-hidden`, and a function or a name — interactive, inside a rendered link or button, carrying `aria-label`, `aria-labelledby` or `title`, or with an explicit role. A decorative divider with a border is not a finding; the icon inside a search button is. `forced-color-adjust: none` is reported on its own, once, for the element that sets it — `html` and `body` included, where one declaration opts the whole page out: the property is inherited, and an element that only computes to `none` because an ancestor opted out is judged by its own paint instead.

The two `cvd-*` checks read computed colours, not decoded pixels, and apply the colour-vision simulation themselves: the Machado et al. (2009) matrices at severity 1.0, applied to linearised sRGB and encoded back — which is what Chromium's own `Emulation.setEmulatedVisionDeficiency` does, since it is an SVG `feColorMatrix` filter and SVG filters interpolate in `linearRGB` by default. Verified against real captures: over six patches and all four deficiencies no channel of the browser's rendering differs from the simulation by more than 2 of 255 (JPEG capture included), and achromatopsia is luminance with the Rec. 709 coefficients. `cvd:reduced-contrast` and `cvd:blurred-vision` are not colour transformations and have no matrix, so neither check runs under them — those two conditions produce their capture and nothing else.

`cvd-link-distinction` reports only what the deficiency took away: the link's contrast against the surrounding text has to meet 3:1 as the page is normally rendered, otherwise the finding is axe's own `link-in-text-block` on the page as it is, which the engine pass already reports. The band is narrow on purpose — the matrices mostly preserve luminance, so a pair that passes 3:1 normally usually passes it simulated too, and a saturated red link cannot collapse under protanopia *and* deuteranopia, because red darkens under the one and brightens under the other. A link with any non-colour distinction from the text around it is never reported: a text decoration, a border, a box-shadow, a different font weight or style, or a background of its own. The comparison is the text that runs alongside the link — the nearest rendered text before and after it in the same block, each read with the style of the element that paints it, since a block whose text sits in spans of its own paints none of its own colour. Rendered means what a reader is shown: a run inside a `display: none`, `visibility: hidden`, fully transparent, off-canvas or screen-reader-only box is no text beside the link and no text of the link's own, and the search continues past it to the nearest run that is painted — a hidden tooltip next to a link would otherwise supply the surrounding colour, and a screen-reader-only label inside it would make the link's own text look like two styles. A link whose two sides disagree with each other, and one whose own text is in more than one style, are not judged at all: there is no single pair of colours to compare, and guessing one is how a finding gets made up.

`cvd-state-by-color` compares the stateful element with a sibling of the same kind (same element, same explicit role, same input type) without the state, looked up at the element's own level and up to three wrapper levels above it, so `<li><a aria-current="page">` next to `<li><a>` is found. It reports only when nothing but colour differs — the same visible text, the same graphics (an image by its source, an SVG by a hash of its markup, so a tick against a cross is a cue and not "a graphic either way"), the same pseudo-element content, the same child-element count, no font, decoration, outline or border-width difference, and the same box height (widths differ because labels differ, which has nothing to do with the state) — when at least one colour difference is big enough to see, and when every one of those collapses under the deficiency. Two sides whose visible text differs are left alone, by decision, because a marker word like "(selected)" and two labels that simply read differently cannot be told apart from here: that leaves the check to the pairs where the text is the same on both sides — icon tabs, carousel dots, swatches, form controls — and misses a colour-only state on a nav whose labels differ, which is the better of the two errors. A colour counts as a cue only where it paints something: a foreground that paints no visible text and no icon of its own — the `color` of an empty carousel dot — is compared on neither side, since two boxes that look identical are no finding however far apart their unused colours are, and an unused difference that survives the deficiency must not stand in for a background cue that is gone. The foreground is read from the element the visible text sits in, so a label in a `span` with a colour of its own is that colour, and an icon the element's own foreground paints (`fill: currentColor`) makes that colour painted too. A pair whose text was cut at its bound, or that holds a graphic no attribute identifies (a `canvas`), is not judged either. "Big enough to see" is a CIE76 colour distance of 10, a difference nobody has to look twice at: a contrast ratio cannot answer this question, since the red and the green of a status indicator have a ratio of 1 and are plainly different.

Both checks need the colours the page actually paints, so the measurement normalises every computed colour in the browser — Chromium serialises a computed colour in the space it was authored in, and a page built with Tailwind 4 has every colour as `oklch()` — and composites semi-transparent colours onto the background behind them, once: the background a state pair is compared by is what each side's box paints, its own `background-color` already composited over what is behind it, so a transparent background counts as the colour that shows through it. Text over a background image or gradient is left alone: there is no background colour to compare with, the same case axe reports as `incomplete`.

`media:forced-colors` and `media:reduced-motion` are not in the default condition set, so `forced-colors-loss` and `motion-not-reduced` are opt-in: pass them in `conditions`. `cvd:protanopia` and `cvd:deuteranopia` are in it, so both `cvd-*` checks run by default; the other two deficiencies are opt-in.

### From the CLI

```bash
npx barrieretest https://example.com --rendering
npx barrieretest https://example.com --rendering-conditions viewport:320,viewport:320+text-spacing
npx barrieretest https://example.com --rendering-checks reflow-horizontal-scroll,overlap-text
```

Any `--rendering-*` flag enables the pass. The text output gets a block with the findings per condition, the skipped conditions with their reason, the checks that ran and the duration. With `--json` and no `-o`, captures are left out to keep stdout usable; written to a file they are base64 strings.

### Limitations

- The pass needs a page to render on, which is the page the audit already has: one you pass in, or the one `audit()` owns for a URL target with `engine: 'axe'`. It therefore also runs on a page you pass in with `engine: 'pa11y'` — a Puppeteer page, which that engine requires anyway. Only a URL target with `engine: 'pa11y'` has no page left, since that engine manages its own browser: there the pass is skipped with a warning
- Vision-deficiency emulation is Chromium's (the Machado model Chrome DevTools uses) over a CDP session. On a non-Chromium Playwright browser there is none, so the `cvd:*` conditions land in `renderingMeta.conditionsSkipped` with a reason and the audit completes normally
- A condition the page cannot apply, or that fails or exceeds its budget, is skipped the same way: one warning starting with `Rendering`, an entry in `conditionsSkipped`, and every emulation reverted before the next condition. A condition that ran out of budget is cancelled cooperatively and the runner waits for it to stop before it reverts, so abandoned work cannot change the page under a later condition
- The viewport is restored to exactly what the page reported before the pass, device settings (`deviceScaleFactor`, `isMobile`, `hasTouch`, `isLandscape`) included, and every change carries those settings along with the new dimensions, so auditing a mobile or high-DPI page you pass in does not reload it or lose its emulation. A Puppeteer page that had no viewport override keeps having none. On Playwright only the dimensions exist to restore, which is all `setViewportSize` takes — and a Playwright context with `viewport: null` has nothing to restore at all, since `setViewportSize` can only install an override and never clear one, so the viewport conditions (and composites containing one) are skipped with a reason there while media, `cvd:*` and `text-spacing` still run
- If a revert fails twice, or abandoned work cannot be confirmed stopped, no further condition runs: the condition is named in `renderingMeta.restorationFailed`, every condition that was asked for and will not run any more is listed in `renderingMeta.conditionsSkipped` with that reason, one warning says so, and a full restore is attempted before the pass returns. Its own findings and capture stay — they were measured under the state they report — and no later condition is presented as a result from the original page
- Every restoration step is bounded from Node as well (2 s each), the final scroll to the top included, so a browser that stops answering costs the pass its remaining conditions and the page's established state, never the audit's return. A step that does not answer in time counts as failed and is not retried while it may still be in flight, because a second call to the same emulation would race it
- `renderingMeta.pageUnsafe` is set whenever the pass cannot confirm the page is back in its original state: work it gave up waiting for is still outstanding (the 2 s cancellation grace, or a restoration step that did not answer), or the last full restore failed. The pass then does not claim the page is restored, and it restores it once more when the outstanding work finally settles. Because the page may still change, `audit()` skips localization, the semantic pass and the annotation step for that run with a warning starting with `Rendering`. The engine findings, the score and the page screenshot were taken before the pass and stand
- Findings on `position: fixed` or `sticky` elements carry `annotation.anchored: true`: a full-page capture renders them once, which is not where they follow the user
- `overlap-text` cannot tell an intentional overlap (text over a hero image) from a broken one; the same stacking context, the 10% threshold and the line boxes of wrapped inline elements limit it, and the rest is the reviewer's call
- Rendering findings are ordinary issues, so they move the score like any other. The HTML report shows each of them in its own condition's capture section, with its marker on that capture

## HTML report

`renderHtmlReport(result)` turns an audit result into one self-contained HTML file: the full-page screenshot with a numbered marker on every located element, and beside it the issue list grouped by marker. It opens offline, can be attached to an email or a CI run, and can be handed to a client as it is.

```typescript
import { writeFileSync } from 'node:fs'
import { audit, renderHtmlReport } from '@barrieretest/core'

const result = await audit('https://example.com')
writeFileSync('report.html', renderHtmlReport(result))
writeFileSync('bericht.html', renderHtmlReport(result, { locale: 'de' }))
```

From the CLI:

```bash
npx barrieretest https://example.com --html report.html
npx barrieretest https://example.com --html report.html --html-locale de
```

`--html` creates parent directories like `-o` and combines with `--json` and `-o`. `--html-locale` takes `en` (default) or `de`.

The report contains:

- a header with the audited URL, the page title, the audit timestamp, the score with its interpretation, the counts per severity, and the semantic provider and model per tier when a semantic pass ran
- a findings-by-rule table under the counts: one row per rule id with its title, severity and number of occurrences, worst severity and most frequent rule first — the executive summary for a page where one rule accounts for hundreds of issues
- the screenshot with one marker per located element: a two-tone ring around the element's rect and a numbered badge, placed in percentages of `screenshotMeta`, so markers stay on their elements at any rendered size. From 1024 px the screenshot panel is sticky, at most one viewport tall and scrolls on its own, so it stays in view while the list scrolls; following a marker link scrolls it to that marker
- the issue list: one group per marker in marker order, so the groups read down the page like the screenshot, then page-level issues, then issues that could not be placed, each with its state in words. Every issue shows severity, rule id, source, description, help, help link, failure summary, the first node's HTML snippet (truncated to 500 characters), and for semantic findings confidence and suggestion. The element's selector stands once in its marker group's heading; page-level and not-located cards carry it themselves
- one capture section per rendering condition, after the main view, when the result carries `renderingCaptures`: the condition in plain words ("At 320 px width", "Protanopia (red-green colour blindness)", "Dark mode", "Textabstände nach WCAG 1.4.12"), one sentence on what it simulates, the capture with that condition's markers on it, and that condition's findings grouped beside it exactly as the main view groups the engine's. A condition with no findings shows its capture and says so in one line. Rendering findings live there and not in the main view's "not located" group — their rects belong to their own capture — while the summary line counts them and the findings-by-rule table counts every issue regardless. Marker ids are prefixed per capture, so the marks of several captures (each numbered from 1 in its own reading order) cannot collide
- a print stylesheet, so the browser's print or Save as PDF produces a legible document; each capture section starts its own page

`locale` changes the report's own labels and, with `de`, the score interpretation (a German title and description per severity level, since the library writes that text in English); issue texts stay as the engine or the model wrote them.

The renderer is a pure function: no browser, no file system, no network, and the same result always produces the same string (the timestamp shown is the result's). Options and behaviour:

- **No JavaScript.** Navigation between markers and list entries is links and `:target` only.
- **Nothing is loaded.** The screenshot is inlined as a `data:` URL and the CSS sits in a `<style>` element; the document carries `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'`. Because that policy blocks scripts, auditing a generated report with `audit()` needs a page with `page.setBypassCSP(true)` — axe-core is injected as a script.
- **Everything from the page is escaped.** Descriptions, selectors, snippets, suggestions, the document title and the URL are HTML-escaped; only `http:` and `https:` URLs become links, and only a positive integer `annotation.mark` with a usable `rect` becomes a marker (anything else is listed as not located), since marks end up in element ids and link targets.
- **Degrades.** Without `screenshotMeta` (pa11y, `annotate: false`) the screenshot renders without markers and the list ungrouped; without a screenshot only the list renders.
- On a dense page the marker badges overlap, and the inlined screenshot makes reports of long pages several megabytes. The condition captures are inlined too, so a report of an audit with `rendering: true` carries eight images instead of one. Measured on 2026-10-15 with the seven default conditions: graz.at 7.2 MB (2.6 MB without the captures), solasit.at 7.6 MB (1.6 MB), acurion.at 15.3 MB (3.6 MB). `rendering: { captures: false }` leaves them out, and the rendering findings then stay in the main view's "not located" group.
- No capture is ever enlarged past the CSS size it was taken at, so a 320 px capture is shown at 320 px rather than blown up to the column width. In print each condition starts its own page and its capture is bounded to one page tall, so the findings that follow can run onto further pages: a capture is scaled to fit that height, and a capture so tall and narrow that fitting would shrink it below 70 mm wide (a phone viewport of a long page) is shown from the top and cut off there, since a browser cannot split an image across printed pages.

## Browser pages

The default axe engine can run directly on an existing browser page.

That means:

- Puppeteer pages are supported directly
- Playwright pages are supported directly
- the current session state is preserved
- cookie banner dismissal still runs before the audit
- lazy-content loading only runs when the audit navigates: with the default axe engine a page already at the target URL keeps the scroll position you left it at, while `engine: 'pa11y'` always navigates and therefore scrolls (see [Lazy content](#lazy-content))

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

An issue is identified by its rule id, selector and element tag — and, for a rendering finding, the condition it was found under, which the baseline entry stores as `condition`. The same paragraph clipped at `viewport:320` and under `text-spacing` is therefore two findings: accepting one does not accept the other.

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
| `mistral` | `mistral-large-4` | Default suggestion in the `init` wizard; `MISTRAL_API_KEY`. `mistral-large-4` is a reasoning model; reasoning is off by default, set `reasoningEffort: "high"` and a larger `maxTokens` to enable it. A response the model cuts off mid-JSON raises an error naming `maxTokens` and the budget that was sent, with or without a JSON schema (only providers that expose nothing but the legacy `analyzeSemantic()` still surface a parse error). `mistral-small-2603` is an option for custom small-tier checks |
| `openai` | `gpt-4o` | Pass a vision-capable model |
| `anthropic` | `claude-sonnet-4-5` | Pass a vision-capable Claude model |
| `openai-compatible` | — | Any chat-completions endpoint. Needs `baseUrl` and `model`; capabilities default to text-only, so set `capabilities: { vision: true, jsonSchema: true }` when the model has more |
| `nebius` | `openai/gpt-oss-120b` | Alias for `openai-compatible` with the Nebius base URL. Its default model is declared text-only, so selecting a screenshot check fails loudly instead of sending an image to a text model |

Capabilities come from a small built-in table that is advisory — model lineups
move faster than releases, so `capabilities` in the provider config always wins.
An unknown model id on `mistral`, `openai`, or `anthropic` is assumed to do
vision and structured output; on `openai-compatible` it is assumed to do
neither.

#### Prompt caching

Mistral and OpenAI cache prompts automatically, matching on the literal prefix
of the request and billing a cached input token at a fraction of the input
price. The semantic prompt is ordered for it: guardrails, check instructions,
and the response contract come first, and the URL, hardening summary, and page
context follow under `Page under review:`. Auditing many pages with the same
check set therefore repeats a prefix of about 1,900 tokens with all built-in
checks selected.

Each tier also sends `prompt_cache_key` — `barrieretest-semantic-<tier>-<hash
of the constant prompt>` — as a routing hint that raises the hit rate. It
carries nothing page-specific, and editing any prompt text changes the hash.
The field is sent only to `mistral` and `openai`; `openai-compatible` and
`nebius` may be any server, and Anthropic caches through `cache_control`
instead, which this client does not set.

As measured in October 2026, Mistral serves no cache hit for a request that
contains an image, in any position and with or without a schema, while the
same request without one hits on the second call. Every built-in check except
`lang-attribute` sends the screenshot, so a default run on Mistral sees no
caching on the tier that carries it; text-only tiers on Mistral do benefit,
and OpenAI's cache covers image requests too.

Cache hits show up in the result: `meta.tiers.<tier>.usage` on a standalone
`semanticAudit()` result, `semanticMeta.tiers.<tier>.usage` on an `audit()`
result. Both report `inputTokens`, `outputTokens`, and `cachedInputTokens`
whenever the provider reports them, with the cached count being the part of
`inputTokens` served from the cache.

## Lazy content

With `loadLazyContent` on (the default), a page the audit navigated is scrolled through once after the cookie banner is dismissed and before anything is measured, so images with `loading="lazy"`, script-based lazy loaders and reveal-on-scroll effects below the first viewport have loaded. One viewport per step, at most 20 000 CSS px or 40 steps, a short settle per step, then up to 2 s for images that are still loading, all inside an overall budget of about 6 s. The page ends back at scroll position 0, so axe, the semantic context, the screenshot and the annotations all see the same loaded page. The step never fails an audit: an error or timeout costs one warning starting with `Lazy content` and the audit continues with whatever loaded.

The step also adds one constructed stylesheet to `document.adoptedStyleSheets` (at most once per page; unlike a `<style>` element it is not blocked by a page's `style-src` Content-Security-Policy, and it adds no element to the DOM) that forces `content-visibility: visible !important`, and leaves it there for the rest of the audit: content marked `content-visibility: auto` is loaded but paints blank outside the viewport, so it would be empty in the full-page capture, and a capture-only override would give the screenshot a different layout than the one axe and the annotations measured. Only the `auto` case is overridden. Content that is deliberately unrendered with `content-visibility: hidden` stays hidden, so a collapsed section is not audited as if it were open: `hidden="until-found"` elements are excluded by the selector, and elements whose computed `content-visibility` is `hidden` are found in one pass before the stylesheet goes in and excluded by a marker attribute `data-barrieretest-keep-hidden` (`keptHidden` in the summary counts them). An element a site switches to `content-visibility: hidden` only after that pass — in a scroll handler on the way back to the top, say — keeps no marker and is rendered by the override; marking the `auto` elements instead would put the attribute on rendered elements, where it would show up in their axe snippets. This is the step's only DOM mutation, and it happens only on pages the audit navigated.

The step runs whenever the audit itself navigates: the axe engine navigates only when the page is not already at the target URL, the pa11y engine always navigates, and a standalone `semanticAudit(url)` launches its own page. So a page you pass in that is already at the target URL is not scrolled with the axe engine — it keeps the scroll position you left it at — while `engine: 'pa11y'` navigates it and then scrolls it.

Because more content is loaded, an audit can now report issues on elements that stayed blank before, which can shift existing baselines. Set `loadLazyContent: false` to skip the step. Scroll-triggered pop-ups can end up in the capture, content that loads later than the image wait stays unloaded, and a page with scroll hijacking may not reach its end within the caps.

```typescript
import { loadLazyContent } from '@barrieretest/core'

const { steps, reachedEnd, pendingImages, renderAll, keptHidden } = await loadLazyContent(page)
```

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
