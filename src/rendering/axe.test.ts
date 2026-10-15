/**
 * The naming and keying half of the condition's axe run: what the browser
 * returned becomes nodes with the engine pass's own selector spelling, one
 * identity per element, and the baseline flag the mode-specific check reads.
 * No browser — the in-page half is covered by the integration tests.
 */

import { describe, expect, it } from "bun:test";
import type { Issue } from "../types.js";
import { assembleAxeRun, baselineKey, type RawAxeResult, renderingAxeBaseline } from "./axe.js";

function result(overrides: Partial<RawAxeResult> = {}): RawAxeResult {
  return {
    id: "color-contrast",
    outcome: "violation",
    description: "Ensure contrast",
    help: "Elements must meet minimum color contrast ratio thresholds",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.11/color-contrast",
    impact: "serious",
    nodes: [
      {
        target: ["#link"],
        html: "<a>",
        impact: "serious",
        failureSummary: "Element has insufficient color contrast",
        rect: { x: 1, y: 2, width: 30, height: 10 },
      },
    ],
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "color-contrast",
    impact: "serious",
    description: "Ensure contrast",
    help: "Help",
    helpUrl: "https://example.test/",
    selector: "#link",
    nodes: [],
    ...overrides,
  };
}

describe("renderingAxeBaseline", () => {
  it("keys the engine pass by rule and selector", () => {
    const baseline = renderingAxeBaseline([issue(), issue({ id: "link-name", selector: "a.cta" })]);

    expect(baseline.has(baselineKey("color-contrast", "#link"))).toBe(true);
    expect(baseline.has(baselineKey("link-name", "a.cta"))).toBe(true);
    // Same rule, other element, and the other way round.
    expect(baseline.has(baselineKey("color-contrast", "a.cta"))).toBe(false);
    expect(baseline.has(baselineKey("link-name", "#link"))).toBe(false);
  });

  it("ignores rendering findings: they are not what the page already failed", () => {
    const baseline = renderingAxeBaseline([
      issue({
        id: "render:contrast-under-mode",
        selector: "#link",
        rendering: {
          checkId: "contrast-under-mode",
          condition: "media:dark",
          captureIndex: 0,
          evidence: {},
        },
      }),
    ]);

    expect(baseline.size).toBe(0);
  });
});

describe("assembleAxeRun", () => {
  it("flattens the target the way the engine pass does", () => {
    const run = assembleAxeRun(
      [result({ nodes: [{ target: ["#dialog", "#close"], html: "<button>", impact: null }] })],
      { rules: ["color-contrast"], indexOffset: 0 }
    );

    expect(run.rules).toEqual(["color-contrast"]);
    expect(run.results[0].nodes[0].selector).toBe("#dialog > #close");
    // No impact on the node: the rule's own is used.
    expect(run.results[0].nodes[0].impact).toBe("serious");
    // A node the browser could not resolve to an element carries no rect.
    expect(run.results[0].nodes[0].rect).toBeUndefined();
  });

  it("keeps the rect and the anchoring the browser measured", () => {
    const run = assembleAxeRun([result()], { rules: ["color-contrast"], indexOffset: 0 });

    // The box of the element, in the condition's capture space: without it
    // the finding cannot be drawn on the capture at all.
    expect(run.results[0].nodes[0].rect).toEqual({ x: 1, y: 2, width: 30, height: 10 });

    const anchored = assembleAxeRun(
      [
        result({
          nodes: [
            {
              target: ["#sticky"],
              html: "<a>",
              impact: "serious",
              rect: { x: 0, y: 4, width: 20, height: 8 },
              anchored: true,
            },
          ],
        }),
      ],
      { rules: ["color-contrast"], indexOffset: 0 }
    );
    expect(anchored.results[0].nodes[0].rect).toEqual({ x: 0, y: 4, width: 20, height: 8 });
    expect(anchored.results[0].nodes[0].anchored).toBe(true);
  });

  it("carries the text-fill mismatch the browser found through to the check", () => {
    // What tells a contrast failure forced colours introduced from one axe
    // measured on a colour the browser does not paint. Dropping the flag
    // here would restore the false findings the check exists to suppress.
    const run = assembleAxeRun(
      [
        result({
          nodes: [
            { target: ["#forced"], html: "<a>", impact: "serious", textFillMismatch: true },
            { target: ["#plain"], html: "<a>", impact: "serious" },
          ],
        }),
      ],
      { rules: ["color-contrast"], indexOffset: 0 }
    );

    expect(run.results[0].nodes.map((node) => node.textFillMismatch)).toEqual([true, undefined]);
  });

  it("reports a rule whose eligible nodes did not fit the cap", () => {
    const run = assembleAxeRun(
      [result({ truncated: true }), result({ id: "link-in-text-block" })],
      {
        rules: ["color-contrast", "link-in-text-block"],
        indexOffset: 0,
      }
    );

    expect(run.results.map((entry) => entry.truncated)).toEqual([true, undefined]);
    // One partial rule makes the condition's findings partial.
    expect(run.truncated).toBe(true);

    const whole = assembleAxeRun([result()], { rules: ["color-contrast"], indexOffset: 0 });
    expect(whole.truncated).toBeUndefined();
  });

  it("numbers nodes from the offset and gives one element one identity", () => {
    const run = assembleAxeRun(
      [
        result(),
        result({
          id: "link-in-text-block",
          nodes: [
            { target: ["#link"], html: "<a>", impact: "serious" },
            { target: ["#other"], html: "<a>", impact: "serious" },
          ],
        }),
      ],
      { rules: ["color-contrast", "link-in-text-block"], indexOffset: 7 }
    );

    const [contrast, links] = run.results;
    expect(contrast.nodes[0].index).toBe(7);
    // The same element in the second rule keeps the first identity, so both
    // findings share one mark on the capture.
    expect(links.nodes[0].index).toBe(7);
    expect(links.nodes[1].index).toBe(8);
  });

  it("flags the nodes the baseline already has", () => {
    const baseline = renderingAxeBaseline([issue()]);
    const run = assembleAxeRun(
      [
        result({
          nodes: [
            { target: ["#link"], html: "<a>", impact: "serious" },
            { target: ["#fresh"], html: "<a>", impact: "serious" },
          ],
        }),
      ],
      { rules: ["color-contrast"], indexOffset: 0, baseline }
    );

    expect(run.results[0].nodes.map((node) => node.inBaseline)).toEqual([true, false]);
  });

  it("marks nothing as known without a baseline", () => {
    const run = assembleAxeRun([result()], { rules: ["color-contrast"], indexOffset: 0 });
    expect(run.results[0].nodes[0].inBaseline).toBe(false);
  });
});
