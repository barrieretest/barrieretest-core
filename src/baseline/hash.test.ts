import { describe, expect, it } from "bun:test";
import type { Issue } from "../types";
import { generateIssueHash } from "./hash";

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
  impact: "critical",
  description: "Contrast issue",
  help: "Fix the contrast",
  selector: "button.submit",
  nodes: [{ html: '<button class="submit">Submit</button>' }],
  ...overrides,
});

describe("generateIssueHash", () => {
  it("generates a hash string", () => {
    const issue = createIssue();
    const hash = generateIssueHash(issue);

    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("generates same hash for same issue", () => {
    const issue1 = createIssue();
    const issue2 = createIssue();

    expect(generateIssueHash(issue1)).toBe(generateIssueHash(issue2));
  });

  it("generates different hash for different rule", () => {
    const issue1 = createIssue({ id: "WCAG2AA.Principle1.Guideline1_1" });
    const issue2 = createIssue({ id: "WCAG2AA.Principle1.Guideline1_4" });

    expect(generateIssueHash(issue1)).not.toBe(generateIssueHash(issue2));
  });

  it("generates different hash for different selector", () => {
    const issue1 = createIssue({ selector: "button.submit" });
    const issue2 = createIssue({ selector: "button.cancel" });

    expect(generateIssueHash(issue1)).not.toBe(generateIssueHash(issue2));
  });

  it("is stable across minor DOM changes", () => {
    const issue1 = createIssue({
      nodes: [{ html: '<button class="submit">Submit</button>' }],
    });
    const issue2 = createIssue({
      nodes: [{ html: '<button class="submit" >Submit</button>' }], // Extra space
    });

    // Hash should be based on rule + selector, not exact HTML
    expect(generateIssueHash(issue1)).toBe(generateIssueHash(issue2));
  });

  it("handles null selector", () => {
    const issue = createIssue({ selector: null });
    const hash = generateIssueHash(issue);

    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("includes element context in hash for stability", () => {
    // Two issues with same rule and selector but different element type
    const issue1 = createIssue({
      selector: "#main",
      nodes: [{ html: '<div id="main">Content</div>' }],
    });
    const issue2 = createIssue({
      selector: "#main",
      nodes: [{ html: '<section id="main">Content</section>' }],
    });

    // Should be different because element type differs
    expect(generateIssueHash(issue1)).not.toBe(generateIssueHash(issue2));
  });

  it("is deterministic across multiple calls", () => {
    const issue = createIssue();
    const hashes = Array(10)
      .fill(null)
      .map(() => generateIssueHash(issue));

    expect(new Set(hashes).size).toBe(1);
  });
});
