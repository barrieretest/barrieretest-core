import { describe, expect, test } from "bun:test";
import { transformAxeViolation, type AxeViolation } from "./axe.js";

const createViolation = (overrides: Partial<AxeViolation> = {}): AxeViolation => ({
  id: "color-contrast",
  impact: "serious",
  description: "Elements must have sufficient color contrast",
  help: "Ensures the contrast between foreground and background colors meets WCAG 2 AA",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
  nodes: [
    {
      html: '<span style="color: #aaa">Low contrast text</span>',
      impact: "serious",
      target: ["#main > .content > span"],
    },
  ],
  ...overrides,
});

describe("transformAxeViolation", () => {
  test("maps basic violation fields correctly", () => {
    const violation = createViolation();
    const issues = transformAxeViolation(violation);

    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe("color-contrast");
    expect(issues[0].impact).toBe("serious");
    expect(issues[0].description).toBe("Elements must have sufficient color contrast");
    expect(issues[0].help).toBe(
      "Ensures the contrast between foreground and background colors meets WCAG 2 AA"
    );
    expect(issues[0].helpUrl).toBe(
      "https://dequeuniversity.com/rules/axe/4.10/color-contrast"
    );
  });

  test("maps impact directly — critical", () => {
    const issues = transformAxeViolation(createViolation({ impact: "critical" }));
    expect(issues[0].impact).toBe("critical");
  });

  test("maps impact directly — serious", () => {
    const issues = transformAxeViolation(createViolation({ impact: "serious" }));
    expect(issues[0].impact).toBe("serious");
  });

  test("maps impact directly — moderate", () => {
    const issues = transformAxeViolation(createViolation({ impact: "moderate" }));
    expect(issues[0].impact).toBe("moderate");
  });

  test("maps impact directly — minor", () => {
    const issues = transformAxeViolation(createViolation({ impact: "minor" }));
    expect(issues[0].impact).toBe("minor");
  });

  test("handles null impact → moderate", () => {
    const issues = transformAxeViolation(createViolation({ impact: null }));
    expect(issues[0].impact).toBe("moderate");
  });

  test("handles undefined impact → moderate", () => {
    const issues = transformAxeViolation(createViolation({ impact: undefined }));
    expect(issues[0].impact).toBe("moderate");
  });

  test("produces one Issue per node in a violation", () => {
    const violation = createViolation({
      nodes: [
        { html: "<img>", impact: "critical", target: ["img:nth-child(1)"] },
        { html: '<img alt="">', impact: "critical", target: ["img:nth-child(2)"] },
        { html: '<img src="logo.png">', impact: "critical", target: ["img:nth-child(3)"] },
      ],
    });

    const issues = transformAxeViolation(violation);
    expect(issues).toHaveLength(3);
    expect(issues[0].nodes[0].html).toBe("<img>");
    expect(issues[1].nodes[0].html).toBe('<img alt="">');
    expect(issues[2].nodes[0].html).toBe('<img src="logo.png">');
  });

  test("extracts target[0] as selector (simple string)", () => {
    const violation = createViolation({
      nodes: [{ html: "<div></div>", target: [".content > div"] }],
    });

    const issues = transformAxeViolation(violation);
    expect(issues[0].selector).toBe(".content > div");
  });

  test("handles nested frame selectors (array of arrays)", () => {
    const violation = createViolation({
      nodes: [
        {
          html: "<input>",
          target: [["#iframe1", "#iframe2"], "input.field"],
        },
      ],
    });

    const issues = transformAxeViolation(violation);
    expect(issues[0].selector).toBe("#iframe1 > #iframe2 > input.field");
  });

  test("handles empty nodes array", () => {
    const violation = createViolation({ nodes: [] });
    const issues = transformAxeViolation(violation);

    expect(issues).toHaveLength(1);
    expect(issues[0].selector).toBeNull();
    expect(issues[0].nodes).toEqual([]);
  });

  test("each issue gets its own nodes array with html", () => {
    const violation = createViolation({
      nodes: [
        { html: "<a href></a>", target: ["a.link1"] },
        { html: "<a></a>", target: ["a.link2"] },
      ],
    });

    const issues = transformAxeViolation(violation);

    expect(issues[0].nodes).toEqual([{ html: "<a href></a>" }]);
    expect(issues[1].nodes).toEqual([{ html: "<a></a>" }]);
  });

  test("propagates per-node failureSummary onto the resulting Issue", () => {
    const violation = createViolation({
      nodes: [
        {
          html: "<span></span>",
          target: ["span"],
          failureSummary:
            "Fix any of the following:\n  Element has insufficient color contrast of 2.89",
        },
      ],
    });

    const issues = transformAxeViolation(violation);
    expect(issues[0].failureSummary).toContain("insufficient color contrast");
  });

  test("leaves failureSummary undefined when the node did not provide one", () => {
    const violation = createViolation({
      nodes: [{ html: "<span></span>", target: ["span"] }],
    });

    const issues = transformAxeViolation(violation);
    expect(issues[0].failureSummary).toBeUndefined();
  });

  test("all issues from same violation share the same rule metadata", () => {
    const violation = createViolation({
      id: "image-alt",
      description: "Images must have alternative text",
      nodes: [
        { html: "<img>", target: ["img:nth-child(1)"] },
        { html: '<img src="x">', target: ["img:nth-child(2)"] },
      ],
    });

    const issues = transformAxeViolation(violation);

    for (const issue of issues) {
      expect(issue.id).toBe("image-alt");
      expect(issue.description).toBe("Images must have alternative text");
    }
  });
});
