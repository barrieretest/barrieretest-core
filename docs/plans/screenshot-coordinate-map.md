# Feature intent: Screenshot coordinate map (issue annotations)

Status: intent, not started. Written 2026-10-12. Background and the wider roadmap are in `barrieretest/docs/ai-feature-assessment.md`.

## Outcome

Every `Issue` that points at an element can be drawn on the page screenshot. The audit result carries, per issue, the element's rectangle in screenshot coordinates, and carries, once per result, the screenshot's geometry so a consumer can place markers without knowing how the screenshot was taken. Engine findings (axe), semantic findings and future deterministic checks all produce the same shape, so a viewer does not care who found what.

A second, optional capture produces the same screenshot with numbered markers drawn on it. That image is the input for set-of-mark prompting later and a ready-made report asset now.

## Why

- barrieretest.at wants to show findings as review points on the tested page. A live iframe of third-party sites is not viable (frame-ancestors, cross-origin), so the page is rendered from our own data: screenshot plus coordinates.
- Semantic findings currently carry a `location` string the model wrote. Resolving it against the DOM is the grounding step the literature identifies as the main precision lever. Recording whether it resolved is this feature; acting on it is a later decision.
- The marked screenshot lets the model refer to elements by number instead of inventing selectors. It is fed in addition to the unmarked screenshot, never instead of it, because markers occlude the pixels the model is asked to judge.

## Invariants

1. `Issue` stays backward compatible. New data is an optional field; every existing consumer and every existing test passes unchanged.
2. Annotation never changes the page. No `scrollIntoView`, no focus, no style mutation that survives the measurement. The overlay for the marked screenshot is added and removed inside the same step, and the semantic pass still sees the original DOM and the original screenshot.
3. Annotation never fails an audit. Any failure degrades to `state: "unresolved"` or to a missing annotation, with a warning via the existing logging path.
4. Coordinates are CSS pixels in document space, origin at the top-left of the full page, matching the full-page screenshot that `runAxeCore` already takes. `deviceScaleFactor` is recorded so consumers scale to image pixels.
5. One browser round trip for all selectors. Resolution is a single `page.evaluate` over the batch, not one call per issue.
6. The semantic pass keeps receiving the unmarked screenshot. The marked one is an additional artefact on the result.

## Scope

### A. Coordinate map (required)

Types, in `src/types.ts`:

```ts
export interface AnnotationRect {
  x: number;      // CSS px, document space
  y: number;
  width: number;
  height: number;
}

export type AnnotationState =
  | "resolved"    // selector matched one element with a non-empty rect
  | "hidden"      // matched, but display:none / visibility:hidden / zero-size
  | "ambiguous"   // selector matched more than one element; rect is the first match
  | "unresolved"; // selector null, did not match, or crosses a frame boundary

export interface IssueAnnotation {
  /** Selector that was resolved. Mirrors Issue.selector for engine issues, finding.location for semantic ones. */
  selector: string | null;
  state: AnnotationState;
  rect?: AnnotationRect;
  /** True when the element is position: fixed or sticky; its screenshot position is unreliable in a full-page capture. */
  anchored?: boolean;
  /** Stable 1-based index used as the marker label in the marked screenshot. Only set for state "resolved" | "ambiguous". */
  mark?: number;
}

export interface Issue {
  // ...existing fields...
  annotation?: IssueAnnotation;
}

export interface ScreenshotMeta {
  /** CSS px size of the captured document. */
  width: number;
  height: number;
  deviceScaleFactor: number;
  viewport: { width: number; height: number };
  fullPage: true;
}

export interface AuditResult {
  // ...existing fields...
  screenshotMeta?: ScreenshotMeta;
  /** Same capture as `screenshot`, with numbered markers drawn for every annotated issue. Only when `annotate.marked` is true. */
  markedScreenshot?: Uint8Array;
}
```

Option, in `AuditOptions`:

```ts
annotate?: boolean | { marked?: boolean };
```

Default `true` when `captureScreenshot` is true, otherwise `false`. `marked` defaults to `false`.

Behaviour:

- New module `src/annotate/` with `resolveAnnotations(page, selectors)` and `captureMarkedScreenshot(page, annotations)`. One file per concern plus tests, following the `semantic/` layout.
- Runs inside `audit()` after the engine pass and after the semantic pass, on the shared page, before the browser session is closed. For a page-object target the caller's page is used as today.
- Engine issues: `Issue.selector` is the input. axe produces one issue per node already (`flattenTarget`), so one rect per issue. A target that spans frames (axe returns nested arrays for frames) is `unresolved`; frame support is out of scope.
- Semantic issues: `finding.location` is the input. It is model-written text, so it may not be a selector at all. `document.querySelector` inside a try/catch; a thrown syntax error is `unresolved`.
- Shadow DOM: not resolved in this iteration; `unresolved`.
- `mark` numbers are assigned in issue order over resolved and ambiguous annotations, starting at 1, so the same result always yields the same numbering.
- `ScreenshotMeta` is read in the same `evaluate` (`document.documentElement.scrollWidth/scrollHeight`, `devicePixelRatio`, `innerWidth/innerHeight`).
- Time budget: the resolution evaluate is wrapped in the existing timeout pattern from `runAxe`; on timeout all annotations are `unresolved`.
- pa11y engine: no shared page, so no annotations; `screenshotMeta` absent. Document this.

### B. Marked screenshot (optional, same module)

- Implemented with a DOM overlay, not an image library: inject one absolutely positioned container at document level with one box per resolved annotation (2 px outline, high-contrast label badge with the `mark` number at the top-left corner, badge pushed inside the box when it would leave the document), take a full-page screenshot, remove the container. Zero dependencies, pixel-exact against the same layout.
- The container carries `aria-hidden="true"` and `pointer-events: none` and is removed in a `finally`, so a failing screenshot never leaves the page altered.
- Marker colour is fixed (not derived from severity) so the model is not biased by colour.
- Returned as `AuditResult.markedScreenshot`. Not used by the semantic prompt in this iteration.

### C. Surfaces

- `audit()` and `semanticAudit()` results carry the new fields. `--json` CLI output includes them. Text output is unchanged.
- README: a short "Annotations" subsection under the API section describing the fields and the pa11y limitation (public contract change, so documentation is warranted).
- CHANGELOG `[Unreleased]`: Added entries for `Issue.annotation`, `AuditResult.screenshotMeta`, `AuditResult.markedScreenshot`, `AuditOptions.annotate`.

## Non-goals

- Frontend viewer in barrieretest (separate task in the backend/frontend repo).
- Frozen DOM snapshot or iframe inspector.
- Multiple viewports; this iteration annotates the single existing capture.
- Changing the semantic prompt or dropping unresolved semantic findings. The `state` field makes that decision possible later; it is not taken here.
- Frame and shadow-DOM resolution.
- Element-level crops (the localization module already does that for a different purpose; do not merge them).

## Acceptance criteria

1. An axe issue on a visible element yields `annotation.state === "resolved"` and a rect that matches `getBoundingClientRect()` plus scroll offsets, within 1 px.
2. An issue with `selector: null` yields `state: "unresolved"` and no rect.
3. A semantic finding whose `location` is prose yields `state: "unresolved"` and the issue is still present in `issues`.
4. A `display: none` element yields `state: "hidden"`.
5. `screenshotMeta.width/height` equal the full-page screenshot's CSS size; `deviceScaleFactor` equals the page's `devicePixelRatio`.
6. With `annotate: { marked: true }`, `markedScreenshot` is a PNG of the same dimensions as `screenshot`, and the DOM contains no overlay element after `audit()` returns.
7. `annotate: false` leaves `Issue.annotation`, `screenshotMeta` and `markedScreenshot` undefined and takes no extra browser round trip.
8. All existing tests pass unchanged.

## Validation

- Unit tests with the stub-page pattern from `src/semantic/semantic.test.ts` for the resolution logic (state mapping, mark numbering, batch evaluate called once, timeout path).
- Integration test in `src/audit-integration.test.ts` against a local fixture page (data URL or temp file) with a known layout: a visible failing element, a hidden one, and a semantic stub provider returning one prose location and one valid selector. Assert criteria 1 to 7.
- `npm run typecheck`, `npm run lint`, `npm test`.
- Render check: open the marked screenshot from the integration run once and confirm markers sit on the intended elements. Layout is verified by looking at the artefact, not from source.

## Known limitations to record in the report

- `position: fixed` and `sticky` elements: Puppeteer's full-page capture extends the viewport, so these render once at their initial position; `anchored: true` tells consumers not to trust the rect's vertical position.
- Lazy-loaded or animated content can move between the engine pass and the resolution evaluate; the window is small but not zero.
- Marker badges can cover neighbouring small elements in dense layouts. The unmarked screenshot is always kept for that reason.

## Open decisions for Andreas

1. Field name: `annotation` (proposed) or `location`? `location` collides with the semantic finding field and with `localization`.
2. Should `mark` numbering skip `ambiguous` annotations? Proposed: include them, since the first match is usually the intended one; the state tells the consumer.
3. Marker label style for the marked screenshot (number only, or `A3`-style check prefix)? Proposed: number only, to keep the set-of-mark contract simple.
