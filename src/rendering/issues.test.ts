import { describe, expect, it } from "bun:test";
import { renderingIssues } from "./issues.js";
import type { RenderingFinding } from "./types.js";

function finding(overrides: Partial<RenderingFinding> = {}): RenderingFinding {
  return {
    checkId: "overlap-text",
    impact: "serious",
    description: "Two blocks of text overlap.",
    help: "Give text boxes room to grow.",
    helpUrl: "https://example.test/overlap",
    failureSummary: "The <p> overlaps the <h2>.",
    selector: "#a",
    html: "<p>",
    rect: { x: 10.4, y: 20.6, width: 30.2, height: 10.1 },
    elementIndex: 0,
    evidence: { overlapRatio: 0.5 },
    ...overrides,
  };
}

const CONTEXT = {
  condition: "viewport:320",
  captureIndex: 2,
  capture: { width: 320, height: 900 },
};

describe("renderingIssues", () => {
  it("makes an ordinary issue with the rendering metadata and a capture-space annotation", () => {
    const [issue] = renderingIssues([finding()], CONTEXT);

    expect(issue.id).toBe("render:overlap-text");
    expect(issue.impact).toBe("serious");
    expect(issue.selector).toBe("#a");
    expect(issue.nodes).toEqual([{ html: "<p>" }]);
    expect(issue.rendering).toEqual({
      checkId: "overlap-text",
      condition: "viewport:320",
      captureIndex: 2,
      evidence: { overlapRatio: 0.5 },
    });
    // Rounded outward, exactly as the page screenshot's rects are.
    expect(issue.annotation).toEqual({
      selector: "#a",
      state: "resolved",
      rect: { x: 10, y: 20, width: 31, height: 11 },
      mark: 1,
    });
  });

  it("numbers marks per capture in reading order, sharing one per element", () => {
    const issues = renderingIssues(
      [
        finding({
          selector: "#low",
          elementIndex: 1,
          rect: { x: 0, y: 400, width: 50, height: 20 },
        }),
        finding({
          selector: "#high",
          elementIndex: 2,
          rect: { x: 0, y: 10, width: 50, height: 20 },
        }),
        finding({
          checkId: "overflow-clipped-text",
          selector: "#low",
          elementIndex: 1,
          rect: { x: 0, y: 400, width: 50, height: 20 },
        }),
      ],
      CONTEXT
    );

    expect(issues.map((issue) => issue.annotation?.mark)).toEqual([2, 1, 2]);
  });

  it("gives every finding on one element the same rect as its mark", () => {
    // Findings carry their element's own rect, so these agree by
    // construction; a check that ever supplies something else must not move
    // the marker away from the place the numbering sorted it into.
    const issues = renderingIssues(
      [
        finding({
          selector: "#top",
          elementIndex: 0,
          rect: { x: 0, y: 10, width: 50, height: 20 },
        }),
        finding({
          selector: "#low",
          elementIndex: 1,
          rect: { x: 0, y: 400, width: 50, height: 20 },
        }),
        finding({
          checkId: "overlap-text",
          selector: "#low",
          elementIndex: 1,
          rect: { x: 0, y: 0, width: 10, height: 10 },
        }),
      ],
      CONTEXT
    );

    expect(issues.map((issue) => issue.annotation?.mark)).toEqual([1, 2, 2]);
    expect(issues[2].annotation?.rect).toEqual({ x: 0, y: 400, width: 50, height: 20 });
    expect(issues[1].annotation?.rect).toEqual(issues[2].annotation?.rect);
  });

  it("clips a rect to the capture and drops one that misses it entirely", () => {
    const [inside, outside] = renderingIssues(
      [
        finding({ elementIndex: 0, rect: { x: 300, y: 0, width: 80, height: 20 } }),
        finding({ elementIndex: 1, rect: { x: 0, y: 1000, width: 80, height: 20 } }),
      ],
      CONTEXT
    );

    expect(inside.annotation?.rect).toEqual({ x: 300, y: 0, width: 20, height: 20 });
    expect(outside.annotation).toEqual({ selector: "#a", state: "unresolved" });
  });

  it("marks a page-level finding as such and gives it no rect", () => {
    const [issue] = renderingIssues(
      [finding({ selector: "html", pageLevel: true, rect: undefined, elementIndex: undefined })],
      CONTEXT
    );

    expect(issue.annotation).toEqual({ selector: "html", state: "page" });
  });

  it("keeps the anchored flag", () => {
    const [issue] = renderingIssues([finding({ anchored: true })], CONTEXT);
    expect(issue.annotation?.anchored).toBe(true);
  });

  it("leaves findings unresolved when the capture size is unknown", () => {
    const [issue] = renderingIssues([finding()], { condition: "text-spacing", captureIndex: -1 });

    expect(issue.rendering?.captureIndex).toBe(-1);
    expect(issue.annotation).toEqual({ selector: "#a", state: "unresolved" });
  });
});
