/**
 * The report's entire stylesheet, inlined into the document. No external
 * fonts, no images beyond the screenshot's `data:` URL, no JavaScript — see
 * the Content-Security-Policy the renderer writes.
 */

export const REPORT_CSS = `
*, *::before, *::after { box-sizing: border-box; }

:root {
  --ink: #15202b;
  --muted: #5b6b7c;
  --line: #dde3ea;
  --line-soft: #eceff3;
  --navy: #10336a;
  --link: #1a55b1;
  --fill: #e8eef7;
  --paper: #ffffff;
  --shell: #f7f9fc;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--shell);
  color: var(--ink);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.5;
}

h1, h2, h3, h4 { font-weight: 600; margin: 0; line-height: 1.25; }
h1 { font-size: 28px; letter-spacing: -0.01em; }
h2 { font-size: 20px; }
h3 { font-size: 16px; }
h4 { font-size: 16px; }
p { margin: 0; }
ul, ol { margin: 0; padding: 0; list-style: none; }

a { color: var(--link); }
a:focus-visible,
[tabindex]:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; border-radius: 2px; }

.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 16px 48px;
}
@media (min-width: 640px) { .page { padding: 0 32px 64px; } }

/* ---------- masthead ---------- */

.masthead {
  background: var(--paper);
  border: 1px solid var(--line);
  border-top: 3px solid var(--navy);
  padding: 28px 24px;
  margin: 24px 0 24px;
}
@media (min-width: 640px) { .masthead { padding: 36px 40px; margin-top: 32px; } }

.masthead__brand {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}
.masthead h1 { color: var(--navy); }

.facts {
  margin: 20px 0 0;
  display: grid;
  gap: 12px 40px;
  font-size: 14px;
}
@media (min-width: 768px) { .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.facts > div { min-width: 0; }
.facts dt { color: var(--muted); font-size: 13px; }
.facts dd { margin: 0; }

.score {
  margin-top: 28px;
  padding: 20px 24px;
  background: var(--fill);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 28px;
}
.score__figure { display: flex; align-items: baseline; gap: 6px; }
.score__label {
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--navy);
  align-self: center;
  margin-right: 4px;
}
.score__value {
  font-size: 48px;
  font-weight: 600;
  line-height: 1;
  color: var(--navy);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.score__scale { font-size: 16px; color: var(--muted); }
.score__text { flex: 1 1 320px; min-width: 0; }
.score__title { font-weight: 600; color: var(--navy); }
.score__desc { font-size: 14px; color: var(--muted); }

.counts {
  margin-top: 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px 32px;
}
.counts li { display: flex; align-items: baseline; gap: 8px; }
.counts__value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 1.4em;
  text-align: right;
}
.counts__zero { color: var(--muted); font-weight: 500; }

/*
 * Every string the report shows from the audited page or a model can be one
 * unbroken token (a minified selector, a long URL, a data URI), so prose
 * breaks inside a word when the word alone would widen the page — but only
 * then, which is why this is break-word and not anywhere. Reflow at 320 px
 * depends on it; the monospace blocks below break anywhere, since a selector
 * has no word boundaries to wait for.
 */
.facts dd,
.score__title,
.score__desc,
.summary,
.rules th,
.rules td,
.issue__headline,
.issue__desc,
.fields dd {
  overflow-wrap: break-word;
}

/* ---------- severity pills ---------- */

.pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 2px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid transparent;
}
.pill--critical { background: #fbeaea; color: #8a1c1c; border-color: #f0cfcf; }
.pill--serious  { background: #fbf0e2; color: #80480a; border-color: #eed9bd; }
.pill--moderate { background: #f7f3dc; color: #6a5400; border-color: #e4dcb4; }
.pill--minor    { background: #eef1f5; color: #44525f; border-color: #dbe1e8; }

/* ---------- findings by rule ---------- */

/*
 * Fixed layout with proportional columns: the rule title gets the room, and
 * neither a long rule id nor a long title can widen the table at 320 px.
 */
.rules {
  width: 100%;
  max-width: 880px;
  margin-top: 28px;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 14px;
  text-align: left;
}
.rules caption {
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  padding-bottom: 10px;
}
.rules th, .rules td {
  text-align: left;
  vertical-align: baseline;
  padding: 8px 16px 8px 0;
  border-bottom: 1px solid var(--line-soft);
  min-width: 0;
}
.rules thead th {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 6px;
}
.rules tbody th { font-weight: 600; }
.rules th:nth-child(2), .rules td:nth-child(2) { width: 30%; }
.rules .pill { white-space: normal; }
.rules__title { display: block; }
.rules__id { display: block; font-size: 12px; color: var(--muted); font-weight: 400; }
.rules__count {
  width: 18%;
  text-align: right;
  padding-right: 0;
  font-variant-numeric: tabular-nums;
}
.rules tbody tr:last-child th, .rules tbody tr:last-child td { border-bottom: 0; }

/* Phone: the severity label needs most of the room the rule title can spare. */
@media (max-width: 559px) {
  .rules th, .rules td { padding-right: 4px; }
  .rules thead th { font-size: 12px; }
  .rules th:nth-child(2), .rules td:nth-child(2) { width: 44%; }
  .rules__count { width: 21%; padding-right: 0; }
  .rules .pill { font-size: 12px; padding: 1px 4px; }
}

/* ---------- layout ---------- */

.columns { display: grid; gap: 32px; align-items: start; }
@media (min-width: 1024px) {
  .columns { grid-template-columns: 6fr 4fr; gap: 40px; }
  .columns--single { grid-template-columns: minmax(0, 1fr); }
  /*
   * Side by side the capture stays in view while the list scrolls, and
   * following a marker link scrolls this panel to the marker — the browser's
   * own fragment navigation, which also scrolls the nearest scroll container.
   */
  .shot {
    position: sticky;
    top: 24px;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
}
.columns > * { min-width: 0; }

.panel {
  background: var(--paper);
  border: 1px solid var(--line);
  padding: 20px 20px 24px;
}
@media (min-width: 640px) { .panel { padding: 28px 32px 32px; } }
.panel__title { color: var(--navy); }
.panel__head { border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 20px; }

/* ---------- screenshot ---------- */

/*
 * Two boxes on purpose. The outer one carries the width the capture may be
 * shown at and, in print, the height it may take; the inner one is the
 * capture itself and is never bounded, because the markers are positioned in
 * percentages of it. Capping the box the markers are measured against would
 * move every marker up into the visible crop, onto content it has nothing to
 * do with.
 */
.shot__clip {
  /* Never enlarged past the CSS size it was captured at. */
  max-width: var(--shot-max, none);
}
.shot__frame {
  position: relative;
  border: 1px solid var(--line);
  background: var(--shell);
}
.shot__frame img { display: block; width: 100%; height: auto; }

/*
 * The box is exactly the element's rect in percentages of the capture, so it
 * never gets a minimum size. A tiny rect still gets a usable target: the
 * pseudo-element below widens only the clickable area, centred on the rect.
 */
.marker {
  position: absolute;
  display: block;
  box-shadow: inset 0 0 0 2px var(--navy), 0 0 0 2px rgba(255, 255, 255, 0.95);
  scroll-margin: 80px;
}
.marker::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: max(100%, 24px);
  height: max(100%, 24px);
}
.marker__badge {
  position: absolute;
  top: 0; left: 0;
  transform: translate(-50%, -50%);
  width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--navy);
  color: #fff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.95);
  font-size: 12px;
  font-weight: 600;
  line-height: 22px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.marker--inset-x .marker__badge { left: 0; transform: translate(1px, -50%); }
.marker--inset-y .marker__badge { top: 0; transform: translate(-50%, 1px); }
.marker--inset-x.marker--inset-y .marker__badge { transform: translate(1px, 1px); }
.marker:hover,
.marker:focus-visible,
.marker:target {
  box-shadow: inset 0 0 0 4px var(--navy), 0 0 0 4px #fff;
  outline: none;
}
.marker:focus-visible { outline: 3px solid var(--link); outline-offset: 4px; }

.shot__note { margin-top: 12px; font-size: 13px; color: var(--muted); }

/* ---------- capture sections ---------- */

/*
 * One section per rendering condition, below the main view: the heading and
 * its sentence, then the capture and that condition's findings in the same
 * two columns the main view uses.
 */
.capture { margin-top: 36px; }
.capture__title { color: var(--navy); font-size: 20px; }
.capture__note {
  margin-top: 6px;
  max-width: 80ch;
  font-size: 14px;
  color: var(--muted);
  overflow-wrap: break-word;
}
.capture .columns { margin-top: 16px; }

/* ---------- findings ---------- */

.summary { font-size: 14px; color: var(--muted); margin-top: 6px; font-variant-numeric: tabular-nums; }

.group { padding-top: 20px; }
.group + .group { border-top: 1px solid var(--line); margin-top: 20px; }
.group:first-of-type { padding-top: 0; }

.group__title {
  color: var(--navy);
  display: flex;
  align-items: center;
  gap: 10px;
  scroll-margin-top: 16px;
}
.group__title:target,
.group__title:focus {
  outline: 3px solid var(--link);
  outline-offset: 6px;
  border-radius: 2px;
}
.group__mark {
  display: inline-block;
  min-width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--navy);
  color: #fff;
  font-size: 12px;
  line-height: 22px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  flex: none;
}
.group__meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin-top: 8px; }
.group__meta > * { min-width: 0; }
.group__link { font-size: 13px; }
.group__note { font-size: 13px; color: var(--muted); margin-top: 6px; }

.issues { margin-top: 14px; }
.issue { padding: 16px 0; border-top: 1px solid var(--line-soft); }
.issue:first-child { border-top: 0; padding-top: 2px; }

.issue__title { font-weight: 400; }
.pill + .issue__headline { margin-left: 8px; }
.issue__headline { font-weight: 600; }
.issue__desc { margin-top: 6px; color: var(--muted); font-size: 14px; }

.fields { margin: 12px 0 0; display: grid; gap: 8px; font-size: 14px; }
.fields > div { display: grid; gap: 2px; }
@media (min-width: 560px) {
  .fields > div { grid-template-columns: 130px minmax(0, 1fr); gap: 4px 16px; align-items: baseline; }
}
.fields dt { color: var(--muted); font-size: 13px; }
.fields dd { margin: 0; min-width: 0; }
.fields dd.is-multiline { white-space: pre-line; }

code, .code, pre {
  font-family: var(--mono);
  font-size: 13px;
}
.code, pre {
  display: block;
  margin: 0;
  padding: 6px 8px;
  background: #f4f6f8;
  border: 1px solid var(--line-soft);
  color: #263241;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.empty { margin-top: 16px; color: var(--muted); }

/* ---------- footer ---------- */

.colophon {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  font-size: 13px;
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

/* ---------- print ---------- */

@media print {
  @page { margin: 16mm 14mm; }
  body { background: #fff; }
  .page { padding: 0; max-width: none; }
  .masthead, .panel { border-color: #c9d1da; }
  .masthead { margin: 0 0 16px; padding: 0 0 16px; border: 0; border-bottom: 2px solid var(--navy); }
  .score { background: #fff; border: 1px solid #c9d1da; }
  .columns { display: block; }
  .panel { border: 0; padding: 0; }
  .shot { position: static; max-height: none; overflow: visible; margin-bottom: 24px; }
  .findings { margin-top: 24px; }
  .shot__clip {
    max-width: min(var(--shot-max, 100%), max(70mm, min(100%, calc(230mm * var(--shot-ratio, 1)))));
  }
  .marker { box-shadow: inset 0 0 0 2px var(--navy), 0 0 0 2px #fff; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .marker__badge, .group__mark, .pill { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .issue, .panel__head { break-inside: avoid; }
  h2, h3 { break-after: avoid; }
  /* Each condition starts a page, with its heading and sentence attached. */
  .capture { break-before: page; margin-top: 0; }
  .capture__title, .capture__note { break-after: avoid; }
  .capture .columns { margin-top: 12px; }
  .capture .findings { margin-top: 16px; }
  /*
   * A capture is one page tall at most. A browser cannot split an image
   * across printed pages, so without this a tall narrow capture (a phone
   * viewport of a long page) is moved to a page of its own, leaves the
   * heading behind on an empty one, and still runs off the bottom. The
   * width formula already keeps a capture within that height wherever its
   * aspect ratio allows; one that would need to go below the 70 mm floor to
   * manage it is shown from the top and cut off, and its findings carry
   * their evidence either way. The clipping is on the outer box, so the
   * capture and its markers keep their full geometry inside it and a marker
   * below the cut is cut off with the part of the page it points at.
   */
  .capture .shot__clip {
    max-width: min(var(--shot-max, 100%), max(70mm, min(100%, calc(215mm * var(--shot-ratio, 1)))));
    max-height: 215mm;
    overflow: hidden;
    break-inside: avoid;
  }
  a { text-decoration: none; }
}
`;
