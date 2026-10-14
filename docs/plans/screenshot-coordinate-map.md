# Feature contract: Screenshot coordinate map (issue annotations)

Status: contract, in implementation. Intent written 2026-10-12, decisions taken 2026-10-13 (see "Decisions" at the end). Background and the wider roadmap are in `barrieretest/docs/ai-feature-assessment.md`.

## Outcome

Every `Issue` that points at an element can be drawn on the page screenshot. The audit result carries, per issue, the element's rectangle in screenshot coordinates and a marker number shared by all issues on the same element, and carries, once per result, the screenshot's geometry so a consumer can place markers without knowing how the screenshot was taken. Engine findings (axe), semantic findings and future deterministic checks all produce the same shape, so a viewer does not care who found what.

The first consumer is the barrieretest.at viewer: screenshot plus numbered markers plus the issue list grouped by marker. A live iframe of third-party sites is not viable (frame-ancestors, cross-origin), so the page is rendered from our own data.

Recording whether a semantic finding's `location` resolved against the DOM is part of this feature; acting on it (dropping or re-prompting) is a later decision.

## Invariants

1. `Issue` stays backward compatible. New data is an optional field; every existing consumer and every existing test passes unchanged.
2. Annotation never changes the page. No `scrollIntoView`, no focus, no DOM or style mutation. Measurement is read-only.
3. Annotation never fails an audit. Any failure degrades to `state: "unresolved"` for the affected issues and one warning through the existing `console.warn` path.
4. Coordinates are CSS pixels in document space, origin at the top-left of the full page, matching the full-page screenshot `runAxeCore` already takes. `deviceScaleFactor` is recorded so consumers scale to image pixels.
5. One browser round trip for all selectors: a single `page.evaluate` over the de-duplicated batch.
6. The semantic pass is untouched: same DOM, same screenshot, same prompt.
7. Baseline files and the last-run cache never contain annotations. Annotations are attached after baseline processing, on new issue objects.

## Data model (`src/types.ts`)

```ts
export interface AnnotationRect {
  x: number; // CSS px, document space, integers, rounded outward
  y: number;
  width: number;
  height: number;
}

export type AnnotationState =
  | "resolved"    // selector matched exactly one element with a usable rect inside the capture
  | "ambiguous"   // selector matched more than one element; rect and mark belong to the first match
  | "hidden"      // matched, but the (first) element is not visibly rendered in the capture
  | "page"        // the first match is html or body: a page-level rule, nothing to box
  | "unresolved"; // selector null/empty, invalid, no match, or measurement failed/timed out

export interface IssueAnnotation {
  /** The selector that was resolved (Issue.selector at annotation time). */
  selector: string | null;
  state: AnnotationState;
  /** Only for "resolved" and "ambiguous". Clipped to the captured area. */
  rect?: AnnotationRect;
  /** Only for "resolved" and "ambiguous". 1-based; issues on the same element share one number. */
  mark?: number;
  /** Present (true) when the element or an ancestor is position: fixed or sticky. */
  anchored?: true;
}

export interface Issue {
  // ...existing fields...
  annotation?: IssueAnnotation;
}

export interface ScreenshotMeta {
  /** CSS px size of the captured image (PNG pixel size / deviceScaleFactor). */
  width: number;
  height: number;
  deviceScaleFactor: number;
  viewport: { width: number; height: number };
  fullPage: true;
  /** Document scroll size at measurement time, CSS px. Differs from width/height when the page grew after the capture or the capture was truncated. */
  document: { width: number; height: number };
  /** Scroll offset at measurement time. Non-zero means rects of anchored elements are unreliable. */
  scroll: { x: number; y: number };
}

export interface AuditResult {
  // ...existing fields...
  screenshotMeta?: ScreenshotMeta;
}
```

`AuditOptions.annotate?: boolean`, default `true`. Effective only when `captureScreenshot` is true, the engine is axe, and a screenshot was actually captured; otherwise no annotations and no `screenshotMeta`.

## Behaviour

- Module `src/annotate/` (`index.ts`, the resolver, tests), following the `semantic/` layout. Exposes `annotateIssues(page, issues, screenshot, { timeout })` returning `{ issues, screenshotMeta }` or equivalent; `audit()` is the only caller in this iteration.
- Input is always `Issue.selector`. The semantic runner already maps `finding.location` to it, so engine and semantic issues go through the same path.
- Capture size comes from the PNG itself: validate the signature, read width and height from the IHDR chunk, divide by the page's `devicePixelRatio`. No image dependency. Malformed PNG: no annotations, no meta, one warning.
- The evaluate receives the unique selectors and the capture's CSS size and returns, per selector, match count, a per-call element index for the first match (same node, same index, so issues on one element share a mark), its document-space rect, visibility and anchoring; plus `devicePixelRatio`, `innerWidth/innerHeight`, `documentElement.scrollWidth/scrollHeight`, `scrollX/scrollY`.
- `querySelectorAll` inside try/catch per selector; a syntax error is `unresolved` for that selector only. Model-written prose locations land here.
- Page-level means: the first match is `document.documentElement` or `document.body`. Rules such as `page-has-heading-one`, `landmark-one-main`, `html-has-lang` and `document-title` target `html`, some target `body`; a box around the whole capture would say nothing and would consume a mark. A `page` annotation carries no rect and no mark, and `anchored` is irrelevant and omitted. The measurement reports the flag per selector; the decision stays in the pure mapping.
- Hidden means: not rendered (`display: none` on it or an ancestor, `visibility: hidden`, `opacity: 0`; `Element.checkVisibility` with a fallback when it is missing), or width or height under 2 px (screen-reader-only clipping), or no intersection with the captured area (off-canvas, below a truncated capture). Hidden annotations carry no rect and no mark.
- Rect: `getBoundingClientRect()` plus scroll offsets, x/y floored and right/bottom ceiled, then clipped to the captured area.
- Marks are numbered over the resolved and ambiguous annotations of the final issues (after `minSeverity`/`ignore` filtering), one number per distinct element, starting at 1, in reading order of the elements' rects: top edge ascending, then left edge ascending, ties by first appearance in the issue list. Same result, same numbering; the order of `issues` itself is unchanged.
- Frame and shadow DOM targets: axe's nested targets arrive flattened into one selector that cannot match, so they end up `unresolved`. No special handling.
- Timeout: the evaluate uses the same timeout pattern as `runAxe`. On timeout or a thrown evaluate, every issue gets `state: "unresolved"`, `screenshotMeta` is omitted, one warning.
- Browser lifecycle: for a URL target with the axe engine, `audit()` already owns the Puppeteer session when `semantic` is set. It now also owns it when annotation is effective, so the page is still open after the engine pass. A page-object target uses the caller's page. With `annotate: false` and no `semantic`, the lifecycle is exactly as today.
- pa11y engine: no shared page, so no annotations and no `screenshotMeta`.
- Standalone `semanticAudit()`: not annotated in this iteration (its screenshot is viewport-only).

## Surfaces

- `audit()` results carry the new fields; `--json` CLI output includes them automatically. Text output is unchanged.
- README: a short "Annotations" subsection under the API section: the fields, the states, marks per element, the pa11y and standalone-semantic limitations.
- CHANGELOG `[Unreleased]`: Added entries for `Issue.annotation`, `AuditResult.screenshotMeta`, `AuditOptions.annotate`.

## Non-goals

- The marked screenshot (numbered overlay image). Deferred to the set-of-mark feature, which needs viewport-height tiles: vision APIs downscale to a fixed pixel budget, so one tall image arrives as a thumbnail.
- Frontend viewer and backend pass-through (separate contract in the barrieretest repo once this lands).
- Frozen DOM snapshot or iframe inspector; multiple viewports; frame and shadow-DOM resolution.
- Changing the semantic prompt or dropping unresolved semantic findings.
- Element-level crops (the localization module does that for a different purpose; do not merge them).

## Acceptance criteria

1. An axe issue on a visible element yields `state: "resolved"`, a mark, and a rect matching `getBoundingClientRect()` plus scroll offsets within 1 px.
2. An issue with `selector: null` yields `state: "unresolved"` and no rect or mark.
3. A semantic issue whose selector is prose yields `state: "unresolved"` and stays in `issues`.
4. A `display: none` element, a screen-reader-only (1 px clipped) element and an element translated fully off-page each yield `state: "hidden"`.
5. Two issues on the same element share one mark; marks are contiguous from 1 in reading order of the marked elements (top edge ascending, then left edge ascending, then first appearance in the issue list).
6. An axe issue targeting `html` (or `body`) yields `state: "page"` with no rect and no mark, and does not consume a mark number.
7. `screenshotMeta.width/height` equal the PNG's pixel size divided by `deviceScaleFactor`; `deviceScaleFactor` equals the page's `devicePixelRatio`.
8. A sticky header measured at scroll 0 has `anchored: true` and a rect that matches where it appears in the screenshot.
9. `annotate: false` leaves `annotation` and `screenshotMeta` undefined and adds no browser round trip; baseline files and the last-run cache contain no `annotation` in either mode.
10. A failing or timed-out evaluate yields all-`unresolved` annotations, no `screenshotMeta`, a warning, and an otherwise normal result.
11. All existing tests pass unchanged.

## Validation

- Unit tests with the stub-page pattern from `src/semantic/semantic.test.ts`: state mapping, mark numbering (shared and contiguous), single evaluate call, PNG header parsing (valid, malformed), timeout and throw paths, baseline isolation.
- Integration test in `src/audit-integration.test.ts` against a local fixture with a known layout (visible failing element, `display: none`, sr-only, off-canvas, sticky header, two issues on one element, a page taller than the viewport) a page-level `html` target, and a semantic stub provider returning one prose location and one valid selector. Assert criteria 1 to 10.
- `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:integration`.
- Render check: draw the returned rects and marks onto the captured screenshot (fixture and at least one real site) and confirm by eye that they sit on the intended elements. Layout is verified by looking at the artefact.

## Known limitations

- Lazy-loaded or animated content can move between the capture and the measurement, which happens after the semantic pass. `screenshotMeta.document` versus `width/height` exposes page growth; static layout is unaffected.
- Puppeteer's full-page capture renders fixed elements once, at their scroll-0 position. Nothing scrolls during an audit, so that matches the measurement; `scroll` exposes the exception.
- A selector that matched several elements marks the first; `ambiguous` tells the consumer.

## Decisions (2026-10-13)

1. Field name `annotation`.
2. One mark per element, shared by all its issues; ambiguous matches are numbered by their first match.
3. Marked screenshot deferred to the set-of-mark feature.
4. Only `audit()` annotates; standalone `semanticAudit()` does not.
5. Backend and viewer pass-through gets its own contract after core lands; it also fixes the hardcoded 1280 by 720 screenshot size in the backend.
6. Rects are whole CSS pixels, rounded outward, clipped to the capture.
7. (2026-10-14) Marks follow the page, not the issue list: numbered by the marked element's rect, top edge first, then left edge, ties by first appearance in the issue list. No row tolerance, so the order stays predictable and explainable; the issue order in the result is unchanged.
