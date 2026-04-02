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
  });

  describe("formatFixReady", () => {
    test("includes suggested fix for known criteria", () => {
      const result = formatFixReady(mockIssues);

      const contrastIssue = result.find((r) => r.wcagCriterion === "1.4.3");
      expect(contrastIssue?.suggestedFix).toContain("contrast ratio");
      expect(contrastIssue?.suggestedFix).toContain("4.5:1");
    });

    test("includes code snippet from nodes", () => {
      const result = formatFixReady(mockIssues);

      const contrastIssue = result.find((r) => r.wcagCriterion === "1.4.3");
      expect(contrastIssue?.codeSnippet).toContain("<h1");
    });

    test("includes documentation URL", () => {
      const result = formatFixReady(mockIssues);

      const contrastIssue = result.find((r) => r.wcagCriterion === "1.4.3");
      expect(contrastIssue?.documentationUrl).toContain("w3.org");
    });

    test("provides generic fix for unknown criteria", () => {
      const unknownIssue: Issue[] = [
        {
          id: "unknown-rule",
          impact: "serious",
          description: "Some issue",
          help: "Help text",
          selector: "div",
          nodes: [{ html: "<div></div>" }],
        },
      ];

      const result = formatFixReady(unknownIssue);
      expect(result[0].suggestedFix).toContain("significantly impacts");
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
      const first = fixReady[0] as { suggestedFix?: string };
      expect(first.suggestedFix).toBeDefined();
    });
  });
});
