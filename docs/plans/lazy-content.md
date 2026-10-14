# Feature contract: Load lazy content before auditing

Status: contract, in implementation. Written 2026-10-14.

## Problem

Nothing in an audit scrolls. Images with `loading="lazy"`, script-based lazy loaders and reveal-on-scroll effects (IntersectionObserver) therefore never trigger below the first viewport. Measured on solasit.at: six below-the-fold images (the barrieretest.at screenshot, two illustrations, three certification logos) report `complete: false, naturalWidth: 0` at screenshot time and render as blank boxes. The full-page screenshot, the HTML report, the annotation step and the semantic pass (which judges alt texts against that screenshot) all see the unloaded page; axe sees the DOM before lazy content arrives.

## Outcome

After navigation and cookie-banner dismissal, and before anything is measured, the page is scrolled through once, pending images get a short bounded wait, and the page returns to the top. Axe, the semantic context, the screenshot and the annotations then all see the same loaded page at scroll position 0.

## Invariants

1. **Only pages the audit navigated.** The step runs where the code itself navigated: `runAxeCore` when it called `navigateTo`/`goto` in this call, the pa11y engine (always navigates, so a caller-supplied page is scrolled there too), and the standalone `semanticAudit(url)` path. A caller-supplied page that is already at the target URL is not scrolled with the axe engine; a page handed to `runSemanticAudit` directly is never scrolled.
2. **Ends at the top.** The page finishes at `scrollX === 0 && scrollY === 0`, so the coordinate map's scroll-0 assumption holds.
3. **Bounded.** Hard caps on scroll distance, steps and total time; infinite-scroll pages stop at the cap. Defaults: step one viewport height, at most 20 000 CSS px or 40 steps, a short settle per step (two animation frames plus about 100 ms), then wait up to 2 s for images that are still loading, all within an overall budget of about 6 s enforced in the page and again by a Node-side timeout race (the `runAxe` pattern). Every in-page wait is itself bounded — a frame wait resolves on the frame or on a short timeout, whichever comes first — so suspended frames cannot stall the step past its budget, and every scroll is guarded by a still-active check. When the Node-side timeout fires, Node sets a cancel flag the step registered on `window`, so a continuation that wakes up later cannot scroll a page the audit has moved on to.
4. **Never fails an audit.** Any error or timeout is swallowed with one `console.warn` starting with "Lazy content"; the audit continues with whatever loaded, after a best-effort scroll back to the top.
5. **Instant scrolling.** `window.scrollTo({ top, left: 0, behavior: "instant" })`, because a site's `scroll-behavior: smooth` would otherwise animate every step and break the timing.
6. **One round trip for the scroll loop.** The loop and the image wait run inside a single `page.evaluate` (async function); nothing per step crosses the browser boundary.
7. **No DOM mutation.** The step only scrolls and waits; it does not rewrite `loading` attributes or styles. Its only trace is the cancel flag of invariant 3: one uniquely named `window` property, removed when the step finishes.

## Scope

- New module `src/lazy-content.ts` next to `src/cookie-banner.ts`, same style: `loadLazyContent(page, options?)` returning a small summary (`{ steps, reachedEnd, pendingImages }`) for tests and debugging; exported from `src/index.ts` alongside `dismissCookieBanner`.
- Called right after `dismissCookieBanner` in the three places of invariant 1 (cookie banners can lock body scrolling, so dismissal goes first).
- `AuditOptions.loadLazyContent?: boolean`, default `true`, threaded to the engines; `SemanticOptions` gets the same field for the standalone path. It exists because the step changes results for existing users (baselines can shift as more content is audited). No CLI flag in this iteration.
- Progress callback message "Loading lazy content" between the cookie-banner and the axe-injection steps.
- README: one paragraph in the audit section (what happens, the caps, the option); CHANGELOG `[Unreleased]`: Changed entry stating that results can include previously unloaded content.

## Non-goals

- Waiting for arbitrary network idle after scrolling, videos, iframes' own lazy content.
- Closing pop-ups that scrolling triggers (newsletter modals); recorded as a limitation.
- Re-running the cookie banner dismissal after scrolling.
- Caller-supplied pages (see invariant 1).

## Acceptance criteria

1. A local fixture with a `loading="lazy"` image placed several viewports below the fold, audited via `audit(url)`, yields a screenshot in which that image is rendered (assert in the page after the run that the image is `complete` with `naturalWidth > 0`, and confirm visually once).
2. A fixture element that switches from `opacity: 0` to `opacity: 1` when an IntersectionObserver reports it intersecting is visible after the audit.
3. After the step, `scrollY === 0`; annotations report `screenshotMeta.scroll` `{ x: 0, y: 0 }`.
4. A page taller than the cap stops at the cap and the audit completes; a page whose evaluate throws or hangs yields one warning and a normal result.
5. `loadLazyContent: false` performs no scroll round trip.
6. A caller-supplied page at its target URL is not scrolled.
7. All existing tests pass unchanged.

## Validation

- Unit tests with a stub page: single evaluate, warning on throw, Node-side timeout, option off.
- Integration tests against local fixtures (served from a temp directory via `file://`; data URLs load eagerly and do not exercise lazy loading) for criteria 1 to 3 and 6.
- `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:integration`.
- Live check: solasit.at, graz.at and news.ycombinator.com before and after, comparing the screenshot (the barrieretest.at image on solasit.at must be visible), the number of axe issues, and the audit duration. Look at the screenshots.

## Known limitations

- Scroll-triggered pop-ups can appear in the capture.
- Content that loads later than the 2 s image wait stays unloaded.
- Pages with scroll-hijacking libraries may not reach the end within the cap.

## Amendment 2026-10-14: content-visibility

Measured on acurion.at: project images and logos with `content-visibility: auto` are loaded (`complete`, `naturalWidth > 0`) and paint when scrolled into the viewport, but stay blank in the full-page capture, because Chrome skips rendering such content outside the viewport and a beyond-viewport capture does not count as on screen. Explicit `img.decode()` does not help.

Fix, part of the same step and the same option: after the scroll-through and image wait, and before returning to the top, inject one stylesheet that forces `content-visibility: visible !important` on all elements, and leave it in place for the rest of the audit on that page. It stays, rather than being added and removed around the screenshot, so axe, the capture and the annotation measurement are guaranteed to see one layout. Measured: Chrome keeps the last remembered size of a subtree it has rendered once, so after the scroll-through a placeholder `contain-intrinsic-size` only changes height for content the scroll never reached (beyond the caps); the override is needed above all for painting, and keeping it costs nothing. With the override in place, axe, the screenshot and the annotations share one fully rendered layout.

- Only content that is skipped because of `auto` is forced to render. Content that is deliberately unrendered with `content-visibility: hidden` stays hidden: the browser's own `hidden="until-found"` and author styles. Two exclusions overlap on purpose: the selector `:not([hidden])`, and a marker attribute `data-barrieretest-keep-hidden` set in one pass in the same evaluate on every element whose computed `content-visibility` is `hidden` (until-found sections included; the summary reports the count as `keptHidden`). The marker touches only elements that are not rendered, so it does not show up in snippets of rendered elements. Closed `<details>` content uses a pseudo-element and is not matched.
- The stylesheet is a constructed `CSSStyleSheet` added to `document.adoptedStyleSheets`, not a `<style>` element: a page whose Content-Security-Policy restricts `style-src` silently blocks an inserted `<style>` (measured: its `sheet` stays null), while a sheet built by script is not governed by that directive, and it adds no element to the DOM. A fixed `window` key (`__barrieretestRenderAll`) records that it is in place, so it goes in at most once per page; if the sheet cannot be built, the step reports `renderAll: false`, sets no markers and warns once. It is added at most once per page, and the step returns to the top after inserting it and waits two frames, so the layout has settled before anything measures.
- The scan for hidden elements is read-only and checks the step's expiry while it runs; all writes (markers and stylesheet) happen afterwards in one short synchronous block, and only if the step is still active.
- Known limitation, accepted: an element a site switches to `content-visibility: hidden` after the scan (for example in a scroll handler on the return to the top) is not marked and is rendered by the override. Marking the `auto` elements instead would put the marker on rendered elements, where it would appear in every axe snippet of those elements; snippet accuracy matters in every report, dynamic hiding at exactly that moment is rare.
- This is a deliberate exception to invariant 7 (no DOM mutation), limited to pages the audit navigated, like the rest of the step. Caller-supplied pages that are not navigated are not touched and keep the limitation.
- Acceptance: a fixture image with `content-visibility: auto` placed several viewports down is rendered in the screenshot returned by `audit(url)` (pixel assertion as for the lazy image), and with `loadLazyContent: false` it is not; acurion.at's project images render in a live capture (look at it).

