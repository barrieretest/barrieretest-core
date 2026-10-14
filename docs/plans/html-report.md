# Feature contract: Static HTML report

Status: contract, in implementation. Written 2026-10-13. Builds on the screenshot coordinate map (`screenshot-coordinate-map.md`, commit `f8ae10b`). The rendering checks (`rendering-checks.md`) will later add one capture section per rendering condition.

## Outcome

`renderHtmlReport(result)` turns an `AuditResult` into one self-contained HTML file: the full-page screenshot with a numbered marker on every located element, and beside it the issue list grouped by marker, then page-level issues, then issues that could not be placed. The CLI writes it with `--html <file>`. The file opens offline, can be attached to an email or a CI run, and can be handed to a client without the hosted product.

It is also the reference consumer of the coordinate contract: if the report can place every marker from `Issue.annotation` and `screenshotMeta` alone, any viewer can.

## Why

- CLI users get JSON or a terminal summary today; neither shows where a problem is.
- Solasit and Acurion client audits need a shareable artefact that shows findings on the page.
- The barrieretest.at viewer needs a proven positioning approach to copy; this is it, without a framework.

## Invariants

1. **Zero dependencies, no network.** The output is one HTML string with inline CSS and the screenshot as a `data:` URL. No external fonts, scripts, stylesheets or images. The document carries a Content-Security-Policy meta tag of `default-src 'none'; img-src data:; style-src 'unsafe-inline'`, so nothing in it can load or execute anything even if escaping were wrong.
2. **No JavaScript.** Navigation between markers and list entries uses links and `:target` styling only.
3. **Everything from the page is untrusted.** Every string that originates in the audited page or a model (description, help, failure summary, selector, HTML snippet, suggestion, document title, URL) is HTML-escaped for text and attribute context. Links are rendered only for `http:` and `https:` URLs; anything else is shown as text.
4. **The report is accessible.** It meets WCAG 2.2 AA on its own terms, and auditing the generated report with this library's `audit()` yields zero axe violations. The issue list is the primary content; the screenshot is supplementary with a text alternative. Every marker is a focusable link with an accessible name, and every group links back to its marker. Reflows without horizontal scrolling at 320 CSS px.
5. **Pure function.** `renderHtmlReport` takes the result and options and returns a string. No browser, no file system; the CLI does the writing. Deterministic for the same input (the timestamp shown is the result's, not the render time).
6. **Degrades without annotations.** A result without `screenshotMeta` (pa11y, `annotate: false`) renders the screenshot without markers if one exists and the list ungrouped; a result without a screenshot renders the list only. Never throws on a valid `AuditResult`.

## Scope

### API

```ts
export interface HtmlReportOptions {
  /** Language of the report's own labels; issue texts stay as the engine or model wrote them. Default "en". */
  locale?: "en" | "de";
}

export function renderHtmlReport(result: AuditResult, options?: HtmlReportOptions): string;
```

Module `src/html-report/` (rendering, labels per locale, escaping helpers, tests), exported from `src/index.ts`. No change to `AuditResult`.

### Content

1. **Header:** report title with the audited URL, document title, audit timestamp, score with its `scoreInterpretation` title and description, issue counts per severity, and when present the semantic provider and model per tier from `semanticMeta`.
2. **Findings by rule:** a compact table under the counts, one row per rule id: rule title (the issue's `help`), severity label, number of occurrences, sorted by severity then count. It is the executive summary for dense pages, where one rule can account for hundreds of issues. A real `<table>` with caption and header cells.
3. **Screenshot section:** the screenshot at full container width; markers are absolutely positioned links inside a relatively positioned wrapper, placed in percentages of `screenshotMeta.width/height` (`left = rect.x / width * 100%`, likewise for top, width, height), so they stay on their elements at any rendered size. Each marker shows a 2 px outline around the rect and a number badge at its top-left corner, pushed inside the wrapper when it would leave it. One fixed high-contrast marker colour, not tied to severity. The image's text alternative names the page and the number of marked elements.
4. **Issue list**, in this order:
   - one group per mark, in mark order: heading "Marker N" plus the element's selector, then each issue on that element;
   - "Page-level issues" (`state: "page"`);
   - "Not located on the screenshot": `hidden`, `unresolved`, and issues without an annotation, each with its state shown in words. `ambiguous` issues have a mark and belong to their marker group, with the ambiguity stated there.
   Each issue shows severity, rule id, source (engine or AI check), description, help, help link, failure summary, selector, the first node's HTML snippet (escaped, truncated to 500 characters with a visible ellipsis), and for semantic issues confidence and suggestion.
5. **Summary line** above the list: how many issues are on the screenshot, page-level, and not located.
6. **Print:** the browser's print or Save as PDF produces a legible document: light background, markers visible on the image, no content that depends on hover or focus.

### CLI

- `--html <file>` on `audit`: renders the report from the result and writes it; parent directories are created like `-o`. Combinable with `--json` and `-o`. Uses `--html-locale <en|de>` (default `en`), validated like other enum flags (missing value is an error, as for the semantic flags).
- Text output gains one line naming the written file.

### Visual design

A business tool for accessibility work: calm, precise, trustworthy, closer to an audit report from a consultancy than to a developer console. The aesthetic is restraint; quality shows in spacing, type and alignment, not in decoration.

- **Type:** system font stack only (`system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`), monospace stack for selectors and snippets. Body 16 px with line height 1.5; a clear, small scale (for example 13 / 14 / 16 / 20 / 28 px); headings in semibold, not bold-everything. Tabular figures for scores and counts.
- **Colour:** neutral ink and slate greys on white, one accent from the barrieretest palette (navy: `#10336a` for headings and accents, `#1a55b1` for links, `#e8eef7` for subtle fills). No gradients, no emoji, no decorative icons, no heavy shadows; 1 px hairline borders and at most one soft shadow level.
- **Severity:** always a text label (Critical, Serious, Moderate, Minor; German equivalents), with a restrained tinted pill as the secondary cue; colour is never the only signal and every label meets 4.5:1.
- **Score:** the header leads with the score as a large tabular number out of 100 next to its interpretation title and one-sentence description, then a compact row of counts per severity. It reads like the executive summary of a report.
- **Markers:** must stay visible on any page colour, so a two-tone ring: a 2 px dark navy outline with a 2 px white outer ring around the element's rect; the badge is a small navy circle with a white number and a white ring. One fixed style, not tied to severity. Focus and `:target` states make the ring heavier rather than changing colour only.
- **Layout:** max content width around 1440 px with generous gutters; header band, then the screenshot and the list side by side from 1024 px (screenshot roughly 60 %, list 40 %), stacked below. Side by side, the screenshot panel is sticky and at most one viewport tall with its own scroll, so it stays in view while the list scrolls; following a marker link scrolls the panel to the marker (native fragment navigation, no script). The scrolling panel is a labelled, keyboard-focusable region. In print it is a normal block.
- **Within a marker group** the element selector appears once, in the group heading; issue cards in the group do not repeat it. Issues are quiet cards separated by hairlines; selectors and snippets sit in a light grey monospace block that wraps instead of scrolling the page.
- **Footer:** one discreet line, "Generated with barrieretest" plus the audit timestamp.
- **Print:** same hierarchy in black and grey; marker groups avoid page breaks inside a card.

The worker must render the report and look at it (desktop, phone width, print preview) before claiming the design is done; the orchestrator does the same.

### Docs

- README: "HTML report" section (API, CLI flag, what the report contains, the no-JavaScript and CSP choices).
- CHANGELOG `[Unreleased]`: Added entries for `renderHtmlReport` and `--html`.

## Non-goals

- Interactive viewer, framework component, filtering or sorting UI.
- Multiple captures (comes with the rendering checks; keep the capture section a function of screenshot, meta and issues so it can repeat).
- Translating issue texts (axe locales are a separate decision).
- Multi-page or site-wide reports; baseline diff views.
- PDF generation in core (the print stylesheet covers Save as PDF).
- Dark mode.

## Acceptance criteria

1. For a fixture audit with annotations, every marker's rendered box (measured in a browser after loading the report) matches its `annotation.rect` scaled to the rendered image within 1 px, at a container width of 1280 and of 640 CSS px.
2. Issues sharing a mark appear in one group; page-level and not-located issues appear in their sections; counts in the summary line match.
3. Every marker links to its group and every group links back to its marker; following a link moves focus to the target.
4. A result whose description, selector, HTML snippet, document title and suggestion contain `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>` and whose help URL is `javascript:alert(1)` renders all of them as inert text: no element other than the report's own exists in the parsed DOM, and no link has a non-http(s) href.
5. Auditing the generated report with `audit()` yields zero axe violations (the report's own CSP blocks axe injection, so the test page uses `setBypassCSP(true)`; this is a test-harness concession, not a weakening of invariant 1); at 320 CSS px the document has no horizontal scroll.
6. A result without `screenshotMeta` and one without `screenshot` both render without throwing and without markers.
7. `--html report.html` writes the file; `--html` without a value fails with a message naming the flag; `--html-locale fr` fails naming the allowed values.
8. With `locale: "de"`, all report labels are German with proper umlauts, including the score interpretation title and description (German copies per `severityLevel` in the report's labels); issue texts are unchanged.
9. All existing tests pass unchanged.

## Validation

- Unit tests for escaping (text and attribute context, the payloads above), URL filtering, grouping and ordering, locale labels, the degraded inputs, and determinism.
- Integration test: real `audit()` on a local fixture, render the report, load it in Puppeteer, assert criteria 1, 3 and 5 (marker geometry, link targets, zero axe violations, no horizontal scroll at 320 px).
- CLI test for criterion 7 following the existing CLI test pattern.
- `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:integration`.
- Render check by eye: open the report for the fixture and for two real sites (one dense, one with a fixed or sticky element) at desktop and phone width, and in print preview. Layout is verified by looking at the artefact.

## Known limitations

- On dense pages marker badges overlap; the list stays usable because it is the primary content.
- The full-page screenshot as a `data:` URL makes reports several megabytes for long pages.
- The report shows the page as captured; content that moved between capture and measurement is marked where it was measured (see the coordinate-map limitations).

## Decisions (2026-10-13)

1. Report labels in English (default) and German; issue texts stay in the engine's or model's language.
2. No JavaScript; links and `:target` cover navigation, and the CSP forbids scripts.
3. Screenshot and list side by side from 1024 px, stacked below.
4. CLI flag `--html <file>` with `--html-locale <en|de>`.
