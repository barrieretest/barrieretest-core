import { describe, expect, it } from "bun:test";
import type { Issue } from "../types";
import { diffAgainstBaseline } from "./diff";
import { generateIssueHash } from "./hash";
import type { BaselineFile, BaselineIssue } from "./types";

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
  impact: "critical",
  description: "Contrast issue",
  help: "Fix the contrast",
  selector: "button.submit",
  nodes: [{ html: '<button class="submit">Submit</button>' }],
  ...overrides,
});

const createBaselineIssue = (issue: Issue): BaselineIssue => ({
  rule: issue.id,
  selector: issue.selector,
  hash: generateIssueHash(issue),
});

const createBaseline = (issues: BaselineIssue[] = []): BaselineFile => ({
  version: 1,
  created: "2026-01-27T10:00:00Z",
  updated: "2026-01-27T10:00:00Z",
  url: "https://example.com",
  issues,
});

describe("diffAgainstBaseline", () => {
  it("returns all issues as new when baseline is empty", () => {
    const issues = [createIssue()];
    const baseline = createBaseline([]);

    const result = diffAgainstBaseline(issues, baseline);

    expect(result.new).toHaveLength(1);
    expect(result.known).toHaveLength(0);
    expect(result.fixed).toHaveLength(0);
  });

  it("returns all issues as known when all are in baseline", () => {
    const issue = createIssue();
    const issues = [issue];
    const baseline = createBaseline([createBaselineIssue(issue)]);

    const result = diffAgainstBaseline(issues, baseline);

    expect(result.new).toHaveLength(0);
    expect(result.known).toHaveLength(1);
    expect(result.fixed).toHaveLength(0);
  });

  it("identifies fixed issues (in baseline but not in current)", () => {
    const issue = createIssue();
    const baseline = createBaseline([createBaselineIssue(issue)]);

    const result = diffAgainstBaseline([], baseline);

    expect(result.new).toHaveLength(0);
    expect(result.known).toHaveLength(0);
    expect(result.fixed).toHaveLength(1);
    expect(result.fixed[0].rule).toBe(issue.id);
  });

  it("handles mixed results correctly", () => {
    const knownIssue = createIssue({ selector: "button.known" });
    const newIssue = createIssue({ selector: "button.new" });
    const fixedIssue = createIssue({ selector: "button.fixed" });

    const currentIssues = [knownIssue, newIssue];
    const baseline = createBaseline([
      createBaselineIssue(knownIssue),
      createBaselineIssue(fixedIssue),
    ]);

    const result = diffAgainstBaseline(currentIssues, baseline);

    expect(result.new).toHaveLength(1);
    expect(result.new[0].selector).toBe("button.new");

    expect(result.known).toHaveLength(1);
    expect(result.known[0].selector).toBe("button.known");

    expect(result.fixed).toHaveLength(1);
    expect(result.fixed[0].selector).toBe("button.fixed");
  });

  it("returns empty arrays when no issues and empty baseline", () => {
    const result = diffAgainstBaseline([], createBaseline([]));

    expect(result.new).toHaveLength(0);
    expect(result.known).toHaveLength(0);
    expect(result.fixed).toHaveLength(0);
  });

  it("matches issues by hash, not by reference", () => {
    const issue1 = createIssue({ id: "rule1", selector: "#elem" });
    const issue2 = createIssue({ id: "rule1", selector: "#elem" }); // Same data, different object

    const baseline = createBaseline([createBaselineIssue(issue1)]);
    const result = diffAgainstBaseline([issue2], baseline);

    expect(result.new).toHaveLength(0);
    expect(result.known).toHaveLength(1);
  });

  it("handles multiple issues with same rule but different selectors", () => {
    const issue1 = createIssue({ id: "same-rule", selector: "#elem1" });
    const issue2 = createIssue({ id: "same-rule", selector: "#elem2" });
    const issue3 = createIssue({ id: "same-rule", selector: "#elem3" });

    const baseline = createBaseline([createBaselineIssue(issue1), createBaselineIssue(issue2)]);

    const result = diffAgainstBaseline([issue1, issue3], baseline);

    expect(result.new).toHaveLength(1);
    expect(result.new[0].selector).toBe("#elem3");

    expect(result.known).toHaveLength(1);
    expect(result.known[0].selector).toBe("#elem1");

    expect(result.fixed).toHaveLength(1);
    expect(result.fixed[0].selector).toBe("#elem2");
  });
});
