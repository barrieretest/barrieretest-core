import { describe, expect, it } from "bun:test";
import type { BaselineFile, BaselineIssue } from "./types";
import { BASELINE_VERSION, isValidBaselineFile } from "./types";

describe("BaselineFile", () => {
  it("has required structure", () => {
    const baseline: BaselineFile = {
      version: 1,
      created: "2026-01-27T10:00:00Z",
      updated: "2026-01-27T10:00:00Z",
      url: "https://example.com",
      issues: [],
    };

    expect(baseline.version).toBe(1);
    expect(baseline.created).toBe("2026-01-27T10:00:00Z");
    expect(baseline.updated).toBe("2026-01-27T10:00:00Z");
    expect(baseline.url).toBe("https://example.com");
    expect(baseline.issues).toEqual([]);
  });

  it("contains baseline issues", () => {
    const issue: BaselineIssue = {
      rule: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
      selector: "button.submit",
      hash: "abc123",
    };

    const baseline: BaselineFile = {
      version: 1,
      created: "2026-01-27T10:00:00Z",
      updated: "2026-01-27T10:00:00Z",
      url: "https://example.com",
      issues: [issue],
    };

    expect(baseline.issues).toHaveLength(1);
    expect(baseline.issues[0].rule).toBe("WCAG2AA.Principle1.Guideline1_4.1_4_3");
    expect(baseline.issues[0].selector).toBe("button.submit");
    expect(baseline.issues[0].hash).toBe("abc123");
  });
});

describe("BaselineIssue", () => {
  it("has required fields", () => {
    const issue: BaselineIssue = {
      rule: "WCAG2AA.Principle1.Guideline1_1",
      selector: "img.hero",
      hash: "def456",
    };

    expect(issue.rule).toBe("WCAG2AA.Principle1.Guideline1_1");
    expect(issue.selector).toBe("img.hero");
    expect(issue.hash).toBe("def456");
  });

  it("allows null selector for global issues", () => {
    const issue: BaselineIssue = {
      rule: "WCAG2AA.Principle3.Guideline3_1",
      selector: null,
      hash: "ghi789",
    };

    expect(issue.selector).toBeNull();
  });
});

describe("BASELINE_VERSION", () => {
  it("is version 1", () => {
    expect(BASELINE_VERSION).toBe(1);
  });
});

describe("isValidBaselineFile", () => {
  it("returns true for valid baseline file", () => {
    const baseline = {
      version: 1,
      created: "2026-01-27T10:00:00Z",
      updated: "2026-01-27T10:00:00Z",
      url: "https://example.com",
      issues: [],
    };

    expect(isValidBaselineFile(baseline)).toBe(true);
  });

  it("returns false for missing version", () => {
    const invalid = {
      created: "2026-01-27T10:00:00Z",
      updated: "2026-01-27T10:00:00Z",
      url: "https://example.com",
      issues: [],
    };

    expect(isValidBaselineFile(invalid)).toBe(false);
  });

  it("returns false for wrong version", () => {
    const invalid = {
      version: 2,
      created: "2026-01-27T10:00:00Z",
      updated: "2026-01-27T10:00:00Z",
      url: "https://example.com",
      issues: [],
    };

    expect(isValidBaselineFile(invalid)).toBe(false);
  });

  it("returns false for missing url", () => {
    const invalid = {
      version: 1,
      created: "2026-01-27T10:00:00Z",
      updated: "2026-01-27T10:00:00Z",
      issues: [],
    };

    expect(isValidBaselineFile(invalid)).toBe(false);
  });

  it("returns false for non-object input", () => {
    expect(isValidBaselineFile(null)).toBe(false);
    expect(isValidBaselineFile(undefined)).toBe(false);
    expect(isValidBaselineFile("string")).toBe(false);
    expect(isValidBaselineFile(123)).toBe(false);
  });

  it("returns false for missing issues array", () => {
    const invalid = {
      version: 1,
      created: "2026-01-27T10:00:00Z",
      updated: "2026-01-27T10:00:00Z",
      url: "https://example.com",
    };

    expect(isValidBaselineFile(invalid)).toBe(false);
  });
});
