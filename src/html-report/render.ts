/**
 * Static HTML report.
 *
 * `renderHtmlReport()` turns an `AuditResult` into one self-contained
 * document: the full-page screenshot with a numbered marker on every located
 * element, and the issue list grouped by marker. It is a pure function — no
 * browser, no file system, no network, no JavaScript in the output — and the
 * only consumer of `Issue.annotation` plus `AuditResult.screenshotMeta` that
 * ships with this library.
 */

import { Buffer } from "node:buffer";
import type {
  AnnotationRect,
  AuditResult,
  Issue,
  IssueSeverity,
  RenderingCapture,
  ScreenshotMeta,
} from "../types.js";
import { escapeHtml, safeLinkHref, truncate } from "./escape.js";
import { type HtmlReportLocale, REPORT_LABELS, type ReportLabels } from "./labels.js";
import { REPORT_CSS } from "./styles.js";

export interface HtmlReportOptions {
  /**
   * Language of the report's own labels; issue texts stay as the engine or
   * the model wrote them.
   * @default "en"
   */
  locale?: HtmlReportLocale;
}

/** HTML snippets are cut here, with a visible ellipsis. */
const SNIPPET_MAX_LENGTH = 500;

/**
 * A rect whose top-left corner sits closer than this to the capture's edge
 * (CSS px) gets its badge pushed inside the frame instead of centred on the
 * corner, where it would be clipped.
 */
const BADGE_INSET_THRESHOLD = 40;

const SEVERITY_ORDER: readonly IssueSeverity[] = ["critical", "serious", "moderate", "minor"];

/**
 * Marks and rects reach the report from `Issue.annotation`, which may have
 * been through JSON, so the TypeScript type guarantees nothing here. A mark
 * is interpolated into element ids and fragment hrefs, so only a positive
 * integer counts; anything else makes the issue "not located".
 */
function markerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** A rect is usable only when all four sides are finite numbers. */
function usableRect(value: unknown): AnnotationRect | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  for (const side of ["x", "y", "width", "height"] as const) {
    if (typeof candidate[side] !== "number" || !Number.isFinite(candidate[side])) return null;
  }
  return candidate as unknown as AnnotationRect;
}

/** All issues sharing one marker number, in issue order. */
interface MarkerGroup {
  mark: number;
  selector: string | null;
  rect: AnnotationRect;
  ambiguous: boolean;
  issues: Issue[];
}

interface Partitioned {
  groups: MarkerGroup[];
  pageLevel: Issue[];
  notLocated: Issue[];
}

/**
 * Group the issues by the marker their annotation places them on.
 *
 * `annotatedHere` says whether the annotations belong to the capture this
 * partition is for. In the main view they do not: a rendering finding is
 * annotated in the space of its own condition's capture, so its mark and
 * rect would put a marker on the wrong image, and it is listed as not
 * located unless a capture section shows it. In a capture section they do,
 * and the findings of that condition are grouped by their marker exactly as
 * the main view groups the engine's.
 */
function partitionIssues(issues: Issue[], annotatedHere = false): Partitioned {
  const groups = new Map<number, MarkerGroup>();
  const pageLevel: Issue[] = [];
  const notLocated: Issue[] = [];

  for (const issue of issues) {
    if (issue.rendering && !annotatedHere) {
      notLocated.push(issue);
      continue;
    }

    const annotation = issue.annotation;
    const mark = markerNumber(annotation?.mark);
    const rect = usableRect(annotation?.rect);
    if (annotation && mark !== null && rect) {
      const existing = groups.get(mark);
      if (existing) {
        existing.issues.push(issue);
        existing.ambiguous ||= annotation.state === "ambiguous";
      } else {
        groups.set(mark, {
          mark,
          selector: annotation.selector,
          rect,
          ambiguous: annotation.state === "ambiguous",
          issues: [issue],
        });
      }
      continue;
    }
    if (annotation?.state === "page") {
      pageLevel.push(issue);
      continue;
    }
    notLocated.push(issue);
  }

  return {
    groups: [...groups.values()].sort((a, b) => a.mark - b.mark),
    pageLevel,
    notLocated,
  };
}

function severityCounts(issues: Issue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };
  for (const issue of issues) {
    if (SEVERITY_ORDER.includes(issue.impact)) counts[issue.impact] += 1;
  }
  return counts;
}

/**
 * The result's own timestamp, rendered from its UTC parts so the same result
 * produces the same document on any machine.
 */
function formatTimestamp(timestamp: string, locale: HtmlReportLocale): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  return locale === "de"
    ? `${day}.${month}.${year}, ${time} UTC`
    : `${year}-${month}-${day}, ${time} UTC`;
}

/** How the page is named in the report title and the image's text alternative. */
function pageName(result: AuditResult, labels: ReportLabels): string {
  const title = result.documentTitle?.trim();
  if (title) return title;
  const url = result.url?.trim();
  return url || labels.untitled;
}

function percentOf(value: number, total: number): string {
  if (!(total > 0)) return "0%";
  return `${((value / total) * 100).toFixed(4)}%`;
}

function field(term: string, valueHtml: string): string {
  return `<div><dt>${escapeHtml(term)}</dt><dd>${valueHtml}</dd></div>`;
}

function codeBlock(value: string): string {
  return `<code class="code">${escapeHtml(value)}</code>`;
}

/** A URL as a link when it is http(s), as plain text otherwise. */
function urlHtml(value: string): string {
  const href = safeLinkHref(value);
  const text = escapeHtml(value);
  return href ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
}

/**
 * Which repeated fields an issue card carries. Inside a marker group the
 * element's selector stands once in the group heading, so the cards there
 * leave it out.
 */
interface IssueFields {
  selector: boolean;
  position: boolean;
}

/**
 * Severity pill. The class comes from the known severities only: a result can
 * be deserialized JSON, so an unknown impact is shown as escaped text with no
 * modifier class rather than interpolated into the attribute.
 */
function renderSeverityPill(impact: unknown, labels: ReportLabels): string {
  const severity = SEVERITY_ORDER.find((known) => known === impact);
  if (severity) {
    return `<span class="pill pill--${severity}">${escapeHtml(labels.severity[severity])}</span>`;
  }
  return `<span class="pill">${escapeHtml(String(impact ?? ""))}</span>`;
}

function renderIssue(issue: Issue, labels: ReportLabels, show: IssueFields): string {
  const headline = issue.help?.trim() || issue.description?.trim() || issue.id;
  const description = issue.description?.trim();
  const parts: string[] = [];

  parts.push(
    `<h4 class="issue__title">${renderSeverityPill(issue.impact, labels)}` +
      `<span class="issue__headline">${escapeHtml(headline)}</span></h4>`
  );
  if (description && description !== headline) {
    parts.push(`<p class="issue__desc">${escapeHtml(description)}</p>`);
  }

  const fields: string[] = [];
  fields.push(field(labels.field.rule, `<code>${escapeHtml(issue.id)}</code>`));
  fields.push(
    field(
      labels.field.source,
      escapeHtml(issue.semantic ? labels.sourceAi(issue.semantic.checkType) : labels.sourceEngine)
    )
  );
  if (show.selector && issue.selector?.trim()) {
    fields.push(field(labels.field.element, codeBlock(issue.selector)));
  }
  if (show.position) {
    const state = issue.annotation?.state;
    const text =
      state === "hidden"
        ? labels.position.hidden
        : state === "unresolved"
          ? labels.position.unresolved
          : labels.position.none;
    fields.push(field(labels.field.position, escapeHtml(text)));
  }
  if (issue.semantic) {
    fields.push(
      field(
        labels.field.confidence,
        escapeHtml(labels.percent(Math.round(issue.semantic.confidence * 100)))
      )
    );
  }
  if (issue.failureSummary?.trim()) {
    fields.push(
      `<div><dt>${escapeHtml(labels.field.failure)}</dt><dd class="is-multiline">${escapeHtml(
        issue.failureSummary.trim()
      )}</dd></div>`
    );
  }
  const snippet = issue.nodes[0]?.html?.trim();
  if (snippet) {
    fields.push(
      field(labels.field.code, `<pre>${escapeHtml(truncate(snippet, SNIPPET_MAX_LENGTH))}</pre>`)
    );
  }
  if (issue.semantic?.suggestion?.trim()) {
    fields.push(field(labels.field.suggestion, escapeHtml(issue.semantic.suggestion.trim())));
  }
  if (issue.helpUrl?.trim()) {
    fields.push(field(labels.field.reference, urlHtml(issue.helpUrl.trim())));
  }

  parts.push(`<dl class="fields">${fields.join("")}</dl>`);
  return `<li class="issue">${parts.join("")}</li>`;
}

function renderIssueList(issues: Issue[], labels: ReportLabels, show: IssueFields): string {
  return `<ul class="issues">${issues
    .map((issue) => renderIssue(issue, labels, show))
    .join("")}</ul>`;
}

/**
 * Marker and group ids carry the capture they belong to, so the marks of
 * several captures — each numbered from 1 in its own reading order — cannot
 * collide in one document. The main screenshot's scope is empty, which keeps
 * its ids `marker-1`, `group-1` and so on.
 */
function renderGroup(
  group: MarkerGroup,
  labels: ReportLabels,
  hasMarkers: boolean,
  scope = ""
): string {
  const parts: string[] = [];
  parts.push(
    `<h3 class="group__title" id="group-${scope}${group.mark}" tabindex="-1">` +
      `<span class="group__mark" aria-hidden="true">${group.mark}</span>` +
      `${escapeHtml(labels.marker(group.mark))}</h3>`
  );

  const meta: string[] = [];
  if (group.selector?.trim()) meta.push(codeBlock(group.selector));
  if (hasMarkers) {
    meta.push(
      `<a class="group__link" href="#marker-${scope}${group.mark}">${escapeHtml(
        labels.showMarker(group.mark)
      )}</a>`
    );
  }
  if (meta.length > 0) parts.push(`<p class="group__meta">${meta.join("")}</p>`);
  if (group.ambiguous) parts.push(`<p class="group__note">${escapeHtml(labels.ambiguous)}</p>`);

  parts.push(renderIssueList(group.issues, labels, { selector: false, position: false }));
  return `<section class="group">${parts.join("")}</section>`;
}

function renderSection(
  heading: string,
  issues: Issue[],
  labels: ReportLabels,
  withPosition: boolean
): string {
  return (
    `<section class="group"><h3 class="group__title">${escapeHtml(heading)}</h3>` +
    `${renderIssueList(issues, labels, { selector: true, position: withPosition })}</section>`
  );
}

function renderMarker(
  group: MarkerGroup,
  meta: { width: number; height: number },
  labels: ReportLabels,
  scope = ""
): string {
  const rect = group.rect;
  const classes = ["marker"];
  if (rect.x < BADGE_INSET_THRESHOLD) classes.push("marker--inset-x");
  if (rect.y < BADGE_INSET_THRESHOLD) classes.push("marker--inset-y");
  const style =
    `left:${percentOf(rect.x, meta.width)};` +
    `top:${percentOf(rect.y, meta.height)};` +
    `width:${percentOf(rect.width, meta.width)};` +
    `height:${percentOf(rect.height, meta.height)}`;
  return (
    `<a class="${classes.join(" ")}" id="marker-${scope}${group.mark}" href="#group-${scope}${group.mark}" style="${style}">` +
    `<span class="marker__badge" aria-hidden="true">${group.mark}</span>` +
    `<span class="sr-only">${escapeHtml(labels.markerLink(group.mark, group.issues.length))}</span>` +
    `</a>`
  );
}

/**
 * The image as a `data:` URL. The page screenshot is a PNG and the condition
 * captures are JPEGs, and a result can have been through JSON, so the format
 * is read from the bytes rather than assumed.
 */
function imageSource(bytes: Uint8Array): string {
  const png =
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  return `data:image/${png ? "png" : "jpeg"};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * The outer box's own geometry: the capture's aspect ratio, which the print
 * stylesheet sizes by, and its CSS width, which is where the image stops
 * being enlarged. A 320 px capture shown three times its size is a blurred
 * claim about what the page looks like. It sits on the clipping box and not
 * on the frame the markers are positioned in, which stays unbounded.
 */
function frameStyle(meta: { width: number; height: number }): string {
  return (
    ` style="--shot-ratio:${(meta.width / meta.height).toFixed(4)};` +
    `--shot-max:${Math.round(meta.width)}px"`
  );
}

function renderScreenshot(
  result: AuditResult,
  groups: MarkerGroup[],
  labels: ReportLabels
): string {
  const screenshot = result.screenshot;
  if (!screenshot || screenshot.length === 0) return "";

  const meta = result.screenshotMeta;
  const markers = meta ? groups : [];
  const source = imageSource(screenshot);
  const alt = labels.imageAlt(pageName(result, labels), markers.length);
  const frame = meta && meta.width > 0 && meta.height > 0 ? frameStyle(meta) : "";

  const overlay = meta ? markers.map((group) => renderMarker(group, meta, labels)).join("") : "";

  return (
    // The panel scrolls on its own from 1024 px, so it is a labelled region
    // a keyboard user can focus and scroll.
    `<section class="panel shot" aria-labelledby="screenshot-heading" tabindex="0">` +
    `<div class="panel__head"><h2 class="panel__title" id="screenshot-heading">${escapeHtml(
      labels.screenshotHeading
    )}</h2></div>` +
    `<div class="shot__clip"${frame}><div class="shot__frame">` +
    `<img src="${source}" alt="${escapeHtml(alt)}" />${overlay}</div></div>` +
    `</section>`
  );
}

/**
 * One section per rendering capture: the page as it rendered under that
 * condition, with the markers and the findings of that condition.
 *
 * A rendering finding's annotation is in its own capture's coordinate space,
 * which is exactly what these sections supply — so the findings of a
 * condition live here and not in the main view's "not located" group. The
 * main summary line counts them, and the findings-by-rule table counts every
 * issue regardless.
 */
interface CaptureSection {
  /** Unique within the document; the scope of this section's marker ids. */
  id: string;
  /** The condition in plain words. */
  title: string;
  /** One sentence on what the condition simulates; empty for an unknown id. */
  note: string;
  capture: RenderingCapture;
  /** Every issue this section shows, so the main view can leave them out. */
  issues: Issue[];
  partitioned: Partitioned;
  /** Capture geometry, when it is usable for placing markers. */
  meta?: ScreenshotMeta;
}

/** A slug for the element ids of one condition's section. */
function conditionSlug(condition: string): string {
  const slug = condition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "condition" : slug;
}

/**
 * The condition in plain words: the titles of its parts joined, and their
 * sentences. A composite reads as "At 320 px width + Text spacing per WCAG
 * 1.4.12". An id this version does not know — a result from a newer one — is
 * shown as it is, with no sentence, and is escaped like every other string
 * that did not come from these labels.
 */
function conditionWords(condition: string, labels: ReportLabels): { title: string; note: string } {
  const parts = condition
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const known = parts
    .map((part) => labels.condition[part])
    .filter((entry): entry is { title: string; note: string } => entry !== undefined);
  if (parts.length === 0 || known.length !== parts.length) {
    return { title: condition, note: "" };
  }
  return {
    title: known.map((entry) => entry.title).join(" + "),
    note: known.map((entry) => entry.note).join(" "),
  };
}

/** Capture geometry is usable only when both sides are positive numbers. */
function usableMeta(value: unknown): ScreenshotMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = value as Record<string, unknown>;
  for (const side of ["width", "height"] as const) {
    if (typeof meta[side] !== "number" || !Number.isFinite(meta[side])) return undefined;
    if ((meta[side] as number) <= 0) return undefined;
  }
  return value as ScreenshotMeta;
}

/**
 * The sections to render, in capture order. A capture without image bytes
 * gets no section, and its findings stay in the main view's "not located"
 * group: the report has to stay usable without the captures.
 */
function captureSections(result: AuditResult, labels: ReportLabels): CaptureSection[] {
  const captures = result.renderingCaptures;
  if (!Array.isArray(captures) || captures.length === 0) return [];

  const byCondition = new Map<string, Issue[]>();
  for (const issue of result.issues ?? []) {
    const condition = issue.rendering?.condition;
    if (typeof condition !== "string") continue;
    const existing = byCondition.get(condition);
    if (existing) existing.push(issue);
    else byCondition.set(condition, [issue]);
  }

  const sections: CaptureSection[] = [];
  const seen = new Set<string>();

  for (const [index, capture] of captures.entries()) {
    if (!capture || typeof capture.condition !== "string") continue;
    if (!capture.screenshot || capture.screenshot.length === 0) continue;
    // One capture per condition is what the pass produces; a second one
    // would show the same findings twice.
    if (seen.has(capture.condition)) continue;
    seen.add(capture.condition);

    const words = conditionWords(capture.condition, labels);
    const issues = byCondition.get(capture.condition) ?? [];
    const meta = usableMeta(capture.meta);

    sections.push({
      // The index makes it unique even when two condition ids slug alike.
      id: `cap${index}-${conditionSlug(capture.condition)}`,
      title: words.title,
      note: words.note,
      capture,
      issues,
      partitioned: partitionIssues(issues, true),
      ...(meta ? { meta } : {}),
    });
  }

  return sections;
}

function renderCaptureSection(
  section: CaptureSection,
  result: AuditResult,
  labels: ReportLabels
): string {
  const { meta, partitioned } = section;
  const scope = `${section.id}-`;
  const hasMarkers = meta !== undefined && partitioned.groups.length > 0;
  const markers = meta
    ? partitioned.groups.map((group) => renderMarker(group, meta, labels, scope)).join("")
    : "";
  const alt = labels.captureImageAlt(
    pageName(result, labels),
    section.title,
    meta ? partitioned.groups.length : 0
  );
  const frame = meta ? frameStyle(meta) : "";

  const list: string[] = [];
  if (section.issues.length === 0) {
    list.push(`<p class="empty">${escapeHtml(labels.captureNoFindings)}</p>`);
  } else {
    for (const group of partitioned.groups) {
      list.push(renderGroup(group, labels, hasMarkers, scope));
    }
    if (partitioned.pageLevel.length > 0) {
      list.push(renderSection(labels.pageLevelHeading, partitioned.pageLevel, labels, false));
    }
    if (partitioned.notLocated.length > 0) {
      list.push(renderSection(labels.captureNotLocated, partitioned.notLocated, labels, true));
    }
  }

  return (
    `<section class="capture" aria-labelledby="${scope}title">` +
    `<h2 class="capture__title" id="${scope}title">${escapeHtml(section.title)}</h2>` +
    (section.note ? `<p class="capture__note">${escapeHtml(section.note)}</p>` : "") +
    `<div class="columns">` +
    // Like the main screenshot panel: side by side it scrolls on its own, so
    // it is a labelled region a keyboard user can focus and scroll.
    `<section class="panel shot" aria-label="${escapeHtml(
      labels.capturePanel(section.title)
    )}" tabindex="0">` +
    `<div class="shot__clip"${frame}><div class="shot__frame">` +
    `<img src="${imageSource(section.capture.screenshot)}" alt="${escapeHtml(alt)}" />` +
    `${markers}</div></div></section>` +
    `<div class="panel findings">${list.join("")}</div>` +
    `</div></section>`
  );
}

function renderSemanticFacts(result: AuditResult, labels: ReportLabels): string {
  const semantic = result.semanticMeta;
  if (!semantic) return "";

  const tiers = semantic.tiers ?? {};
  const entries = (["large", "small"] as const)
    .filter((tier) => tiers[tier])
    .map((tier) => {
      const entry = tiers[tier];
      if (!entry) return "";
      return `${entry.provider}${entry.model ? ` · ${entry.model}` : ""} (${labels.tier[tier]})`;
    })
    .filter(Boolean);

  const lines =
    entries.length > 0
      ? entries
      : [`${semantic.provider}${semantic.model ? ` · ${semantic.model}` : ""}`];

  return `<div><dt>${escapeHtml(labels.semanticAudit)}</dt>${lines
    .map((line) => `<dd>${escapeHtml(line)}</dd>`)
    .join("")}</div>`;
}

/** One row of the findings-by-rule table. */
interface RuleRow {
  id: string;
  title: string;
  severity: IssueSeverity;
  count: number;
}

/**
 * One row per rule id, worst severity first and within a severity the most
 * frequent rule first — the executive summary for a page where one rule
 * accounts for hundreds of issues.
 */
function ruleRows(issues: Issue[]): RuleRow[] {
  const rows = new Map<string, RuleRow>();
  for (const issue of issues) {
    const severity = SEVERITY_ORDER.includes(issue.impact) ? issue.impact : "minor";
    const existing = rows.get(issue.id);
    if (existing) {
      existing.count += 1;
      if (SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(existing.severity)) {
        existing.severity = severity;
      }
      continue;
    }
    rows.set(issue.id, {
      id: issue.id,
      title: issue.help?.trim() || issue.description?.trim() || issue.id,
      severity,
      count: 1,
    });
  }

  return [...rows.values()].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return bySeverity !== 0 ? bySeverity : b.count - a.count;
  });
}

function renderRuleTable(issues: Issue[], labels: ReportLabels): string {
  const rows = ruleRows(issues);
  if (rows.length === 0) return "";

  const body = rows
    .map(
      (row) =>
        `<tr><th scope="row"><span class="rules__title">${escapeHtml(row.title)}</span>` +
        `<code class="rules__id">${escapeHtml(row.id)}</code></th>` +
        `<td><span class="pill pill--${row.severity}">${escapeHtml(
          labels.severity[row.severity]
        )}</span></td>` +
        `<td class="rules__count">${row.count}</td></tr>`
    )
    .join("");

  return (
    `<table class="rules"><caption>${escapeHtml(labels.rules.caption)}</caption>` +
    `<thead><tr><th scope="col">${escapeHtml(labels.rules.rule)}</th>` +
    `<th scope="col">${escapeHtml(labels.rules.severity)}</th>` +
    `<th scope="col" class="rules__count">${escapeHtml(labels.rules.occurrences)}</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

function renderMasthead(
  result: AuditResult,
  issues: Issue[],
  labels: ReportLabels,
  locale: HtmlReportLocale
): string {
  const counts = severityCounts(issues);
  const title = result.documentTitle?.trim();

  const facts: string[] = [];
  facts.push(
    `<div><dt>${escapeHtml(labels.auditedPage)}</dt><dd>${urlHtml(result.url ?? "")}</dd></div>`
  );
  facts.push(
    `<div><dt>${escapeHtml(labels.pageTitle)}</dt><dd>${escapeHtml(
      title || labels.untitled
    )}</dd></div>`
  );
  facts.push(
    `<div><dt>${escapeHtml(labels.auditedAt)}</dt><dd>${escapeHtml(
      formatTimestamp(result.timestamp, locale)
    )}</dd></div>`
  );
  facts.push(renderSemanticFacts(result, labels));

  // English shows the interpretation the result carries; German has its own
  // copy per severity level, since the library writes that text in English.
  const level = result.scoreInterpretation?.level ?? result.severityLevel;
  const translated = level ? labels.scoreInterpretation?.[level] : undefined;
  const interpretation = translated ?? result.scoreInterpretation;
  const score =
    `<div class="score">` +
    `<p class="score__figure"><span class="score__label">${escapeHtml(labels.score)}</span>` +
    `<span class="score__value">${escapeHtml(String(result.score))}</span>` +
    `<span class="score__scale">/ 100</span></p>` +
    `<div class="score__text">` +
    (interpretation?.title
      ? `<p class="score__title">${escapeHtml(interpretation.title)}</p>`
      : "") +
    (interpretation?.description
      ? `<p class="score__desc">${escapeHtml(interpretation.description)}</p>`
      : "") +
    `</div></div>`;

  const countItems = SEVERITY_ORDER.map((severity) => {
    const count = counts[severity];
    return (
      `<li><span class="counts__value${count === 0 ? " counts__zero" : ""}">${count}</span>` +
      `<span class="pill pill--${severity}">${escapeHtml(labels.severity[severity])}</span></li>`
    );
  }).join("");

  return (
    `<header class="masthead">` +
    `<p class="masthead__brand">barrieretest</p>` +
    `<h1>${escapeHtml(labels.reportTitle)}</h1>` +
    `<dl class="facts">${facts.join("")}</dl>` +
    score +
    `<h2 class="sr-only">${escapeHtml(labels.severityCounts)}</h2>` +
    `<ul class="counts">${countItems}</ul>` +
    renderRuleTable(issues, labels) +
    `</header>`
  );
}

function renderFindings(
  issues: Issue[],
  partitioned: Partitioned,
  labels: ReportLabels,
  grouped: boolean,
  hasMarkers: boolean,
  underConditions: number
): string {
  const parts: string[] = [];
  parts.push(
    `<div class="panel__head"><h2 class="panel__title" id="findings-heading">${escapeHtml(
      labels.findingsHeading
    )}</h2>` +
      (grouped
        ? `<p class="summary">${escapeHtml(
            labels.summary(
              partitioned.groups.reduce((total, group) => total + group.issues.length, 0),
              partitioned.pageLevel.length,
              partitioned.notLocated.length,
              underConditions
            )
          )}</p>`
        : "") +
      `</div>`
  );

  if (issues.length === 0) {
    // The clean-result sentence is about the whole audit. With findings in
    // the capture sections below it would contradict the severity counts
    // above it and the sections themselves.
    parts.push(
      `<p class="empty">${escapeHtml(
        underConditions > 0 ? labels.onlyUnderConditions : labels.noIssues
      )}</p>`
    );
  } else if (!grouped) {
    parts.push(renderSection(labels.allIssuesHeading, issues, labels, false));
  } else {
    for (const group of partitioned.groups) parts.push(renderGroup(group, labels, hasMarkers));
    if (partitioned.pageLevel.length > 0) {
      parts.push(renderSection(labels.pageLevelHeading, partitioned.pageLevel, labels, false));
    }
    if (partitioned.notLocated.length > 0) {
      parts.push(renderSection(labels.notLocatedHeading, partitioned.notLocated, labels, true));
    }
  }

  return `<section class="panel findings" aria-labelledby="findings-heading">${parts.join("")}</section>`;
}

/**
 * Render an audit result as one self-contained HTML document. Pure and
 * deterministic: the same result always produces the same string.
 */
export function renderHtmlReport(result: AuditResult, options: HtmlReportOptions = {}): string {
  const locale: HtmlReportLocale = options.locale === "de" ? "de" : "en";
  const labels = REPORT_LABELS[locale];
  const issues = result.issues ?? [];
  // One section per rendering capture, each showing that condition's own
  // findings on its own image; what they show, the main view leaves out.
  const sections = captureSections(result, labels);
  const shownInSections = new Set(sections.flatMap((section) => section.issues));
  const mainIssues = issues.filter((issue) => !shownInSections.has(issue));
  // Marker groups and the "on the screenshot" summary only make sense when
  // there is a screenshot to put the markers on.
  const grouped = result.screenshotMeta !== undefined && result.screenshot !== undefined;
  const partitioned = partitionIssues(grouped ? mainIssues : []);

  const screenshot = renderScreenshot(result, partitioned.groups, labels);
  const findings = renderFindings(
    mainIssues,
    partitioned,
    labels,
    grouped,
    screenshot !== "" && grouped,
    shownInSections.size
  );

  const body = screenshot
    ? `<div class="columns">${screenshot}${findings}</div>`
    : `<div class="columns columns--single">${findings}</div>`;
  const captures = sections
    .map((section) => renderCaptureSection(section, result, labels))
    .join("");

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
<title>${escapeHtml(labels.documentTitle(pageName(result, labels)))}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="page">
${renderMasthead(result, issues, labels, locale)}
<main>${body}${captures}</main>
<footer class="colophon"><p>${escapeHtml(labels.footer)}</p><p>${escapeHtml(
    formatTimestamp(result.timestamp, locale)
  )}</p></footer>
</div>
</body>
</html>
`;
}
