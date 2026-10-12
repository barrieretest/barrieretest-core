# Feature intent: Deterministic rendering checks

Status: intent, not started. Written 2026-10-12. Background: `barrieretest/docs/ai-feature-assessment.md`, items A.1, A.2, A.3, A.5, A.6. Depends on nothing; the annotation feature (`screenshot-coordinate-map.md`) should land first so every finding here can be drawn on its capture.

## Outcome

`audit()` can render the page under a set of named **rendering conditions** (viewports, vision-deficiency and media emulations, text-spacing override) and run deterministic geometry and style checks under each. Findings are ordinary `Issue` entries with ids `render:<check-id>`, WCAG help links, an `annotation` on the capture they were found in, and a reference to the condition. The result carries one capture per condition so a report can show the page as a low-vision, colour-blind, mobile, zoomed or dark-mode user sees it.

This is the selling feature of the next barrieretest version: visible proof, not a rule list. It is deterministic on purpose. Vision models score near chance on overflow and overlap detection (UI-Lens, CVPR 2026) and cannot simulate colour-vision deficiency (EACL 2026); the browser can do both exactly.

## Why

- WCAG 1.4.10 Reflow, 1.4.12 Text Spacing and 1.4.4 Resize Text have no axe rule at all. 2.5.8 Target Size has one that is disabled by default and never runs today. Nothing in the stack sees the page at any size other than 1280 by 720.
- Colour and contrast failures that appear only in dark mode, forced colours or for colour-blind users are invisible to a single-mode audit.
- No competitor ships reflow or layout-break detection framed as an accessibility result, and none detects colour-only information beyond axe's `link-in-text-block`. Polypane does this in a desktop browser; no scanner does it as a report.

## Invariants

1. **The default audit is unchanged.** Rendering checks run only when `rendering` is set. Score, issue list and screenshot of an audit without the option are byte-for-byte what they are today.
2. **One browser, one navigation.** All conditions are applied to the page the engine pass already loaded. No second launch, no reload. Conditions are applied, measured, captured and reverted in sequence; after the last one the page is back at the original viewport and emulation state so the semantic pass and annotation step see the original rendering.
3. **Every condition is reverted even on failure.** Apply and revert are paired in `try/finally`. A failing condition yields no findings for that condition and a warning, never a broken page for later steps.
4. **Checks are pure functions of measured geometry and computed style.** They take the data one `page.evaluate` returned and produce findings. No check calls the browser itself. This keeps them unit-testable without a browser and makes false-positive fixes local.
5. **A finding names its condition and its evidence.** Every issue carries `rendering.condition`, the capture id, and an `annotation` rect in that capture's coordinate space.
6. **Exemptions follow the WCAG text.** Reflow exempts content that requires two-dimensional layout (data tables, maps, diagrams, video, editors, toolbars). The exemption list is explicit, documented, and applied by element type and role, never by heuristics on text content.
7. **Rendering findings do not change the engine score formula.** They are added to `issues` with their impact; the scoring module treats them like any other issue. Whether the frontend weights them differently is a backend decision.
8. **Puppeteer and Playwright both work.** Capabilities the `BrowserPage` type does not expose today (viewport change, media emulation, vision-deficiency emulation) are added behind a small adapter with a Puppeteer and a Playwright implementation, with feature detection: a page that cannot do an emulation skips those conditions with a warning instead of failing.

## Scope

### Rendering conditions

A condition is a named, reversible change to how the page is rendered.

| Id | What it applies | Reverts to |
| --- | --- | --- |
| `viewport:320` | viewport 320 by 720 CSS px (the WCAG 1.4.10 equivalent of 1280 px at 400% zoom) | original viewport |
| `viewport:360` | 360 by 800, phone | original viewport |
| `viewport:768` | 768 by 1024, tablet | original viewport |
| `viewport:1280` | 1280 by 720, baseline (no change; exists so findings and captures have a uniform condition) | nothing |
| `cvd:protanopia`, `cvd:deuteranopia`, `cvd:tritanopia`, `cvd:achromatopsia`, `cvd:reduced-contrast`, `cvd:blurred-vision` | CDP `Emulation.setEmulatedVisionDeficiency` | `none` |
| `media:dark` | `prefers-color-scheme: dark` | original |
| `media:forced-colors` | `forced-colors: active` | original |
| `media:more-contrast` | `prefers-contrast: more` | original |
| `media:reduced-motion` | `prefers-reduced-motion: reduce` | original |
| `text-spacing` | injected stylesheet: `line-height: 1.5`, `letter-spacing: 0.12em`, `word-spacing: 0.16em`, paragraph `margin-bottom: 2em`, all `!important` | stylesheet removed |

Conditions compose where it makes sense: reflow at 320 px is also measured with text spacing applied (`viewport:320+text-spacing`). The default set is the eleven single conditions plus that one composite. Callers can pass a subset.

### Checks

Each check declares the conditions it runs under and the WCAG criterion it reports against.

| Check id | Conditions | Measures | Finding when |
| --- | --- | --- | --- |
| `reflow-horizontal-scroll` | `viewport:320`, `viewport:320+text-spacing` | `documentElement.scrollWidth` vs `clientWidth`; elements whose rect right edge exceeds the viewport | document scrolls horizontally, or an element (not exempt) extends past the viewport by more than 1 px |
| `overflow-clipped-text` | all viewports, `text-spacing`, `viewport:320+text-spacing` | text-bearing elements with `overflow` not `visible` where `scrollHeight > clientHeight + 1` or `scrollWidth > clientWidth + 1` | text is cut off; `text-overflow: ellipsis` on single-line elements is reported as `minor`, hard clipping as `serious` |
| `overlap-text` | all viewports, `text-spacing` | rects of visible elements that directly contain text nodes, pairwise within the same stacking context; intersection area above a threshold (proposed 10% of the smaller rect) and neither is an ancestor of the other | two text blocks overlap |
| `content-hidden-at-viewport` | `viewport:360` vs `viewport:1280` | elements with text that are rendered at 1280 but have `display: none` or zero size at 360, excluding elements inside a `nav` that has a visible disclosure control (hamburger menu exemption) | content disappears on mobile without a control to reveal it |
| `target-size` | `viewport:360`, `viewport:1280` | enable axe rule `target-size` (`rules: { "target-size": { enabled: true } }`) and run axe once more under the mobile viewport; map `incomplete` results to `needs-review` issues | axe reports the rule |
| `contrast-under-mode` | `media:dark`, `media:forced-colors`, `media:more-contrast` | axe `color-contrast` and `link-in-text-block` run under the mode; findings that are not present in the baseline run | a contrast or link-distinction failure exists only in that mode |
| `forced-colors-loss` | `media:forced-colors` | elements whose only visual rendering is a `background-image` or a border, and `forced-color-adjust: none` usage | icon buttons and indicators vanish in Windows High Contrast |
| `cvd-link-distinction` | each `cvd:*` | for links inside text blocks: pixel colour difference between link and surrounding text in the CVD capture plus presence of `text-decoration` or border | link is distinguished by colour only and the distinction collapses under that deficiency |
| `cvd-state-by-color` | each `cvd:*` | elements whose `aria-invalid`, `aria-selected`, `aria-current` or `required` states differ from siblings only by `color`/`background-color` | state is conveyed by colour alone |
| `motion-not-reduced` | `media:reduced-motion` | `document.getAnimations()` with infinite iteration or duration above 5 s, `<video autoplay>` without `controls`, `<marquee>` | animations keep running under reduced motion, or autoplay media has no controls |

Each check lives in its own file under `src/rendering/checks/` with a registry entry, mirroring `src/semantic/checks/`. Checks export the pure `evaluate(measurement) -> RenderingFinding[]` plus the `collect` descriptor that says what the single `page.evaluate` must gather for them, so the runner can union the collection needs per condition.

### Data model

```ts
export type RenderingConditionId = string; // e.g. "viewport:320", "cvd:protanopia", "viewport:320+text-spacing"

export interface RenderingCapture {
  condition: RenderingConditionId;
  screenshot: Uint8Array;        // full page, PNG
  meta: ScreenshotMeta;          // from the annotation feature
}

export interface RenderingIssueMeta {
  checkId: string;
  condition: RenderingConditionId;
  captureIndex: number;          // index into AuditResult.renderingCaptures
  /** Check-specific numbers, e.g. { scrollWidth: 412, clientWidth: 320 } or { overlapRatio: 0.34 }. */
  evidence: Record<string, number | string | boolean>;
}

export interface Issue {
  // ...existing...
  rendering?: RenderingIssueMeta;
}

export interface RenderingOptions {
  /** Conditions to apply; default: the eleven singles plus "viewport:320+text-spacing". */
  conditions?: RenderingConditionId[];
  /** Checks to run; default: all built-ins. */
  checks?: string[];
  /** Keep captures on the result. Default true. */
  captures?: boolean;
  /** Per-condition time budget in ms. Default 8000. */
  conditionTimeout?: number;
}

export interface AuditOptions {
  // ...existing...
  rendering?: RenderingOptions | true;
}

export interface AuditResult {
  // ...existing...
  renderingCaptures?: RenderingCapture[];
  renderingMeta?: {
    conditionsRun: RenderingConditionId[];
    conditionsSkipped: { condition: RenderingConditionId; reason: string }[];
    checksRun: string[];
    durationMs: number;
  };
}
```

Issue ids are `render:<check-id>`; `impact` per check: `reflow-horizontal-scroll` serious, `overlap-text` serious, `overflow-clipped-text` serious or minor as above, `content-hidden-at-viewport` moderate, `contrast-under-mode` as axe reports, `forced-colors-loss` serious, `cvd-*` moderate, `motion-not-reduced` moderate, `target-size` as axe reports.

### Browser capability adapter

`src/rendering/capabilities.ts` exposes:

```ts
interface RenderingCapabilities {
  setViewport(size: { width: number; height: number }): Promise<void>;
  emulateMedia(features: { colorScheme?: "light" | "dark"; forcedColors?: "active" | "none"; prefersContrast?: "more" | "no-preference"; reducedMotion?: "reduce" | "no-preference" }): Promise<void>;
  emulateVisionDeficiency(type: "none" | "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia" | "reducedContrast" | "blurredVision"): Promise<void>;
  supports: { viewport: boolean; media: boolean; visionDeficiency: boolean };
}
```

Puppeteer: `page.setViewport`, `page.emulateMediaFeatures`, `page.emulateVisionDeficiency`. Playwright: `page.setViewportSize`, `page.emulateMedia`, and a CDP session (`context.newCDPSession(page)`) for `Emulation.setEmulatedVisionDeficiency`; on non-Chromium Playwright browsers `visionDeficiency` is `false` and `cvd:*` conditions are skipped with a reason. Detection is by method presence, consistent with the existing `isPuppeteerPage` / `isPlaywrightPage` guards.

### Runner

`src/rendering/runner.ts`: for each condition in order, apply, wait for layout to settle (two animation frames plus a short network-idle wait capped at 1 s), run the one `page.evaluate` that gathers the union of measurements the active checks need, run axe again where a check requires it, capture, revert, evaluate the pure checks, map findings to `Issue`. Progress callbacks name the condition. Ordering: viewports first (cheapest, most valuable), then media, then CVD, then text-spacing and the composite.

The runner is called from `audit()` after the engine pass and before the semantic pass, so the semantic pass sees the original rendering and the annotation step runs last over everything.

### Surfaces

- `audit(url, { rendering: true })` and the CLI flag `--rendering` with `--rendering-conditions <ids>` and `--rendering-checks <ids>`. Text output gets a block per condition with the count of findings; `--json` includes captures as base64 only when `-o` writes to a file, otherwise `captures: false` is implied to keep stdout sane.
- README: a "Rendering checks" section listing conditions, checks, exemptions and the Playwright non-Chromium limitation.
- CHANGELOG `[Unreleased]`: Added entries; minor version bump.

## Non-goals

- Any model involvement. A later feature may send a flagged crop to the vision model for review; this one does not.
- Page zoom via CDP `setPageScaleFactor` (1.4.4 at 200%). Reflow at 320 px covers the normative reflow test; true zoom emulation is a follow-up once the viewport path is proven.
- Interaction: hover content, keyboard traversal, focus visibility. Separate intent.
- Multi-page consistency checks (3.2.6 Consistent Help).
- Frontend presentation of captures.
- Perceptual diffing between captures.

## Acceptance criteria

1. A fixture page with a 400 px wide fixed-width element, audited with `rendering: true`, yields `render:reflow-horizontal-scroll` under `viewport:320` with `evidence.scrollWidth > 320` and an annotation rect on that element; the same page audited without `rendering` yields no `render:*` issue and an identical result to today.
2. A fixture with `overflow: hidden; height: 2em` on a three-line paragraph yields `render:overflow-clipped-text` under `text-spacing` and under `viewport:320`.
3. A fixture with two absolutely positioned overlapping paragraphs yields `render:overlap-text`; the same fixture with the paragraphs adjacent does not.
4. A fixture with a 16 by 16 px icon button yields `render:target-size` under `viewport:360`; the engine pass without `rendering` still does not report `target-size`.
5. A fixture with `@media (prefers-color-scheme: dark) { a { color: #777; background: #666 } }` yields `render:contrast-under-mode` under `media:dark` only.
6. A fixture with a CSS-only infinite animation and no `prefers-reduced-motion` rule yields `render:motion-not-reduced`; adding a reduced-motion rule that sets `animation: none` removes it.
7. A `data:` table wider than 320 px does not yield a reflow finding (exemption).
8. After `audit()` returns, the page's viewport, media emulation and vision deficiency are back at their original values (assert via `window.innerWidth` and `matchMedia` in the fixture), and no injected stylesheet remains.
9. `renderingCaptures.length` equals the number of conditions run; each capture's `meta.viewport` matches its condition.
10. On a Playwright Firefox page, `cvd:*` conditions appear in `conditionsSkipped` with a reason and the audit still completes.
11. All existing tests pass unchanged.

## Validation

- Unit tests per check against hand-written measurement fixtures (pure functions, no browser).
- Unit tests for the runner with a stub page: apply/revert pairing on success and on a thrown condition, union of collection needs, skip path when a capability is missing.
- Integration tests in `src/audit-integration.test.ts` for criteria 1 to 9 against local fixture HTML.
- `npm run typecheck`, `npm run lint`, `npm test`.
- Render check: open the captures from the integration run (320 px, protanopia, dark, text-spacing) and confirm by eye that each shows the intended condition and that annotation rects sit on the flagged elements. Layout is verified by looking at the artefact.

## Known limitations to record

- Full-page capture of `position: fixed` elements renders them once; findings on them carry `annotation.anchored: true`.
- The hamburger-menu exemption for `content-hidden-at-viewport` is a heuristic by structure (a `nav` with a visible button that controls it); sites with non-standard menus can produce false positives. Report as `moderate`, never `critical`.
- `overlap-text` cannot see intentional overlaps that are visually fine (e.g. decorative text behind a hero image). The threshold and the same-stacking-context restriction limit this; residual cases are the reviewer's call.
- CVD emulation is Chromium's implementation of the Machado model; it is the same one Chrome DevTools uses, which is a defensible reference for a report.

## Open decisions for Andreas

1. Default condition set: all eleven plus the composite (about 12 captures, roughly 6 to 10 s extra per page), or a lean default (320, 360, dark, protanopia, deuteranopia, text-spacing) with the full set opt-in? Proposed: lean default in core, full set in the paid backend.
2. Should `target-size` be enabled in the normal engine pass as well, independent of `rendering`? It changes today's results, so it is a separate decision. Proposed: yes, but as its own change with its own changelog entry.
3. Capture format: PNG (lossless, large) or JPEG at quality 85 for the condition captures, PNG only for the baseline? Proposed: JPEG for conditions.
