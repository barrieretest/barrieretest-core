import { describe, expect, it } from "bun:test";
import type { AuditResult, Issue, IssueAnnotation } from "../types.js";
import { renderHtmlReport } from "./render.js";

const INTERPRETATION = {
  range: "70-94",
  level: "good" as const,
  title: "Good",
  description: "Some accessibility issues remain.",
  action: "Fix the listed issues.",
  urgency: "low" as const,
  recommendConsulting: false,
  color: "#2e7d32",
};

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "image-alt",
  impact: "critical",
  description: "Images must have alternate text",
  help: "Images need an accessible name",
  selector: "#hero",
  nodes: [{ html: '<img id="hero" src="hero.png">' }],
  ...overrides,
});

const annotation = (overrides: Partial<IssueAnnotation> = {}): IssueAnnotation => ({
  selector: "#hero",
  state: "resolved",
  mark: 1,
  rect: { x: 100, y: 200, width: 300, height: 400 },
  ...overrides,
});

const makeResult = (overrides: Partial<AuditResult> = {}): AuditResult => ({
  url: "https://example.com/page",
  documentTitle: "Example page",
  score: 72,
  severityLevel: "good",
  scoreInterpretation: INTERPRETATION,
  issues: [],
  timestamp: "2026-10-13T08:30:00.000Z",
  ...overrides,
});

/** 1000 × 2000 CSS px, so marker percentages are easy to read in assertions. */
const META: AuditResult["screenshotMeta"] = {
  width: 1000,
  height: 2000,
  deviceScaleFactor: 1,
  viewport: { width: 1000, height: 800 },
  fullPage: true,
  document: { width: 1000, height: 2000 },
  scroll: { x: 0, y: 0 },
};

const SCREENSHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The findings panel only. Rule ids also appear in the masthead's
 * findings-by-rule table, so order assertions about the list look here.
 */
const findingsOf = (html: string): string => html.slice(html.indexOf('class="panel findings"'));

const annotatedResult = (): AuditResult =>
  makeResult({
    screenshot: SCREENSHOT,
    screenshotMeta: META,
    issues: [
      makeIssue({ id: "image-alt", annotation: annotation() }),
      makeIssue({ id: "image-redundant-alt", impact: "minor", annotation: annotation() }),
      makeIssue({
        id: "list-items",
        impact: "moderate",
        selector: "nav li",
        annotation: annotation({
          selector: "nav li",
          state: "ambiguous",
          mark: 2,
          rect: { x: 0, y: 0, width: 200, height: 40 },
        }),
      }),
      makeIssue({
        id: "page-has-heading-one",
        impact: "serious",
        selector: "html",
        annotation: { selector: "html", state: "page" },
      }),
      makeIssue({
        id: "hidden-block",
        selector: "#gone",
        annotation: { selector: "#gone", state: "hidden" },
      }),
      makeIssue({
        id: "semantic:alt-text-quality",
        impact: "moderate",
        selector: "the image at the top",
        annotation: { selector: "the image at the top", state: "unresolved" },
        semantic: { checkType: "alt-text-quality", confidence: 0.82, suggestion: "Describe it." },
      }),
    ],
  });

describe("renderHtmlReport document shell", () => {
  it("writes a self-contained document with the CSP and no scripts", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />`
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("<link ");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Accessibility report – Example page</title>");
  });

  it("renders landmarks, one h1 and the footer line", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html.match(/<h1[ >]/g)?.length).toBe(1);
    expect(html).toContain('<header class="masthead">');
    expect(html).toContain("<main>");
    expect(html).toContain('<footer class="colophon">');
    expect(html).toContain("Generated with barrieretest");
  });

  it("leads with the score, its interpretation and the counts per severity", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain('<span class="score__value">72</span>');
    expect(html).toContain("Good");
    expect(html).toContain("Some accessibility issues remain.");
    expect(html).toContain('<span class="pill pill--critical">Critical</span>');
    expect(html).toContain('<span class="pill pill--minor">Minor</span>');
  });

  it("formats the result's own timestamp, not the render time", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain("2026-10-13, 08:30 UTC");
  });

  it("is deterministic for the same input", () => {
    expect(renderHtmlReport(annotatedResult())).toBe(renderHtmlReport(annotatedResult()));
  });

  it("names the semantic provider and model per tier", () => {
    const html = renderHtmlReport(
      makeResult({
        semanticMeta: {
          checksRun: ["alt-text-quality"],
          provider: "mistral",
          model: "mistral-large-4",
          tiers: {
            large: { provider: "mistral", model: "mistral-large-4", checksRun: ["alt-text"] },
            small: { provider: "mistral", model: "mistral-small-2603", checksRun: ["lang"] },
          },
        },
      })
    );

    expect(html).toContain("Semantic AI");
    expect(html).toContain("mistral · mistral-large-4 (large model)");
    expect(html).toContain("mistral · mistral-small-2603 (small model)");
  });
});

describe("renderHtmlReport grouping", () => {
  it("puts issues sharing a mark in one group, in mark order", () => {
    const html = renderHtmlReport(annotatedResult());
    const findings = findingsOf(html);

    const firstGroup = findings.indexOf('id="group-1"');
    const secondGroup = findings.indexOf('id="group-2"');
    expect(firstGroup).toBeGreaterThan(-1);
    expect(secondGroup).toBeGreaterThan(firstGroup);
    expect(findings.indexOf("image-redundant-alt")).toBeGreaterThan(firstGroup);
    expect(findings.indexOf("image-redundant-alt")).toBeLessThan(secondGroup);
    expect(html).toContain("Marker 1");
    expect(html).toContain("Marker 2");
  });

  it("states the ambiguity on the group that has it", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain(
      "This selector matched several elements; the marker shows the first one."
    );
  });

  it("separates page-level issues from issues that could not be placed", () => {
    const findings = findingsOf(renderHtmlReport(annotatedResult()));

    const pageLevel = findings.indexOf("Page-level issues");
    const notLocated = findings.indexOf("Not located on the screenshot");
    expect(pageLevel).toBeGreaterThan(-1);
    expect(notLocated).toBeGreaterThan(pageLevel);
    expect(findings.indexOf("page-has-heading-one")).toBeGreaterThan(pageLevel);
    expect(findings.indexOf("hidden-block")).toBeGreaterThan(notLocated);
  });

  it("says in words why an issue is not located", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain("Matched, but not visibly rendered in the capture");
    expect(html).toContain("The selector could not be resolved on the page");
  });

  it("counts the three buckets in the summary line", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain("3 on the screenshot · 1 page-level · 2 not located");
  });

  it("shows confidence and suggestion for a semantic issue", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain("AI check (alt-text-quality)");
    expect(html).toContain("82%");
    expect(html).toContain("Describe it.");
  });

  it("truncates an HTML snippet at 500 characters with an ellipsis", () => {
    const snippet = `<div>${"a".repeat(600)}</div>`;
    const html = renderHtmlReport(
      makeResult({ issues: [makeIssue({ nodes: [{ html: snippet }] })] })
    );

    expect(html).toContain(`&lt;div&gt;${"a".repeat(495)}…`);
    expect(html).not.toContain("a".repeat(496));
  });
});

describe("renderHtmlReport markers", () => {
  it("places each marker in percentages of the capture geometry", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain(
      'id="marker-1" href="#group-1" style="left:10.0000%;top:10.0000%;width:30.0000%;height:20.0000%"'
    );
  });

  it("gives every marker an accessible name with its issue count", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain('<span class="sr-only">Marker 1, 2 issues</span>');
    expect(html).toContain('<span class="sr-only">Marker 2, 1 issue</span>');
  });

  it("links every marker to its group and every group back to its marker", () => {
    const html = renderHtmlReport(annotatedResult());

    for (const mark of [1, 2]) {
      expect(html).toContain(`id="marker-${mark}" href="#group-${mark}"`);
      expect(html).toContain(`href="#marker-${mark}"`);
      expect(html).toContain(`id="group-${mark}"`);
    }
    expect(html.match(/id="marker-1"/g)?.length).toBe(1);
    expect(html.match(/id="group-1"/g)?.length).toBe(1);
  });

  it("pushes a badge inside the frame when its rect sits at the edge", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain('class="marker marker--inset-x marker--inset-y" id="marker-2"');
  });

  it("names the page and the number of marked elements in the image alternative", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain('alt="Screenshot of Example page with 2 marked elements."');
    expect(html).toContain('<img src="data:image/png;base64,');
  });
});

describe("renderHtmlReport degraded inputs", () => {
  it("renders the screenshot without markers and the list ungrouped without screenshotMeta", () => {
    const result = annotatedResult();
    const html = renderHtmlReport({ ...result, screenshotMeta: undefined });

    expect(html).toContain('<img src="data:image/png;base64,');
    expect(html).not.toContain('class="marker');
    expect(html).not.toContain("Marker 1");
    expect(html).toContain("All issues");
    expect(html).toContain("image-alt");
  });

  it("renders the list only when there is no screenshot", () => {
    const result = annotatedResult();
    const html = renderHtmlReport({ ...result, screenshot: undefined });

    expect(html).not.toContain("<img ");
    // No screenshot to point at: no marker groups, no "on the screenshot" summary.
    expect(html).not.toContain("Marker 1");
    expect(html).not.toContain('class="summary"');
    expect(html).toContain("columns--single");
    expect(html).toContain("image-alt");
  });

  it("renders a result with no issues, no screenshot and no annotations", () => {
    const html = renderHtmlReport(makeResult({ score: 100 }));

    expect(html).toContain("No accessibility issues were found.");
    expect(html).not.toContain("<img ");
  });

  it("falls back to the URL when the page has no title", () => {
    const html = renderHtmlReport(makeResult({ documentTitle: "" }));

    expect(html).toContain("<title>Accessibility report – https://example.com/page</title>");
    expect(html).toContain("(no title)");
  });

  it("keeps a timestamp it cannot parse as text", () => {
    const html = renderHtmlReport(makeResult({ timestamp: "not a date" }));

    expect(html).toContain("not a date");
  });
});

describe("renderHtmlReport escaping", () => {
  const payload = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';

  const hostile = (): AuditResult =>
    makeResult({
      url: payload,
      documentTitle: payload,
      screenshot: SCREENSHOT,
      screenshotMeta: META,
      issues: [
        makeIssue({
          id: payload,
          description: payload,
          help: payload,
          helpUrl: "javascript:alert(1)",
          failureSummary: payload,
          selector: payload,
          nodes: [{ html: payload }],
          semantic: { checkType: payload, confidence: 0.5, suggestion: payload },
          annotation: annotation({ selector: payload }),
        }),
      ],
    });

  it("renders every hostile string as inert text", () => {
    const html = renderHtmlReport(hostile());

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    // The only element in the document is the report's own screenshot image.
    expect(html.match(/<img /g)?.length).toBe(1);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("never interpolates an unknown severity into markup", () => {
    const impact = 'minor"><a href="https://attacker.invalid">Injected</a><span class="';
    const html = renderHtmlReport(makeResult({ issues: [makeIssue({ impact: impact as never })] }));

    expect(html).not.toContain('href="https://attacker.invalid"');
    expect(html).toContain("&lt;a href=&quot;https://attacker.invalid&quot;&gt;Injected&lt;/a&gt;");
    expect(html).toContain('<span class="pill">');
  });

  it("renders a non-http(s) help URL as text, never as a link", () => {
    const html = renderHtmlReport(hostile());

    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("javascript:alert(1)");
  });

  it("links an http(s) URL", () => {
    const html = renderHtmlReport(
      makeResult({
        issues: [makeIssue({ helpUrl: "https://dequeuniversity.com/rules/axe/image-alt" })],
      })
    );

    expect(html).toContain('<a href="https://dequeuniversity.com/rules/axe/image-alt">');
  });

  it("escapes the URL in the audited-page link", () => {
    const html = renderHtmlReport(makeResult({ url: 'https://example.com/"><b>x</b>' }));

    expect(html).toContain("&quot;&gt;&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("renderHtmlReport findings by rule", () => {
  it("lists one row per rule id, by severity then count, with the id in monospace", () => {
    const html = renderHtmlReport(
      makeResult({
        issues: [
          makeIssue({ id: "color-contrast", impact: "serious", help: "Contrast is too low" }),
          makeIssue({ id: "color-contrast", impact: "serious", help: "Contrast is too low" }),
          makeIssue({ id: "image-alt", impact: "critical", help: "Images need a name" }),
          makeIssue({ id: "region", impact: "moderate", help: "Use landmarks" }),
          makeIssue({ id: "region", impact: "moderate", help: "Use landmarks" }),
          makeIssue({ id: "tabindex", impact: "moderate", help: "Avoid positive tabindex" }),
        ],
      })
    );

    expect(html).toContain('<table class="rules"><caption>Findings by rule</caption>');
    expect(html).toContain('<th scope="col">Rule</th>');
    expect(html).toContain('<th scope="col">Severity</th>');
    expect(html).toContain('<th scope="col" class="rules__count">Count</th>');
    expect(html).toContain('<code class="rules__id">color-contrast</code>');
    expect(html).toContain('<span class="pill pill--serious">Serious</span>');

    const rows = [...html.matchAll(/<code class="rules__id">([^<]+)<\/code>/g)].map(
      (match) => match[1]
    );
    expect(rows).toEqual(["image-alt", "color-contrast", "region", "tabindex"]);

    const contrast = html.slice(html.indexOf('"rules__id">color-contrast'));
    expect(contrast).toContain('<td class="rules__count">2</td>');
  });

  it("keeps the worst severity when a rule reports several", () => {
    const html = renderHtmlReport(
      makeResult({
        issues: [
          makeIssue({ id: "aria-roles", impact: "minor" }),
          makeIssue({ id: "aria-roles", impact: "critical" }),
        ],
      })
    );

    const row = html.slice(html.indexOf('"rules__id">aria-roles'));
    expect(row).toContain('<span class="pill pill--critical">Critical</span>');
  });

  it("escapes a hostile rule id and title in the table", () => {
    const html = renderHtmlReport(
      makeResult({ issues: [makeIssue({ id: "<script>a</script>", help: '"><b>x</b>' })] })
    );

    expect(html).toContain('<code class="rules__id">&lt;script&gt;a&lt;/script&gt;</code>');
    expect(html).toContain("&quot;&gt;&lt;b&gt;x&lt;/b&gt;");
  });

  it("writes German column labels", () => {
    const html = renderHtmlReport(makeResult({ issues: [makeIssue()] }), { locale: "de" });

    expect(html).toContain("<caption>Befunde nach Regel</caption>");
    expect(html).toContain('<th scope="col">Schweregrad</th>');
    expect(html).toContain('<th scope="col" class="rules__count">Anzahl</th>');
  });

  it("omits the table when there are no issues", () => {
    expect(renderHtmlReport(makeResult())).not.toContain('<table class="rules">');
  });
});

describe("renderHtmlReport marker validation", () => {
  /** Results can come back from JSON, so the mark is validated, not trusted. */
  const withMark = (mark: unknown, rect: unknown) =>
    renderHtmlReport(
      makeResult({
        screenshot: SCREENSHOT,
        screenshotMeta: META,
        issues: [
          makeIssue({
            annotation: {
              selector: "#hero",
              state: "resolved",
              mark,
              rect,
            } as unknown as IssueAnnotation,
          }),
        ],
      })
    );

  const RECT = { x: 10, y: 20, width: 30, height: 40 };

  it("treats a mark that is a string of markup as not located", () => {
    const html = withMark('1"><img src=x onerror=alert(1)>', RECT);

    expect(html).not.toContain('class="marker');
    expect(html).not.toContain("<img src=x");
    expect(html.match(/<img /g)?.length).toBe(1);
    expect(html).not.toContain('id="group-');
    expect(html).toContain("Not located on the screenshot");
    expect(html).toContain("No position data");
  });

  for (const [name, mark] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -2],
    ["a fraction", 1.5],
    ["null", null],
  ] as const) {
    it(`treats ${name} as not located`, () => {
      const html = withMark(mark, RECT);

      expect(html).not.toContain('class="marker');
      expect(html).not.toContain('id="group-');
      expect(html).toContain("Not located on the screenshot");
    });
  }

  it("treats a missing or unusable rect as not located", () => {
    for (const rect of [undefined, null, {}, { x: 1, y: 2, width: "30", height: 40 }, "rect"]) {
      const html = withMark(1, rect);

      expect(html).not.toContain('class="marker');
      expect(html).not.toContain('id="group-');
      expect(html).toContain("Not located on the screenshot");
    }
  });

  it("forms a group for a positive integer mark with a rect", () => {
    const html = withMark(3, RECT);

    expect(html).toContain('id="marker-3"');
    expect(html).toContain('id="group-3"');
    expect(html).toContain("Marker 3");
  });
});

describe("renderHtmlReport selector placement", () => {
  it("shows the selector once per marker group and not on its issue cards", () => {
    const findings = findingsOf(renderHtmlReport(annotatedResult()));
    const group = findings.slice(
      findings.indexOf('id="group-1"'),
      findings.indexOf('id="group-2"')
    );

    expect(group).toContain('<code class="code">#hero</code>');
    expect(group.match(/#hero<\/code>/g)?.length).toBe(1);
    expect(group).not.toContain("<dt>Element</dt>");
  });

  it("keeps the Element row on page-level and not-located cards", () => {
    const findings = findingsOf(renderHtmlReport(annotatedResult()));
    const tail = findings.slice(findings.indexOf("Page-level issues"));

    expect(tail).toContain("<dt>Element</dt>");
    expect(tail).toContain('<code class="code">html</code>');
    expect(tail).toContain('<code class="code">#gone</code>');
  });

  it("keeps the Element row in the ungrouped list", () => {
    const html = renderHtmlReport({ ...annotatedResult(), screenshotMeta: undefined });

    expect(html).toContain("<dt>Element</dt>");
  });
});

describe("renderHtmlReport score interpretation", () => {
  it("shows the result's own interpretation in English", () => {
    const html = renderHtmlReport(annotatedResult());

    expect(html).toContain('<p class="score__title">Good</p>');
    expect(html).toContain("Some accessibility issues remain.");
  });

  it("writes a German interpretation per severity level, with umlauts", () => {
    const html = renderHtmlReport(annotatedResult(), { locale: "de" });

    expect(html).toContain('<p class="score__title">Gut</p>');
    expect(html).toContain("Einige geringfügige Mängel gefunden.");
    expect(html).not.toContain("Some accessibility issues remain.");
  });

  for (const [level, title] of [
    ["excellent", "Hervorragend"],
    ["good", "Gut"],
    ["needs-improvement", "Verbesserungsbedarf"],
    ["critical", "Kritisch"],
    ["severe", "Gravierend"],
  ] as const) {
    it(`has a German title and description for ${level}`, () => {
      const html = renderHtmlReport(
        makeResult({
          severityLevel: level,
          scoreInterpretation: { ...INTERPRETATION, level },
        }),
        { locale: "de" }
      );

      expect(html).toContain(`<p class="score__title">${title}</p>`);
      expect(html).toMatch(/<p class="score__desc">\S[^<]{30,}<\/p>/);
    });
  }

  it("falls back to the result's severityLevel when there is no interpretation", () => {
    const html = renderHtmlReport(
      makeResult({ severityLevel: "severe", scoreInterpretation: undefined }),
      { locale: "de" }
    );

    expect(html).toContain('<p class="score__title">Gravierend</p>');
  });
});

describe("renderHtmlReport locales", () => {
  it("writes German labels with proper umlauts and leaves issue texts alone", () => {
    const html = renderHtmlReport(annotatedResult(), { locale: "de" });

    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Bericht zur Barrierefreiheit");
    expect(html).toContain("Geprüfte Seite");
    expect(html).toContain("Seitenansicht");
    expect(html).toContain("Befunde");
    expect(html).toContain("Kritisch");
    expect(html).toContain("Nicht in der Seitenansicht verortet");
    expect(html).toContain("Erstellt mit barrieretest");
    expect(html).toContain("13.10.2026, 08:30 UTC");
    expect(html).toContain("82 %");

    // Issue texts come from the engine and stay as they are.
    expect(html).toContain("Images must have alternate text");
    // No transliterated umlauts anywhere in the report's own labels.
    expect(html).not.toMatch(/Gepruefte|Barrierefreiheitspruefung|groesse/);
  });

  it("falls back to English for an unknown locale", () => {
    const html = renderHtmlReport(annotatedResult(), {
      locale: "fr" as unknown as "en",
    });

    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Accessibility report");
  });
});
