import { describe, expect, it, mock } from "bun:test";
import type { Issue } from "../types.js";

let nextIssues: Issue[] = [];

mock.module("../audit.js", () => ({
  audit: async (url: string) => ({
    url,
    documentTitle: "Stub page",
    score: 72,
    severityLevel: "good",
    scoreInterpretation: {
      range: "70-94",
      level: "good",
      title: "Good",
      description: "Stub",
      action: "Stub",
      urgency: "low",
      recommendConsulting: false,
      color: "green",
    },
    issues: nextIssues,
    timestamp: new Date().toISOString(),
  }),
}));

const { runCli } = await import("./index.js");

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "color-contrast",
    impact: "serious",
    description: "Elements must have sufficient color contrast.",
    help: "Color contrast must meet the minimum ratio.",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
    selector: "#header > h1",
    nodes: [{ html: '<h1 style="color:#777">Header</h1>' }],
    ...overrides,
  };
}

describe("CLI fix-ready output", () => {
  it("prints rule help, failure summary, and docs", async () => {
    nextIssues = [
      makeIssue({
        failureSummary:
          "Fix any of the following:\n  Element has insufficient color contrast of 2.89",
      }),
    ];

    const result = await runCli({
      command: "audit",
      url: "https://example.com",
      detail: "fix-ready",
      headless: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Help: Color contrast must meet the minimum ratio.");
    expect(result.message).toContain("Fix any of the following:");
    expect(result.message).toContain("Element has insufficient color contrast of 2.89");
    expect(result.message).toContain("Docs: https://dequeuniversity.com/rules/axe/4.10/color-contrast");
  });

  it("keeps distinct elements separate when they share the same rule id", async () => {
    nextIssues = [
      makeIssue({
        selector: "#header > h1",
        nodes: [{ html: "<h1>Header</h1>" }],
        failureSummary: "Fix any of the following:\n  Contrast is 2.89",
      }),
      makeIssue({
        selector: "#footer > p",
        nodes: [{ html: "<p>Footer</p>" }],
        failureSummary: "Fix any of the following:\n  Contrast is 3.12",
      }),
    ];

    const result = await runCli({
      command: "audit",
      url: "https://example.com",
      detail: "fix-ready",
      headless: true,
    });

    expect(result.message).toContain("Element: #header > h1");
    expect(result.message).toContain("Element: #footer > p");
    expect(result.message).toContain("Contrast is 2.89");
    expect(result.message).toContain("Contrast is 3.12");
    expect(result.message).toContain("2 issues found");
  });
});
