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

  it("keeps the hash an engine issue already had", () => {
    // A stored baseline must keep matching after the rendering condition
    // joined the identity: the literal is what this issue hashed to before.
    const issue = createIssue({
      id: "color-contrast",
      impact: "serious",
      selector: "button.submit",
      nodes: [{ html: '<button class="submit">Submit</button>' }],
    });

    expect(generateIssueHash(issue)).toBe("66d4a36d");
  });

  it("tells the same rendering finding under two conditions apart", () => {
    const clipped = (condition: string): Issue =>
      createIssue({
        id: "render:overflow-clipped-text",
        selector: "#intro",
        nodes: [{ html: '<p id="intro">Text</p>' }],
        rendering: {
          checkId: "overflow-clipped-text",
          condition,
          captureIndex: 0,
          evidence: { clippedBy: 24 },
        },
      });

    expect(generateIssueHash(clipped("viewport:320"))).not.toBe(
      generateIssueHash(clipped("text-spacing"))
    );
    expect(generateIssueHash(clipped("viewport:320"))).toBe(
      generateIssueHash(clipped("viewport:320"))
    );
  });

  it("is deterministic across multiple calls", () => {
    const issue = createIssue();
    const hashes = Array(10)
      .fill(null)
      .map(() => generateIssueHash(issue));

    expect(new Set(hashes).size).toBe(1);
  });
});
