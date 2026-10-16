# Feature intent: Deterministic rendering checks

Status: contract, in implementation (phase 1 of 3). Written 2026-10-12; decisions and implementation amendments 2026-10-14 at the end, binding where they differ from the text above. Background: `barrieretest/docs/ai-feature-assessment.md`, items A.1, A.2, A.3, A.5, A.6. Depends on nothing; the annotation feature (`screenshot-coordinate-map.md`) should land first so every finding here can be drawn on its capture.

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
4. (Amended 2026-10-15, after decision 2.) A row of 16 by 16 px icon buttons that is spaced out at 1280 px and cramped at 360 px yields `render:target-size` under `viewport:360` and nothing in the engine pass; the same row cramped at every width is reported by the engine pass as `target-size` and not repeated by the rendering check at any viewport.
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

## Decisions (2026-10-14)

1. **Default condition set is lean:** `viewport:1280`, `viewport:320`, `viewport:360`, `media:dark`, `cvd:protanopia`, `cvd:deuteranopia`, `text-spacing`. `rendering: true` means this set; every other condition is available through `rendering.conditions`. The composite `viewport:320+text-spacing` is not in the default set. (`viewport:1280` added 2026-10-15 so `content-hidden-at-viewport`, which compares it with `viewport:360`, runs by default.)
2. **`target-size` is enabled in the normal engine pass too.** The axe run in `runAxeCore` enables the rule (`rules: { "target-size": { enabled: true } }`) for every audit, not only under rendering conditions. This changes scores of existing audits; it gets its own CHANGELOG `Changed` entry stating that. The rendering check `render:target-size` still runs under `viewport:360`.
3. **Condition captures are JPEG** at quality 85; the baseline screenshot stays PNG. Core gains a JPEG size reader (SOF0/SOF2 marker parsing, no dependency) next to the PNG one, so capture geometry comes from the image for both formats.
4. **The HTML report shows the captures** in phase 3: one capture section per condition with its markers, reusing the existing screenshot panel and marker rendering, and the condition named on each rendering finding.

## Implementation amendments (2026-10-14)

- **Phases.** Each phase is one worker round, reviewed by the orchestrator and a fresh Codex review, and fixed before the next starts.
  1. Foundation: data model, capability adapter (Puppeteer and Playwright, all condition kinds incl. media and vision deficiency), condition registry with every condition from the table, runner (apply, settle, one measurement evaluate, capture, revert, in `try/finally`), JPEG size reader, annotations for rendering findings in their capture's space, `audit()` integration, CLI flags, and the geometry checks `reflow-horizontal-scroll`, `overflow-clipped-text`, `overlap-text`, `content-hidden-at-viewport`. Media and CVD conditions already produce captures in this phase; their checks come later.
  2. `target-size` (rendering check plus normal pass, decision 2), `contrast-under-mode`, `forced-colors-loss`, `motion-not-reduced`.
  3. `cvd-link-distinction`, `cvd-state-by-color`, and the HTML report capture sections (decision 4).
- **CVD checks use computed colours, not decoded pixels.** The measurement returns computed foreground and background colours; the pure check applies the Machado et al. (2009) simulation matrices at severity 1.0 for the deficiency (the model Chromium's emulation implements) and compares the simulated colours. This keeps the checks pure functions of measured data and avoids decoding image pixels. The capture remains the visual evidence.
- **Annotations for rendering findings** are computed from the rects the measurement returns, in that condition's capture space, with the same rounding, clipping and per-element mark numbering (reading order) as `src/annotate/`. The shared pieces move to or are exported from `src/annotate/` so both use one implementation; `src/rendering/` depends on `src/annotate/`, never the reverse. Marks are numbered per capture.
- **Where the runner sits.** After the engine pass (and therefore after lazy-content loading and the `content-visibility` override, which stay in place), before the semantic pass. It runs on the page the engine pass used, including a caller-supplied page, because `rendering` is opt-in and every condition is reverted. After the last condition the viewport, media emulation, vision deficiency and injected styles are back to their original state and the page is scrolled to the top, so the semantic pass and the annotation step see the original rendering.
- **Original state.** The adapter reads the original viewport before the first condition (Puppeteer `page.viewport()`, Playwright `page.viewportSize()`), and reverts emulations to "no override", not to a guessed value.
- **No change without `rendering`** (invariant 1) except decision 2 and, decided by Andreas on 2026-10-15, the scoring change: `calculateScore` deducts once per rule and severity, base x (1 + log2(count)), so one root cause on many elements (axe's `region` without `<main>`) no longer sinks the score. Both have their own CHANGELOG entries.


## Fix round 2026-10-16: what the CVD checks compare

Three Codex reviews of phase 3 found comparisons that judged colours or cues nobody is shown. The fixes, binding over the notes above where they differ:

1. **A state pair is compared by the backgrounds its two boxes paint**, directly — each one is the element's own `background-color` already composited over what is behind it, so a transparent background counts as the colour that shows through it and nothing is composited twice. Before, an explicitly grey tab beside a green one was a finding and a transparent tab over the same grey was not. Foreground and border colours are each composited over that background exactly once.
2. **A state pair needs the same visible text and the same graphics.** The cue comparison reads the text a reader can see (text inside a hidden or screen-reader-only child does not count) and a signature of each graphic — the tag plus the `src` of an image or a hash of an SVG's markup — so a visible "(selected)" and a tick against a cross are cues, where "a graphic on both sides" was not. Two labels that merely read differently cannot be told apart from a marker here, so a pair whose visible text differs is left alone — Andreas decided on 2026-10-16 to keep the check this narrow: it covers icon tabs, carousel dots, swatches and form controls, and misses a colour-only state on a nav whose labels differ. A pair whose text was cut at its bound, or that holds a `canvas`, is not judged at all. Preferring a missed finding to a false one is the rule for this check.
3. **A link is compared with the text runs beside it**, not with its block's computed style: the nearest rendered text before and after it in the same block, each read with the style of the element that paints it, and the decoration, border and box-shadow of any box between that text and the block. A `<p>` whose own text sits in a `span` paints none of its own colour. A link whose two sides disagree with each other, or whose own text is in more than one style, is not judged.
4. **Print clips the capture on an outer box**, with the frame the markers are positioned in left unbounded inside it. Capping the frame itself resolved every marker's percentage against the shortened box, which moved a marker halfway down a long capture halfway down the visible crop.
5. **The report's clean-result sentence is about the whole audit.** A report whose only findings are under rendering conditions says so instead; the capture sections below carry them.
6. **Only text a reader is shown is a text run.** The link comparison filters its runs by what is painted — the run's own box rendered, not `display: none`, not `visibility: hidden`, not fully transparent, not off-canvas, and not clipped away by a screen-reader-only wrapper — and skips past a hidden run to the nearest painted one. A `display: none` tooltip beside a link supplied the surrounding colour before, and a screen-reader-only label inside a link made its own text look like two styles, so a false finding and a missed one came from the same unfiltered walk. The text the finding quotes is the visible text too.
7. **A foreground colour is a cue only where it paints something.** Each side of a state pair reports the colour its foreground actually paints — the colour of the element the first visible text sits in, or the element's own colour when an icon paints with it (`fill: currentColor`, which Chromium resolves to the colour) — and nothing at all for a box that paints neither, which the check then does not compare. Two empty carousel dots with the same background and different unused `color` values were a finding before, and a background-only difference that collapses was suppressed by an unused `color` difference that survives.

## Amendment 2026-10-15: content-hidden-at-viewport precision

Measured on graz.at with `viewport:1280` in the default set: 10 findings, score 94 to 51, almost all noise: four main-menu links behind a hamburger whose button sits outside the `nav` and has no `aria-controls`; two icon-link labels (`d-none d-lg-block`) whose links stay rendered with their icon; one carousel overline and three thumbnail captions. The check is tuned, before phase 1 is committed:

1. **One finding per hidden region.** When several text elements disappear because a common ancestor is hidden at the narrow viewport, report the topmost hidden ancestor once (rect and selector of that ancestor in the wide capture), with the number of text elements it contains in `evidence`.
2. **The common hamburger counts as a disclosure control.** Content inside a `nav` or `role=navigation` is revealable when, at the narrow viewport, the page has a visible control with `aria-expanded` (or `aria-controls`) anywhere, not only inside that `nav`. The `aria-controls` and closed-`details` rules stay. No header-wide exemption for arbitrary controls.
3. **Hidden labels of controls that stay are not lost content.** Text hidden inside a link or button that itself remains rendered at the narrow viewport is not reported (the control keeps its function and accessible name; a missing visible label is a different criterion).
4. **Acceptance for the tuning:** on graz.at the main menu, the icon labels and duplicate per-element findings are gone; anything left is checked by eye and listed in the report with a judgement. solasit.at and acurion.at are measured too. Fixture tests cover each of the three rules, positive and negative.


## Implementation notes, phase 3 (2026-10-15)

Nothing in the contract is overridden; these are the decisions phase 3 had to make and what they were measured against.

1. **Chromium applies the Machado matrices in linear light.** Its vision-deficiency emulation is an SVG `feColorMatrix` filter, and SVG filters interpolate in `linearRGB` unless the filter says otherwise — Chromium's does not. The simulation therefore linearises, multiplies, clamps and encodes back. Verified empirically against captures of a colour-patch fixture: pure red under protanopia is `rgb(109, 95, 0)` in the browser and in the implementation, and over seven patches and four deficiencies no channel differed by more than 1 of 255 against a PNG capture, or 2 against the JPEG condition capture. Applying the matrix to the encoded channels instead would have given `rgb(39, 29, 0)` for that patch — a different colour, and a different verdict. Achromatopsia is luminance with the Rec. 709 coefficients, as Chromium's own matrix has it.
2. **Colours are normalised in the page, parsed in the check.** Chromium serialises a computed colour in the space it was authored in, so a Tailwind 4 page returns `oklch(…)` from `getComputedStyle`. The measurement paints each computed value on a 1 by 1 canvas and reads the pixel back, so the browser resolves the syntax and the pure check parses `rgba()` only. A value the canvas cannot parse comes back fully transparent, which the check reads as nothing painted and reports nothing for.
3. **`cvd-link-distinction` fires in a narrow band**, and that is a property of the model rather than of the implementation: the matrices mostly preserve luminance, so a link that meets 3:1 against its surrounding text normally usually meets it simulated too. A saturated red link cannot collapse under protanopia *and* deuteranopia — red darkens under the one and brightens under the other — which a brute-force search over the readable sRGB grid confirmed (0 pairs). The fixture therefore uses a green link in navy text for the both-deficiency case and a brick-red link in near-black text for protanopia.
4. **The state threshold is a CIE76 distance of 10** (`MIN_STATE_DELTA_E`), not a contrast ratio: two colours of the same luminance and different hue have a ratio of 1 and are plainly different to see, and a ratio cannot say whether a deficiency changed anything. Ten is the line between the cases measured on 2026-10-15: a red error border against a neutral one is 82 normally and 55 under deuteranopia (visible, no finding); a green tick colour against a red cross colour is 118 and 5 (gone, a finding); a selected green against a grey is 52 and 3 under achromatopsia (gone); a `#fdeaea` invalid tint against white is 9 either way, too faint to be the cue in the first place. A pair is reported only when *every* colour that is far enough apart to see collapses: one surviving cue is enough.
5. **The state comparison needs a sibling, found up to three wrapper levels up.** `<li><a aria-current="page">` next to `<li><a>` is the common navigation markup, and the `a` has no sibling of its own. "Same kind" is the same element, the same explicit role and the same input type. Box size is compared by height only: two siblings carry different labels, so their widths differ for reasons that have nothing to do with the state, while padding, scale and border cues all show in the height.
6. **Report size.** Each condition capture is inlined as a `data:` URL like the page screenshot, so a report of an audit with `rendering: true` carries eight images. Measured on 2026-10-15 with the seven default conditions: graz.at 7.2 MB against 2.6 MB without the captures, solasit.at 7.6 against 1.6, acurion.at 15.3 against 3.6 — the captures themselves are 3.4, 4.5 and 8.8 MB of JPEG, which base64 inflates by a third. `rendering: { captures: false }` leaves them out, and the findings then stay in the main view's "not located" group.
7. **Print: each condition starts a page.** A browser cannot split an image across printed pages, so a capture that does not fit was moved to a page of its own, left its heading behind on an empty one and still ran off the bottom — 32 pages for graz.at. The capture is now bounded to one printed page: the existing width formula keeps a capture within that height wherever its aspect ratio allows, and one that would have to go below the 70 mm floor (a phone viewport of a long page) is shown from the top and cut off. 19 pages for the same report. A condition's findings can run onto further pages; only the capture is bounded.

Final review fixes (2026-10-16, orchestrator): a state's foreground counts as painted only through SVG shapes that actually paint with it (the root and groups only pass an inherited `fill` down; definitions, clip paths and masks paint nothing); a link's border and box-shadow cues are read from boxes below the shared text block, since the block's own frame belongs to both sides alike. Both covered by a browser regression test.
