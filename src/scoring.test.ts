import { describe, expect, it } from "bun:test";
import type { Pa11yIssue } from "./engines/pa11y";
import {
  calculateScore,
  getScoreInterpretation,
  getSeverityLevel,
  SEVERITY_THRESHOLDS,
  shouldFilterPa11yIssue,
  transformPa11yIssue,
} from "./scoring";

describe("calculateScore", () => {
  it("returns 100 for no issues", () => {
    expect(calculateScore([])).toBe(100);
  });

  it("deducts 26 points for critical issues", () => {
    const issues = [{ id: "test", impact: "critical" }];
    expect(calculateScore(issues)).toBe(74);
  });

  it("deducts 10 points for serious issues", () => {
    const issues = [{ id: "test", impact: "serious" }];
    expect(calculateScore(issues)).toBe(90);
  });

  it("deducts 3 points for moderate issues", () => {
    const issues = [{ id: "test", impact: "moderate" }];
    expect(calculateScore(issues)).toBe(97);
  });

  it("applies diminishing returns after 2 occurrences", () => {
    const issues = [
      { id: "same-issue", impact: "critical" },
      { id: "same-issue", impact: "critical" },
      { id: "same-issue", impact: "critical" }, // This should be 50% = 13 points
    ];
    // 100 - 26 - 26 - 13 = 35
    expect(calculateScore(issues)).toBe(35);
  });

  it("has a floor of 5 for many issues", () => {
    const issues = Array(50).fill({ id: "test", impact: "critical" });
    expect(calculateScore(issues)).toBe(5);
  });

  it("has a floor of 1 for more than 100 issues", () => {
    const issues = Array(101).fill({ id: "test", impact: "critical" });
    expect(calculateScore(issues)).toBe(1);
  });

  it("handles type field as fallback for impact", () => {
    const issues = [{ code: "test", type: "error" }];
    expect(calculateScore(issues)).toBe(74); // error maps to critical
  });
});

describe("getSeverityLevel", () => {
  it("returns excellent for scores >= 95", () => {
    expect(getSeverityLevel(95)).toBe("excellent");
    expect(getSeverityLevel(100)).toBe("excellent");
  });

  it("returns good for scores 70-94", () => {
    expect(getSeverityLevel(70)).toBe("good");
    expect(getSeverityLevel(94)).toBe("good");
  });

  it("returns needs-improvement for scores 40-69", () => {
    expect(getSeverityLevel(40)).toBe("needs-improvement");
    expect(getSeverityLevel(69)).toBe("needs-improvement");
  });

  it("returns critical for scores 15-39", () => {
    expect(getSeverityLevel(15)).toBe("critical");
    expect(getSeverityLevel(39)).toBe("critical");
  });

  it("returns severe for scores < 15", () => {
    expect(getSeverityLevel(0)).toBe("severe");
    expect(getSeverityLevel(14)).toBe("severe");
  });
});

describe("getScoreInterpretation", () => {
  it("returns interpretation with all required fields", () => {
    const interpretation = getScoreInterpretation(80);
    expect(interpretation).toHaveProperty("range");
    expect(interpretation).toHaveProperty("level");
    expect(interpretation).toHaveProperty("title");
    expect(interpretation).toHaveProperty("description");
    expect(interpretation).toHaveProperty("action");
    expect(interpretation).toHaveProperty("urgency");
    expect(interpretation).toHaveProperty("recommendConsulting");
    expect(interpretation).toHaveProperty("color");
  });

  it("recommends consulting for low scores", () => {
    expect(getScoreInterpretation(30).recommendConsulting).toBe(true);
    expect(getScoreInterpretation(50).recommendConsulting).toBe(true);
  });

  it("does not recommend consulting for high scores", () => {
    expect(getScoreInterpretation(95).recommendConsulting).toBe(false);
    expect(getScoreInterpretation(80).recommendConsulting).toBe(false);
  });
});

describe("shouldFilterPa11yIssue", () => {
  it("filters contrast issues on aria-hidden elements", () => {
    const issue = {
      code: "WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail",
      type: "error",
      message: "Contrast issue",
      context: '<span aria-hidden="true">Hidden</span>',
      selector: "span",
    } as Pa11yIssue;
    expect(shouldFilterPa11yIssue(issue)).toBe(true);
  });

  it("does not filter contrast issues on visible elements", () => {
    const issue = {
      code: "WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail",
      type: "error",
      message: "Contrast issue",
      context: "<span>Visible</span>",
      selector: "span",
    } as Pa11yIssue;
    expect(shouldFilterPa11yIssue(issue)).toBe(false);
  });

  it("does not filter non-contrast issues", () => {
    const issue = {
      code: "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37",
      type: "error",
      message: "Missing alt text",
      context: '<img aria-hidden="true">',
      selector: "img",
    } as Pa11yIssue;
    expect(shouldFilterPa11yIssue(issue)).toBe(false);
  });
});

describe("transformPa11yIssue", () => {
  it("transforms error type to critical impact", () => {
    const issue = {
      code: "WCAG2AA.test",
      type: "error",
      message: "Test message",
      context: "<div>test</div>",
      selector: "div",
    } as Pa11yIssue;
    const transformed = transformPa11yIssue(issue);
    expect(transformed.impact).toBe("critical");
  });

  it("transforms warning type to serious impact", () => {
    const issue = {
      code: "WCAG2AA.test",
      type: "warning",
      message: "Test message",
      context: "<div>test</div>",
      selector: "div",
    } as Pa11yIssue;
    const transformed = transformPa11yIssue(issue);
    expect(transformed.impact).toBe("serious");
  });

  it("transforms notice type to moderate impact", () => {
    const issue = {
      code: "WCAG2AA.test",
      type: "notice",
      message: "Test message",
      context: "<div>test</div>",
      selector: "div",
    } as Pa11yIssue;
    const transformed = transformPa11yIssue(issue);
    expect(transformed.impact).toBe("moderate");
  });

  it("generates helpUrl for WCAG2AA codes", () => {
    const issue = {
      code: "WCAG2AA.Principle1.Guideline1_1",
      type: "error",
      message: "Test",
      context: "",
      selector: "",
    } as Pa11yIssue;
    const transformed = transformPa11yIssue(issue);
    expect(transformed.helpUrl).toContain("w3.org/WAI/WCAG21/quickref");
  });

  it("preserves selector and context", () => {
    const issue = {
      code: "test",
      type: "error",
      message: "Test message",
      context: "<button>Click</button>",
      selector: "button.submit",
    } as Pa11yIssue;
    const transformed = transformPa11yIssue(issue);
    expect(transformed.selector).toBe("button.submit");
    expect(transformed.nodes[0].html).toBe("<button>Click</button>");
  });
});

describe("SEVERITY_THRESHOLDS", () => {
  it("has correct threshold values", () => {
    expect(SEVERITY_THRESHOLDS.EXCELLENT).toBe(95);
    expect(SEVERITY_THRESHOLDS.GOOD).toBe(70);
    expect(SEVERITY_THRESHOLDS.NEEDS_IMPROVEMENT).toBe(40);
    expect(SEVERITY_THRESHOLDS.CRITICAL).toBe(15);
  });
});
