import { describe, expect, test } from "bun:test";
import { formatActionable, formatFixReady, formatIssues, formatMinimal } from "./report";
import type { Issue } from "./types";

const mockIssues: Issue[] = [
  {
    id: "WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail",
    impact: "critical",
    description: "This element has insufficient contrast at this conformance level.",
    help: "Color contrast must meet the minimum ratio.",
    helpUrl: "https://www.w3.org/WAI/WCAG21/quickref/#contrast-minimum",
    failureSummary:
      "Fix any of the following:\n  Element has insufficient color contrast of 2.89 (foreground color: #777777, background color: #ffffff)",
    selector: "#header > h1",
    nodes: [{ html: '<h1 style="color: #777">Header</h1>' }],
  },
  {
    id: "WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail",
    impact: "critical",
    description: "This element has insufficient contrast at this conformance level.",
    help: "Color contrast must meet the minimum ratio.",
    selector: "#footer > p",
    nodes: [{ html: '<p style="color: #888">Footer text</p>' }],
  },
  {
    id: "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37",
    impact: "serious",
    description: "Img element is missing an alt attribute.",
    help: "Images must have alt text.",
    selector: "img.logo",
    nodes: [{ html: '<img src="logo.png" class="logo">' }],
  },
  {
    id: "WCAG2AA.Principle3.Guideline3_1.3_1_1.H57.2",
    impact: "moderate",
    description: "The html element should have a lang attribute.",
    help: "Document language should be specified.",
    selector: "html",
    nodes: [{ html: "<html>" }],
  },
];

describe("report formatting", () => {
  describe("formatMinimal", () => {
    test("groups issues by ID and counts occurrences", () => {
      const result = formatMinimal(mockIssues);

      expect(result).toHaveLength(3);

      // Contrast issue appears twice
      const contrastIssue = result.find((r) => r.id.includes("1_4_3"));
      expect(contrastIssue?.count).toBe(2);
      expect(contrastIssue?.impact).toBe("critical");
    });

    test("sorts by severity then count", () => {
      const result = formatMinimal(mockIssues);

      // Critical issues should come first
      expect(result[0].impact).toBe("critical");
      expect(result[1].impact).toBe("serious");
      expect(result[2].impact).toBe("moderate");
    });

    test("returns only id, impact, and count", () => {
      const result = formatMinimal(mockIssues);

      for (const issue of result) {
        expect(Object.keys(issue).sort()).toEqual(["count", "id", "impact"]);
      }
    });
  });

  describe("formatActionable", () => {
    test("includes selector and WCAG criterion", () => {
      const result = formatActionable(mockIssues);

      expect(result[0].selector).toBeDefined();
      expect(result[0].wcagCriterion).toBe("1.4.3");
    });

    test("extracts WCAG criterion from issue ID", () => {
      const result = formatActionable(mockIssues);

      const altIssue = result.find((r) => r.id.includes("1_1_1"));
      expect(altIssue?.wcagCriterion).toBe("1.1.1");

      const langIssue = result.find((r) => r.id.includes("3_1_1"));
      expect(langIssue?.wcagCriterion).toBe("3.1.1");
    });

    test("includes description", () => {
      const result = formatActionable(mockIssues);

      expect(result[0].description).toContain("contrast");
    });

    test("includes rule-level help text", () => {
      const result = formatActionable(mockIssues);

      const contrastIssue = result.find((r) => r.wcagCriterion === "1.4.3");
      expect(contrastIssue?.help).toBe("Color contrast must meet the minimum ratio.");
    });
  });

  describe("formatFixReady", () => {
    test("surfaces per-node failure summary when the engine provides one", () => {
      const result = formatFixReady(mockIssues);

      const contrastIssue = result.find((r) => r.selector === "#header > h1");
      expect(contrastIssue?.failureSummary).toContain("insufficient color contrast");
    });

    test("keeps separate entries for distinct elements with the same rule id", () => {
      const result = formatFixReady(mockIssues);

      const contrastIssues = result.filter((r) => r.wcagCriterion === "1.4.3");
      expect(contrastIssues).toHaveLength(2);
      expect(contrastIssues.map((issue) => issue.selector).sort()).toEqual([
        "#footer > p",
        "#header > h1",
      ]);
      expect(contrastIssues.every((issue) => issue.count === 1)).toBe(true);
    });

    test("still counts identical fix-ready entries together", () => {
      const identicalIssues: Issue[] = [mockIssues[0], { ...mockIssues[0] }];

      const result = formatFixReady(identicalIssues);
      expect(result).toHaveLength(1);
      expect(result[0].count).toBe(2);
      expect(result[0].failureSummary).toContain("insufficient color contrast");
    });

    test("failure summary is null when the engine did not provide one", () => {
      const issue: Issue[] = [
        {
          id: "unknown-rule",
          impact: "serious",
          description: "Some issue",
          help: "Help text",
          selector: "div",
          nodes: [{ html: "<div></div>" }],
        },
      ];

      const result = formatFixReady(issue);
      expect(result[0].failureSummary).toBeNull();
    });

    test("includes code snippet from nodes", () => {
      const result = formatFixReady(mockIssues);

      const contrastIssue = result.find((r) => r.selector === "#header > h1");
      expect(contrastIssue?.codeSnippet).toContain("<h1");
    });

    test("uses helpUrl verbatim as the documentation URL", () => {
      const result = formatFixReady(mockIssues);

      const contrastIssue = result.find((r) => r.selector === "#header > h1");
      expect(contrastIssue?.documentationUrl).toBe(
        "https://www.w3.org/WAI/WCAG21/quickref/#contrast-minimum"
      );
    });

    test("documentation URL is null when the engine did not provide one", () => {
      const issue: Issue[] = [
        {
          id: "unknown-rule",
          impact: "serious",
          description: "Some issue",
          help: "Help text",
          selector: "div",
          nodes: [{ html: "<div></div>" }],
        },
      ];

      const result = formatFixReady(issue);
      expect(result[0].documentationUrl).toBeNull();
    });
  });

  describe("formatIssues", () => {
    test("defaults to actionable format", () => {
      const result = formatIssues(mockIssues);
      const first = result[0] as { wcagCriterion?: string };
      expect(first.wcagCriterion).toBeDefined();
    });

    test("respects detail level parameter", () => {
      const minimal = formatIssues(mockIssues, "minimal");
      expect(Object.keys(minimal[0]).sort()).toEqual(["count", "id", "impact"]);

      const fixReady = formatIssues(mockIssues, "fix-ready");
      const first = fixReady[0] as { failureSummary?: string | null };
      expect(first).toHaveProperty("failureSummary");
    });
  });
});
