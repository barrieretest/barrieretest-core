/**
 * Checks are pure functions of a measurement, so these fixtures are written
 * by hand: no browser, and a false positive can be reproduced from the
 * numbers alone.
 */

import { describe, expect, it } from "bun:test";
import { contentHiddenAtViewportCheck } from "./checks/content-hidden-at-viewport.js";
import { CONTRAST_RULES, contrastUnderModeCheck } from "./checks/contrast-under-mode.js";
import { cvdLinkDistinctionCheck } from "./checks/cvd-link-distinction.js";
import { cvdStateByColorCheck } from "./checks/cvd-state-by-color.js";
import { forcedColorsLossCheck } from "./checks/forced-colors-loss.js";
import { motionNotReducedCheck } from "./checks/motion-not-reduced.js";
import { overflowClippedTextCheck } from "./checks/overflow-clipped-text.js";
import { overlapTextCheck } from "./checks/overlap-text.js";
import { reflowHorizontalScrollCheck } from "./checks/reflow-horizontal-scroll.js";
import { targetSizeCheck } from "./checks/target-size.js";
import { resolveCondition } from "./conditions.js";
import type {
  ElementClipping,
  RenderingAnimation,
  RenderingAxeNode,
  RenderingAxeResult,
  RenderingElement,
  RenderingLink,
  RenderingMeasurement,
  RenderingMotion,
  RenderingPaintedElement,
  RenderingStatePair,
  RenderingStateStyle,
  RenderingTextStyle,
} from "./types.js";

let nextIndex = 0;

function element(overrides: Partial<RenderingElement> = {}): RenderingElement {
  const index = overrides.index ?? nextIndex++;
  return {
    index,
    selector: `#e${index}`,
    html: "<p>",
    tag: "p",
    role: null,
    text: "Some text",
    rect: { x: 0, y: 0, width: 100, height: 20 },
    hasText: true,
    hasContentText: true,
    rendered: true,
    anchored: false,
    exempt: false,
    clipped: false,
    parentIndex: -1,
    revealable: false,
    inRenderedControl: false,
    ...overrides,
  };
}

function clipping(overrides: Partial<ElementClipping> = {}): ElementClipping {
  return {
    overflowX: "visible",
    overflowY: "hidden",
    textOverflow: "clip",
    whiteSpace: "normal",
    lineHeight: 24,
    scrollWidth: 300,
    scrollHeight: 72,
    clientWidth: 300,
    clientHeight: 24,
    ...overrides,
  };
}

function measurement(
  elements: RenderingElement[],
  overrides: Partial<RenderingMeasurement> = {}
): RenderingMeasurement {
  const width = overrides.viewport?.width ?? 320;
  return {
    elements,
    truncated: false,
    devicePixelRatio: 1,
    viewport: { width, height: 720 },
    document: { width, height: 2000 },
    client: { width, height: 720 },
    scroll: { x: 0, y: 0 },
    ...overrides,
  };
}

const VIEWPORT_320 = resolveCondition("viewport:320");
const VIEWPORT_360 = resolveCondition("viewport:360");
const VIEWPORT_1280 = resolveCondition("viewport:1280");
const TEXT_SPACING = resolveCondition("text-spacing");
const COMPOSITE = resolveCondition("viewport:320+text-spacing");

describe("reflow-horizontal-scroll", () => {
  it("runs under 320 px and the composite, not under wider viewports or text spacing alone", () => {
    expect(reflowHorizontalScrollCheck.appliesTo(VIEWPORT_320)).toBe(true);
    expect(reflowHorizontalScrollCheck.appliesTo(COMPOSITE)).toBe(true);
    expect(reflowHorizontalScrollCheck.appliesTo(VIEWPORT_360)).toBe(false);
    expect(reflowHorizontalScrollCheck.appliesTo(TEXT_SPACING)).toBe(false);
  });

  it("reports the element that extends past the viewport", () => {
    const wide = element({ tag: "div", rect: { x: 0, y: 40, width: 400, height: 60 } });
    const findings = reflowHorizontalScrollCheck.evaluate({
      condition: VIEWPORT_320,
      measurement: measurement([wide], { document: { width: 400, height: 2000 } }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].impact).toBe("serious");
    expect(findings[0].selector).toBe(wide.selector);
    expect(findings[0].rect).toEqual(wide.rect);
    expect(findings[0].evidence).toEqual({
      overflowBy: 80,
      viewportWidth: 320,
      scrollWidth: 400,
      elementRight: 400,
    });
  });

  it("exempts content that requires two-dimensional layout, document scroll included", () => {
    const table = element({
      tag: "table",
      exempt: true,
      rect: { x: 0, y: 0, width: 600, height: 200 },
    });
    expect(
      reflowHorizontalScrollCheck.evaluate({
        condition: VIEWPORT_320,
        // The table makes the document scroll; the exemption covers that too.
        measurement: measurement([table], { document: { width: 600, height: 2000 } }),
      })
    ).toEqual([]);
  });

  it("ignores overflow an ancestor clips away", () => {
    const drawer = element({ clipped: true, rect: { x: 320, y: 0, width: 320, height: 400 } });
    expect(
      reflowHorizontalScrollCheck.evaluate({
        condition: VIEWPORT_320,
        measurement: measurement([drawer]),
      })
    ).toEqual([]);
  });

  it("reports only the outermost offender", () => {
    const parent = element({ index: 0, rect: { x: 0, y: 0, width: 500, height: 200 } });
    const child = element({
      index: 1,
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 480, height: 60 },
    });
    const grandchild = element({
      index: 2,
      parentIndex: 1,
      rect: { x: 0, y: 0, width: 460, height: 20 },
    });

    const findings = reflowHorizontalScrollCheck.evaluate({
      condition: VIEWPORT_320,
      measurement: measurement([parent, child, grandchild]),
    });

    expect(findings.map((finding) => finding.selector)).toEqual([parent.selector]);
  });

  it("reports the document itself when no element accounts for the scroll", () => {
    const findings = reflowHorizontalScrollCheck.evaluate({
      condition: VIEWPORT_320,
      measurement: measurement([element()], { document: { width: 420, height: 2000 } }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].selector).toBe("html");
    expect(findings[0].pageLevel).toBe(true);
    expect(findings[0].evidence).toEqual({ scrollWidth: 420, clientWidth: 320 });
  });

  it("finds nothing when everything fits", () => {
    expect(
      reflowHorizontalScrollCheck.evaluate({
        condition: VIEWPORT_320,
        measurement: measurement([element({ rect: { x: 0, y: 0, width: 320, height: 20 } })]),
      })
    ).toEqual([]);
  });
});

describe("overflow-clipped-text", () => {
  it("runs under every viewport and under text spacing", () => {
    expect(overflowClippedTextCheck.appliesTo(VIEWPORT_320)).toBe(true);
    expect(overflowClippedTextCheck.appliesTo(VIEWPORT_1280)).toBe(true);
    expect(overflowClippedTextCheck.appliesTo(TEXT_SPACING)).toBe(true);
    expect(overflowClippedTextCheck.appliesTo(resolveCondition("media:dark"))).toBe(false);
  });

  it("reports hard vertical clipping as serious", () => {
    const findings = overflowClippedTextCheck.evaluate({
      condition: TEXT_SPACING,
      measurement: measurement([element({ clipping: clipping() })]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].impact).toBe("serious");
    expect(findings[0].evidence.axis).toBe("vertical");
    expect(findings[0].evidence.clippedBy).toBe(48);
    expect(findings[0].helpUrl).toContain("text-spacing");
  });

  it("reports a single-line ellipsis as minor", () => {
    const findings = overflowClippedTextCheck.evaluate({
      condition: VIEWPORT_320,
      measurement: measurement([
        element({
          clipping: clipping({
            overflowX: "hidden",
            overflowY: "visible",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            scrollWidth: 500,
            clientWidth: 300,
            scrollHeight: 24,
          }),
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].impact).toBe("minor");
    expect(findings[0].evidence.axis).toBe("horizontal");
    expect(findings[0].helpUrl).toContain("reflow");
  });

  it("does not report a scrollable container: the text is still reachable", () => {
    expect(
      overflowClippedTextCheck.evaluate({
        condition: VIEWPORT_320,
        measurement: measurement([element({ clipping: clipping({ overflowY: "auto" }) })]),
      })
    ).toEqual([]);
  });

  it("does not report a clipping box without text", () => {
    expect(
      overflowClippedTextCheck.evaluate({
        condition: VIEWPORT_320,
        measurement: measurement([
          element({ hasText: false, hasContentText: false, clipping: clipping() }),
        ]),
      })
    ).toEqual([]);
  });

  it("does not report an element that is not rendered", () => {
    expect(
      overflowClippedTextCheck.evaluate({
        condition: VIEWPORT_320,
        measurement: measurement([element({ rendered: false, clipping: clipping() })]),
      })
    ).toEqual([]);
  });

  it("finds nothing when the content fits the box", () => {
    expect(
      overflowClippedTextCheck.evaluate({
        condition: VIEWPORT_320,
        measurement: measurement([
          element({ clipping: clipping({ scrollHeight: 24, clientHeight: 24 }) }),
        ]),
      })
    ).toEqual([]);
  });
});

describe("overlap-text", () => {
  const first = () =>
    element({ index: 0, stackingContext: 0, rect: { x: 0, y: 0, width: 200, height: 100 } });

  it("reports two text blocks drawn on top of each other", () => {
    const second = element({
      index: 1,
      stackingContext: 0,
      rect: { x: 0, y: 50, width: 200, height: 100 },
    });

    const findings = overlapTextCheck.evaluate({
      condition: TEXT_SPACING,
      measurement: measurement([first(), second]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].impact).toBe("serious");
    expect(findings[0].selector).toBe(second.selector);
    // The element's own rect, so every finding on it shares one mark in one
    // place; the collision itself is in the evidence.
    expect(findings[0].rect).toEqual(second.rect);
    expect(findings[0].evidence).toEqual({
      overlapRatio: 0.5,
      otherSelector: "#e0",
      overlapX: 0,
      overlapY: 50,
      overlapWidth: 200,
      overlapHeight: 50,
    });
  });

  it("gives the same element one rect across several overlaps", () => {
    // One block drawn over two others: both findings have to point at it.
    const shared = element({
      index: 2,
      selector: "#shared",
      stackingContext: 0,
      rect: { x: 0, y: 40, width: 200, height: 120 },
    });
    const above = element({
      index: 0,
      selector: "#above",
      stackingContext: 0,
      rect: { x: 0, y: 0, width: 200, height: 100 },
    });
    const below = element({
      index: 1,
      selector: "#below",
      stackingContext: 0,
      rect: { x: 0, y: 120, width: 200, height: 100 },
    });

    const findings = overlapTextCheck.evaluate({
      condition: TEXT_SPACING,
      measurement: measurement([above, below, shared]),
    });

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.elementIndex)).toEqual([2, 2]);
    expect(findings.map((finding) => finding.rect)).toEqual([shared.rect, shared.rect]);
    // The intersections differ, and they stay in the evidence.
    expect(findings.map((finding) => finding.evidence.overlapY)).toEqual([40, 120]);
  });

  it("finds nothing for adjacent blocks", () => {
    const second = element({
      index: 1,
      stackingContext: 0,
      rect: { x: 0, y: 100, width: 200, height: 100 },
    });
    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([first(), second]),
      })
    ).toEqual([]);
  });

  it("finds nothing below the overlap threshold", () => {
    const second = element({
      index: 1,
      stackingContext: 0,
      rect: { x: 0, y: 95, width: 200, height: 100 },
    });
    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([first(), second]),
      })
    ).toEqual([]);
  });

  it("ignores a descendant inside its own ancestor", () => {
    const child = element({
      index: 1,
      parentIndex: 0,
      stackingContext: 0,
      rect: { x: 10, y: 10, width: 100, height: 40 },
    });
    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([first(), child]),
      })
    ).toEqual([]);
  });

  it("ignores pairs in different stacking contexts", () => {
    const second = element({
      index: 1,
      stackingContext: 7,
      rect: { x: 0, y: 50, width: 200, height: 100 },
    });
    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([first(), second]),
      })
    ).toEqual([]);
  });

  it("ignores anchored elements, whose place in the capture is not where they are seen", () => {
    const second = element({
      index: 1,
      anchored: true,
      stackingContext: 0,
      rect: { x: 0, y: 50, width: 200, height: 100 },
    });
    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([first(), second]),
      })
    ).toEqual([]);
  });

  it("judges a wrapped inline element on its line boxes, not on their union", () => {
    // Two links in one paragraph: the second wraps, so its union rect covers
    // the first one's line, while neither of its lines touches it.
    const wrapped = element({
      index: 1,
      tag: "a",
      stackingContext: 0,
      fragments: 2,
      rect: { x: 0, y: 0, width: 200, height: 40 },
      boxes: [
        { x: 120, y: 0, width: 80, height: 20 },
        { x: 0, y: 20, width: 60, height: 20 },
      ],
    });
    const inline = element({
      index: 0,
      tag: "a",
      stackingContext: 0,
      fragments: 1,
      rect: { x: 0, y: 0, width: 100, height: 20 },
    });

    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([inline, wrapped]),
      })
    ).toEqual([]);
  });

  it("reports the line box a block is actually drawn over, and nothing else", () => {
    const heading = element({
      index: 0,
      tag: "h2",
      stackingContext: 0,
      rect: { x: 0, y: 20, width: 100, height: 20 },
    });
    const wrapped = element({
      index: 1,
      tag: "a",
      stackingContext: 0,
      fragments: 2,
      rect: { x: 0, y: 0, width: 200, height: 40 },
      boxes: [
        { x: 120, y: 0, width: 80, height: 20 },
        { x: 0, y: 20, width: 60, height: 20 },
      ],
    });

    const findings = overlapTextCheck.evaluate({
      condition: TEXT_SPACING,
      measurement: measurement([heading, wrapped]),
    });

    expect(findings).toHaveLength(1);
    // The collision is the second line box, not the union rect, and it is
    // what the evidence reports; the rect stays the element's own.
    expect(findings[0].evidence.overlapX).toBe(0);
    expect(findings[0].evidence.overlapY).toBe(20);
    expect(findings[0].evidence.overlapWidth).toBe(60);
    expect(findings[0].evidence.overlapHeight).toBe(20);
    expect(findings[0].rect).toEqual(wrapped.rect);
    expect(findings[0].evidence.overlapRatio).toBe(1);
  });

  it("ignores an element with more line boxes than the measurement carries", () => {
    const manyLines = element({
      index: 1,
      tag: "a",
      stackingContext: 0,
      fragments: 12,
      rect: { x: 0, y: 50, width: 200, height: 100 },
    });
    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([first(), manyLines]),
      })
    ).toEqual([]);
  });

  it("ignores an element that is not visibly rendered, such as an off-canvas skip link", () => {
    const offCanvas = element({
      index: 1,
      rendered: false,
      stackingContext: 0,
      rect: { x: 0, y: 50, width: 200, height: 100 },
    });
    expect(
      overlapTextCheck.evaluate({
        condition: TEXT_SPACING,
        measurement: measurement([first(), offCanvas]),
      })
    ).toEqual([]);
  });
});

describe("content-hidden-at-viewport", () => {
  it("compares the wide capture against the narrow one", () => {
    expect(contentHiddenAtViewportCheck.reportsUnder).toBe("viewport:1280");
    expect(contentHiddenAtViewportCheck.comparesWith).toBe("viewport:360");
  });

  const wide = (overrides: Partial<RenderingElement> = {}) =>
    measurement([element({ index: 0, selector: "#promo", text: "Opening hours", ...overrides })], {
      viewport: { width: 1280, height: 720 },
      client: { width: 1280, height: 720 },
    });

  const narrow = (overrides: Partial<RenderingElement> = {}) =>
    measurement([element({ index: 0, selector: "#promo", text: "Opening hours", ...overrides })], {
      viewport: { width: 360, height: 800 },
      client: { width: 360, height: 800 },
    });

  it("reports text that is rendered wide and gone narrow", () => {
    const findings = contentHiddenAtViewportCheck.evaluate({
      condition: VIEWPORT_1280,
      measurement: wide(),
      reference: narrow({ rendered: false, rect: { x: 0, y: 0, width: 0, height: 0 } }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].impact).toBe("moderate");
    expect(findings[0].selector).toBe("#promo");
    expect(findings[0].rect).toEqual({ x: 0, y: 0, width: 100, height: 20 });
    expect(findings[0].evidence).toEqual({
      wideViewport: 1280,
      narrowViewport: 360,
      textElements: 1,
      presentAtNarrowViewport: true,
    });
  });

  it("exempts content a visible control can reveal at the narrow viewport", () => {
    expect(
      contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wide(),
        reference: narrow({ rendered: false, revealable: true }),
      })
    ).toEqual([]);
  });

  it("claims nothing from a narrow measurement that hit its element cap", () => {
    const reference = narrow({ rendered: false, rect: { x: 0, y: 0, width: 0, height: 0 } });

    expect(
      contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wide(),
        reference: { ...reference, truncated: true },
      })
    ).toEqual([]);
    // Without the cap the same pair is a finding, so it is the cap that
    // silenced it and not the fixture.
    expect(
      contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wide(),
        reference,
      })
    ).toHaveLength(1);
  });

  it("exempts content whose text is rendered elsewhere at the narrow viewport", () => {
    const narrowWithMobileCopy = measurement(
      [
        element({ index: 0, selector: "#promo", text: "Opening hours", rendered: false }),
        element({ index: 1, selector: "#mobile-promo", text: "Opening hours" }),
      ],
      { viewport: { width: 360, height: 800 } }
    );

    expect(
      contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wide(),
        reference: narrowWithMobileCopy,
      })
    ).toEqual([]);
  });

  it("finds nothing when the element is rendered at both viewports", () => {
    expect(
      contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wide(),
        reference: narrow(),
      })
    ).toEqual([]);
  });

  it("reports an element the narrow measurement does not have at all", () => {
    const findings = contentHiddenAtViewportCheck.evaluate({
      condition: VIEWPORT_1280,
      measurement: wide(),
      reference: measurement([], { viewport: { width: 360, height: 800 } }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.presentAtNarrowViewport).toBe(false);
  });

  it("reports only the outermost missing element", () => {
    const wideMeasurement = measurement(
      [
        element({ index: 0, selector: "#aside", text: "Opening hours" }),
        element({ index: 1, parentIndex: 0, selector: "#aside p", text: "Mon to Fri" }),
      ],
      { viewport: { width: 1280, height: 720 }, client: { width: 1280, height: 720 } }
    );
    const narrowMeasurement = measurement(
      [
        element({ index: 0, selector: "#aside", rendered: false }),
        element({ index: 1, parentIndex: 0, selector: "#aside p", rendered: false }),
      ],
      { viewport: { width: 360, height: 800 } }
    );

    const findings = contentHiddenAtViewportCheck.evaluate({
      condition: VIEWPORT_1280,
      measurement: wideMeasurement,
      reference: narrowMeasurement,
    });

    expect(findings.map((finding) => finding.selector)).toEqual(["#aside"]);
    expect(findings[0].evidence.textElements).toBe(2);
  });

  // Amendment rule 1: one finding per hidden region.
  describe("one finding per hidden region", () => {
    /** Five paragraphs in a section the narrow layout hides. */
    const region = { selector: "#promos", html: '<div id="promos">', tag: "div" };
    const texts = ["Opening hours", "Our whole offer", "Contact us", "News", "Jobs"];

    const wideRegion = measurement(
      texts.map((text, position) =>
        element({
          index: position,
          selector: `#promos > p:nth-child(${position + 1})`,
          text,
          rect: { x: 20, y: 100 + position * 30, width: 200, height: 20 },
        })
      ),
      { viewport: { width: 1280, height: 720 }, client: { width: 1280, height: 720 } }
    );

    const narrowRegion = (overrides: Partial<RenderingElement> = {}) =>
      measurement(
        texts.map((text, position) =>
          element({
            index: position,
            selector: `#promos > p:nth-child(${position + 1})`,
            text,
            rendered: false,
            rect: { x: 0, y: 0, width: 0, height: 0 },
            hiddenRegion: region,
            ...overrides,
          })
        ),
        { viewport: { width: 360, height: 800 } }
      );

    it("names the hidden region once and counts what it took with it", () => {
      const findings = contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wideRegion,
        reference: narrowRegion(),
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].selector).toBe("#promos");
      expect(findings[0].html).toBe('<div id="promos">');
      expect(findings[0].evidence.textElements).toBe(5);
      expect(findings[0].failureSummary).toContain("5 text elements");
      expect(findings[0].failureSummary).toContain("Opening hours");
      // Without a box for the region, the members' union stands in for it.
      expect(findings[0].rect).toEqual({ x: 20, y: 100, width: 200, height: 140 });
      // Still an identity of its own, past every member's, so the region's
      // mark cannot land on a paragraph that has a finding too.
      expect(findings[0].elementIndex).toBe(5);
    });

    it("keeps a fallback region's identity clear of the condition's axe nodes", () => {
      // An axe node at the same condition takes the next free identity, which
      // is where a fallback region used to start: both would share a mark.
      const findings = contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: {
          ...wideRegion,
          axe: {
            rules: ["target-size"],
            results: [
              {
                id: "target-size",
                outcome: "violation",
                description: "d",
                help: "h",
                helpUrl: "https://example.test/",
                impact: "serious",
                nodes: [
                  {
                    selector: "#tiny",
                    html: "<button>",
                    failureSummary: "f",
                    impact: "serious",
                    index: 5,
                    rect: { x: 0, y: 0, width: 16, height: 16 },
                    inBaseline: false,
                  },
                ],
              },
            ],
          },
        },
        reference: narrowRegion(),
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].elementIndex).toBe(6);
    });

    it("takes the region's box and identity from the wide measurement", () => {
      // The section itself carries no text, so the wide walk has it as an
      // ancestor box and not as a candidate: 100 px taller than the
      // paragraphs it contains, and with an identity of its own.
      const findings = contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: {
          ...wideRegion,
          ancestors: [
            { index: 5, selector: "#promos", rect: { x: 10, y: 90, width: 400, height: 240 } },
            { index: 6, selector: "main", rect: { x: 0, y: 0, width: 1280, height: 900 } },
          ],
        },
        reference: narrowRegion(),
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].selector).toBe("#promos");
      expect(findings[0].rect).toEqual({ x: 10, y: 90, width: 400, height: 240 });
      expect(findings[0].elementIndex).toBe(5);
      // Not one of the paragraphs, each of which can carry a finding of its
      // own under this very condition.
      expect(wideRegion.elements.map((member) => member.index)).not.toContain(
        findings[0].elementIndex
      );
    });

    it("reports a region per hidden ancestor, not one finding for the page", () => {
      const other = { selector: "#footer-extra", html: '<div id="footer-extra">', tag: "div" };
      const reference = measurement(
        [
          element({
            index: 0,
            selector: "#promos > p:nth-child(1)",
            text: texts[0],
            rendered: false,
            hiddenRegion: region,
          }),
          element({
            index: 1,
            selector: "#promos > p:nth-child(2)",
            text: texts[1],
            rendered: false,
            hiddenRegion: other,
          }),
        ],
        { viewport: { width: 360, height: 800 } }
      );

      const findings = contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: measurement(
          reference.elements.map((hidden) =>
            element({ ...hidden, rendered: true, hiddenRegion: undefined })
          ),
          { viewport: { width: 1280, height: 720 }, client: { width: 1280, height: 720 } }
        ),
        reference,
      });

      expect(findings.map((finding) => finding.selector)).toEqual(["#promos", "#footer-extra"]);
      expect(findings.map((finding) => finding.evidence.textElements)).toEqual([1, 1]);
    });

    it("finds nothing when the region is still rendered narrow", () => {
      expect(
        contentHiddenAtViewportCheck.evaluate({
          condition: VIEWPORT_1280,
          measurement: wideRegion,
          reference: narrowRegion({ rendered: true, hiddenRegion: undefined }),
        })
      ).toEqual([]);
    });
  });

  // Amendment rule 2: the common hamburger counts as a disclosure control.
  describe("navigation behind a hamburger", () => {
    const wideNav = measurement(
      [
        element({ index: 0, tag: "a", selector: "#menu > li:nth-child(1) > a", text: "Our offer" }),
        element({ index: 1, tag: "a", selector: "#menu > li:nth-child(2) > a", text: "Contact" }),
      ],
      { viewport: { width: 1280, height: 720 }, client: { width: 1280, height: 720 } }
    );

    const narrowNav = (revealable: boolean) =>
      measurement(
        [
          element({
            index: 0,
            tag: "a",
            selector: "#menu > li:nth-child(1) > a",
            text: "Our offer",
            rendered: false,
            revealable,
            hiddenRegion: { selector: "#menu", html: '<ul id="menu">', tag: "ul" },
          }),
          element({
            index: 1,
            tag: "a",
            selector: "#menu > li:nth-child(2) > a",
            text: "Contact",
            rendered: false,
            revealable,
            hiddenRegion: { selector: "#menu", html: '<ul id="menu">', tag: "ul" },
          }),
        ],
        { viewport: { width: 360, height: 800 } }
      );

    it("reports nothing when the narrow measurement calls the menu revealable", () => {
      expect(
        contentHiddenAtViewportCheck.evaluate({
          condition: VIEWPORT_1280,
          measurement: wideNav,
          reference: narrowNav(true),
        })
      ).toEqual([]);
    });

    it("reports the menu once when no control can reveal it", () => {
      const findings = contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wideNav,
        reference: narrowNav(false),
      });

      expect(findings.map((finding) => finding.selector)).toEqual(["#menu"]);
      expect(findings[0].evidence.textElements).toBe(2);
    });
  });

  // Amendment rule 3: hidden labels of controls that stay.
  describe("labels of controls that stay", () => {
    const wideLabel = measurement(
      [
        element({
          index: 0,
          tag: "span",
          selector: "#search-link > span",
          text: "Search the site",
        }),
      ],
      { viewport: { width: 1280, height: 720 }, client: { width: 1280, height: 720 } }
    );

    it("does not report a label hidden inside a link that is still rendered", () => {
      const reference = measurement(
        [
          element({
            index: 0,
            tag: "span",
            selector: "#search-link > span",
            text: "Search the site",
            rendered: false,
            inRenderedControl: true,
            hiddenRegion: { selector: "#search-link > span", html: "<span>", tag: "span" },
          }),
        ],
        { viewport: { width: 360, height: 800 } }
      );

      expect(
        contentHiddenAtViewportCheck.evaluate({
          condition: VIEWPORT_1280,
          measurement: wideLabel,
          reference,
        })
      ).toEqual([]);
    });

    it("reports a paragraph that is in no control", () => {
      const findings = contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: wide(),
        reference: narrow({
          rendered: false,
          inRenderedControl: false,
          hiddenRegion: { selector: "#promo", html: "<p>", tag: "p" },
        }),
      });

      expect(findings.map((finding) => finding.selector)).toEqual(["#promo"]);
    });

    it("reports a link whose own box is gone, label and all", () => {
      const findings = contentHiddenAtViewportCheck.evaluate({
        condition: VIEWPORT_1280,
        measurement: measurement(
          [element({ index: 0, tag: "a", selector: "#offer-link", text: "Our whole offer" })],
          { viewport: { width: 1280, height: 720 }, client: { width: 1280, height: 720 } }
        ),
        reference: measurement(
          [
            element({
              index: 0,
              tag: "a",
              selector: "#offer-link",
              text: "Our whole offer",
              rendered: false,
              // The nearest control is the link itself, and it is gone.
              inRenderedControl: false,
              hiddenRegion: { selector: "#offer-link", html: "<a>", tag: "a" },
            }),
          ],
          { viewport: { width: 360, height: 800 } }
        ),
      });

      expect(findings.map((finding) => finding.selector)).toEqual(["#offer-link"]);
    });
  });
});

/**
 * The phase 2 checks read different collected data: axe's own nodes under
 * the condition (`target-size`, `contrast-under-mode`), the paint of
 * elements that carry no text (`forced-colors-loss`), and the animations and
 * self-moving markup (`motion-not-reduced`). Same rule as above: the
 * fixtures are written by hand, so every false positive can be reproduced
 * from the numbers alone.
 */

const MEDIA_DARK = resolveCondition("media:dark");
const FORCED_COLORS = resolveCondition("media:forced-colors");
const MORE_CONTRAST = resolveCondition("media:more-contrast");
const REDUCED_MOTION = resolveCondition("media:reduced-motion");

function axeNode(overrides: Partial<RenderingAxeNode> = {}): RenderingAxeNode {
  const index = overrides.index ?? 0;
  return {
    selector: `#a${index}`,
    html: "<button>",
    failureSummary: "Fix any of the following:\n  Target has insufficient size",
    impact: "serious",
    index,
    rect: { x: 0, y: 0, width: 16, height: 16 },
    inBaseline: false,
    ...overrides,
  };
}

function axeResult(overrides: Partial<RenderingAxeResult> = {}): RenderingAxeResult {
  return {
    id: "target-size",
    outcome: "violation",
    description: "Ensure touch targets have sufficient size and space",
    help: "All touch targets must be 24px large, or leave sufficient space",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.11/target-size",
    impact: "serious",
    nodes: [axeNode()],
    ...overrides,
  };
}

function withAxe(results: RenderingAxeResult[], rules: string[]): RenderingMeasurement {
  return { ...measurement([]), axe: { rules, results } };
}

function painted(overrides: Partial<RenderingPaintedElement> = {}): RenderingPaintedElement {
  const index = overrides.index ?? 0;
  return {
    index,
    selector: `#p${index}`,
    html: "<span>",
    tag: "span",
    role: null,
    rect: { x: 0, y: 0, width: 24, height: 24 },
    anchored: false,
    backgroundImage: 'url("icon.svg")',
    border: false,
    forcedColorAdjust: "auto",
    setsForcedColorAdjust: false,
    hasContentText: false,
    hasGraphic: false,
    ariaHidden: false,
    interactive: true,
    named: false,
    inControl: true,
    ...overrides,
  };
}

function withPainted(elements: RenderingPaintedElement[]): RenderingMeasurement {
  return { ...measurement([]), painted: elements };
}

function animation(overrides: Partial<RenderingAnimation> = {}): RenderingAnimation {
  const index = overrides.index ?? 0;
  return {
    index,
    selector: `#m${index}`,
    html: "<div>",
    tag: "div",
    rect: { x: 0, y: 0, width: 30, height: 30 },
    name: "spin",
    playState: "running",
    iterations: -1,
    durationMs: 2000,
    parentIndex: -1,
    ...overrides,
  };
}

function withMotion(motion: RenderingMotion): RenderingMeasurement {
  return { ...measurement([]), motion };
}

describe("target-size", () => {
  it("runs under the phone and the baseline viewport only", () => {
    expect(targetSizeCheck.appliesTo(VIEWPORT_360)).toBe(true);
    expect(targetSizeCheck.appliesTo(VIEWPORT_1280)).toBe(true);
    expect(targetSizeCheck.appliesTo(VIEWPORT_320)).toBe(false);
    expect(targetSizeCheck.appliesTo(TEXT_SPACING)).toBe(false);
    expect(targetSizeCheck.appliesTo(MEDIA_DARK)).toBe(false);
    // It needs no element walk, only axe's verdict.
    expect(targetSizeCheck.collect).toEqual({ elements: false, axeRules: ["target-size"] });
  });

  it("maps a violation to a finding with axe's impact and the viewport in the evidence", () => {
    const findings = targetSizeCheck.evaluate({
      condition: VIEWPORT_360,
      measurement: withAxe([axeResult()], ["target-size"]),
    });

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.checkId).toBe("target-size");
    expect(finding.impact).toBe("serious");
    expect(finding.selector).toBe("#a0");
    expect(finding.rect).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    expect(finding.elementIndex).toBe(0);
    expect(finding.failureSummary).toContain("360 px wide viewport");
    // Axe's own multi-line summary, on one line.
    expect(finding.failureSummary).toContain("Target has insufficient size");
    expect(finding.failureSummary).not.toContain("\n");
    expect(finding.evidence).toEqual({
      rule: "target-size",
      viewportWidth: 360,
      outcome: "violation",
    });
  });

  it("marks an incomplete result as needing review and keeps the issue shape", () => {
    const findings = targetSizeCheck.evaluate({
      condition: VIEWPORT_360,
      measurement: withAxe(
        [
          axeResult({
            outcome: "incomplete",
            nodes: [axeNode({ impact: "minor", failureSummary: "Element is partially obscured" })],
          }),
        ],
        ["target-size"]
      ),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].impact).toBe("minor");
    expect(findings[0].failureSummary).toStartWith("Needs review:");
    expect(findings[0].evidence.needsReview).toBe(true);
    expect(findings[0].evidence.outcome).toBe("incomplete");
  });

  it("does not repeat a target the engine pass already reported, at any viewport", () => {
    // The engine pass audits at the caller's viewport and now runs the rule
    // itself; reporting its findings again is the same problem twice.
    const measured = withAxe(
      [axeResult({ nodes: [axeNode({ inBaseline: true }), axeNode({ index: 1 })] })],
      ["target-size"]
    );

    for (const condition of [VIEWPORT_1280, VIEWPORT_360]) {
      expect(
        targetSizeCheck
          .evaluate({ condition, measurement: measured })
          .map((finding) => finding.selector)
      ).toEqual(["#a1"]);
    }
  });

  it("reports nothing when the condition ran no axe rules", () => {
    expect(
      targetSizeCheck.evaluate({ condition: VIEWPORT_360, measurement: measurement([]) })
    ).toEqual([]);
    expect(
      targetSizeCheck.evaluate({
        condition: VIEWPORT_360,
        measurement: withAxe([axeResult({ id: "color-contrast" })], ["color-contrast"]),
      })
    ).toEqual([]);
  });
});

describe("contrast-under-mode", () => {
  const contrastResult = (overrides: Partial<RenderingAxeResult> = {}) =>
    axeResult({
      id: "color-contrast",
      description: "Ensure the contrast between foreground and background colors meets WCAG 2 AA",
      help: "Elements must meet minimum color contrast ratio thresholds",
      nodes: [
        axeNode({
          selector: "#dark-link",
          html: "<a>",
          failureSummary: "Element has insufficient color contrast of 1.03",
        }),
      ],
      ...overrides,
    });

  it("runs under the three colour modes only", () => {
    expect(contrastUnderModeCheck.appliesTo(MEDIA_DARK)).toBe(true);
    expect(contrastUnderModeCheck.appliesTo(FORCED_COLORS)).toBe(true);
    expect(contrastUnderModeCheck.appliesTo(MORE_CONTRAST)).toBe(true);
    expect(contrastUnderModeCheck.appliesTo(REDUCED_MOTION)).toBe(false);
    expect(contrastUnderModeCheck.appliesTo(VIEWPORT_360)).toBe(false);
  });

  it("reports a failure the mode introduced, naming the mode", () => {
    const findings = contrastUnderModeCheck.evaluate({
      condition: MEDIA_DARK,
      measurement: withAxe([contrastResult()], CONTRAST_RULES),
    });

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.impact).toBe("serious");
    expect(finding.selector).toBe("#dark-link");
    expect(finding.failureSummary).toContain("dark mode");
    expect(finding.failureSummary).toContain("insufficient color contrast");
    expect(finding.description).toContain("under dark mode only");
    expect(finding.evidence).toEqual({
      rule: "color-contrast",
      mode: "dark mode",
      inBaseline: false,
    });
  });

  it("stays silent about a failure the page already has", () => {
    const findings = contrastUnderModeCheck.evaluate({
      condition: MEDIA_DARK,
      measurement: withAxe(
        [
          contrastResult({
            nodes: [axeNode({ selector: "#dark-link", inBaseline: true })],
          }),
        ],
        CONTRAST_RULES
      ),
    });

    expect(findings).toEqual([]);
  });

  it("ignores incomplete results: nobody measured them in the baseline either", () => {
    const findings = contrastUnderModeCheck.evaluate({
      condition: FORCED_COLORS,
      measurement: withAxe([contrastResult({ outcome: "incomplete" })], CONTRAST_RULES),
    });

    expect(findings).toEqual([]);
  });

  it("drops a contrast node under forced colours whose colour axe misread", () => {
    // Chromium forces `color` and paints with it, but leaves
    // `-webkit-text-fill-color` at the author's value, which is the one axe
    // measures: the ratio is about a colour that is not on the screen.
    const misread = withAxe(
      [
        contrastResult({
          nodes: [axeNode({ selector: "#button", textFillMismatch: true })],
        }),
      ],
      CONTRAST_RULES
    );

    expect(
      contrastUnderModeCheck.evaluate({ condition: FORCED_COLORS, measurement: misread })
    ).toEqual([]);
    // Only under forced colours: elsewhere the fill colour is the painted one.
    expect(
      contrastUnderModeCheck.evaluate({ condition: MEDIA_DARK, measurement: misread })
    ).toHaveLength(1);
    // And an element that keeps its own colours under forced colours has no
    // mismatch, so it is still reported.
    expect(
      contrastUnderModeCheck.evaluate({
        condition: FORCED_COLORS,
        measurement: withAxe([contrastResult()], CONTRAST_RULES),
      })
    ).toHaveLength(1);
  });

  it("reports link-in-text-block the same way, with the mode's own name", () => {
    const findings = contrastUnderModeCheck.evaluate({
      condition: MORE_CONTRAST,
      measurement: withAxe(
        [contrastResult({ id: "link-in-text-block", impact: "serious" })],
        CONTRAST_RULES
      ),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.rule).toBe("link-in-text-block");
    expect(findings[0].evidence.mode).toBe("the increased-contrast mode");
  });
});

describe("forced-colors-loss", () => {
  it("runs under forced colours only", () => {
    expect(forcedColorsLossCheck.appliesTo(FORCED_COLORS)).toBe(true);
    expect(forcedColorsLossCheck.appliesTo(MEDIA_DARK)).toBe(false);
    expect(forcedColorsLossCheck.appliesTo(VIEWPORT_360)).toBe(false);
  });

  it("reports an icon button whose only rendering is a background image", () => {
    const findings = forcedColorsLossCheck.evaluate({
      condition: FORCED_COLORS,
      measurement: withPainted([painted({ tag: "button", selector: "#search", named: true })]),
    });

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.impact).toBe("serious");
    expect(finding.selector).toBe("#search");
    expect(finding.failureSummary).toContain("a background image alone");
    expect(finding.evidence.reason).toBe("paint-only");
    expect(finding.evidence.backgroundImage).toBe(true);
    expect(finding.rect).toEqual({ x: 0, y: 0, width: 24, height: 24 });
  });

  it("reports an indicator whose only rendering is a border", () => {
    const findings = forcedColorsLossCheck.evaluate({
      condition: FORCED_COLORS,
      measurement: withPainted([
        painted({
          backgroundImage: "none",
          border: true,
          role: "status",
          interactive: false,
          inControl: false,
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].failureSummary).toContain("a border alone");
    expect(findings[0].evidence.border).toBe(true);
  });

  it("leaves text, graphics, decoration and plain decoration alone", () => {
    const cases: [string, RenderingPaintedElement][] = [
      // Text survives forced colours: it is forced, not lost.
      ["text", painted({ index: 0, hasContentText: true })],
      // An `img` or inline `svg` keeps rendering.
      ["graphic", painted({ index: 1, hasGraphic: true })],
      // Decoration the accessibility tree already drops.
      ["aria-hidden", painted({ index: 2, ariaHidden: true })],
      // A divider with a border, no function and no name.
      [
        "decorative",
        painted({
          index: 3,
          backgroundImage: "none",
          border: true,
          interactive: false,
          inControl: false,
          named: false,
          role: null,
        }),
      ],
      // Nothing is painted at all.
      ["nothing painted", painted({ index: 4, backgroundImage: "none", border: false })],
      // A `presentation` role is not a meaningful one.
      [
        "presentation",
        painted({ index: 5, role: "presentation", interactive: false, inControl: false }),
      ],
    ];

    for (const [name, element] of cases) {
      const findings = forcedColorsLossCheck.evaluate({
        condition: FORCED_COLORS,
        measurement: withPainted([element]),
      });
      expect(`${name}: ${findings.length}`).toBe(`${name}: 0`);
    }
  });

  it("reports forced-color-adjust: none, whatever else the element has", () => {
    const findings = forcedColorsLossCheck.evaluate({
      condition: FORCED_COLORS,
      measurement: withPainted([
        painted({
          tag: "div",
          forcedColorAdjust: "none",
          setsForcedColorAdjust: true,
          hasContentText: true,
          backgroundImage: "none",
          interactive: false,
          inControl: false,
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].impact).toBe("serious");
    expect(findings[0].evidence.reason).toBe("forced-color-adjust");
    expect(findings[0].failureSummary).toContain("forced-color-adjust: none");
  });

  it("gives an element that opted out and paints only one finding", () => {
    const findings = forcedColorsLossCheck.evaluate({
      condition: FORCED_COLORS,
      measurement: withPainted([
        painted({ forcedColorAdjust: "none", setsForcedColorAdjust: true }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.reason).toBe("forced-color-adjust");
  });

  it("reports the opt-out at the element that sets it, not at what inherited it", () => {
    // `forced-color-adjust` is inherited: a swatch panel that opts out puts
    // the computed `none` on every element in it, and one decision is one
    // finding.
    const findings = forcedColorsLossCheck.evaluate({
      condition: FORCED_COLORS,
      measurement: withPainted([
        painted({
          index: 0,
          selector: "#swatches",
          tag: "div",
          forcedColorAdjust: "none",
          setsForcedColorAdjust: true,
          hasContentText: true,
          backgroundImage: "none",
          border: true,
          interactive: false,
          inControl: false,
        }),
        painted({
          index: 1,
          selector: "#swatches > span",
          forcedColorAdjust: "none",
          setsForcedColorAdjust: false,
          hasContentText: true,
          backgroundImage: "none",
          border: true,
          interactive: false,
          inControl: false,
        }),
      ]),
    });

    expect(findings.map((finding) => finding.selector)).toEqual(["#swatches"]);
    expect(findings[0].evidence.reason).toBe("forced-color-adjust");
  });

  it("judges an inherited opt-out by its own paint", () => {
    // The descendant is not reported for the opt-out, and the paint-only
    // rule still applies to it: an icon button inside the panel has lost its
    // only rendering just the same.
    const findings = forcedColorsLossCheck.evaluate({
      condition: FORCED_COLORS,
      measurement: withPainted([
        painted({
          index: 1,
          selector: "#swatches > button",
          tag: "button",
          forcedColorAdjust: "none",
          setsForcedColorAdjust: false,
          named: true,
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.reason).toBe("paint-only");
  });
});

describe("motion-not-reduced", () => {
  it("runs under reduced motion only", () => {
    expect(motionNotReducedCheck.appliesTo(REDUCED_MOTION)).toBe(true);
    expect(motionNotReducedCheck.appliesTo(MEDIA_DARK)).toBe(false);
    expect(motionNotReducedCheck.appliesTo(VIEWPORT_360)).toBe(false);
  });

  it("reports an animation that repeats forever", () => {
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({ animations: [animation()], elements: [] }),
    });

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.impact).toBe("moderate");
    expect(finding.selector).toBe("#m0");
    expect(finding.failureSummary).toContain("repeats forever");
    expect(finding.evidence.kind).toBe("infinite-animation");
    expect(finding.evidence.iterations).toBe(-1);
  });

  it("reports an animation longer than five seconds and leaves a short one alone", () => {
    const long = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [animation({ iterations: 1, durationMs: 8000 })],
        elements: [],
      }),
    });
    expect(long).toHaveLength(1);
    expect(long[0].evidence.kind).toBe("long-animation");
    expect(long[0].failureSummary).toContain("8 s per iteration");

    const short = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [animation({ iterations: 1, durationMs: 300 })],
        elements: [],
      }),
    });
    expect(short).toEqual([]);
  });

  it("ignores an animation that is not running", () => {
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [
          animation({ playState: "paused" }),
          animation({ index: 1, playState: "finished" }),
        ],
        elements: [],
      }),
    });

    expect(findings).toEqual([]);
  });

  it("counts several animations on one element as one finding", () => {
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [animation(), animation({ name: "pulse" }), animation({ index: 1 })],
        elements: [],
      }),
    });

    expect(findings).toHaveLength(2);
    expect(findings[0].evidence.animations).toBe(2);
    expect(findings[1].evidence.animations).toBe(1);
  });

  it("reports the outermost animated element of one movement", () => {
    // An SVG spinner animates the `svg` and the `circle` in it.
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [
          animation({ index: 0, tag: "svg", name: "spinner-rotator" }),
          animation({ index: 1, tag: "circle", name: "spinner-dash", parentIndex: 0 }),
        ],
        elements: [],
      }),
    });

    expect(findings.map((finding) => finding.elementIndex)).toEqual([0]);
    expect(findings[0].evidence.animation).toBe("spinner-rotator");
    expect(findings[0].evidence.parentIndex).toBeUndefined();
  });

  it("keeps an animated element whose animated ancestor is not reported", () => {
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [
          // A short fade on the wrapper is no finding, so the spinner in it
          // is still the one that moves.
          animation({ index: 0, tag: "div", iterations: 1, durationMs: 200 }),
          animation({ index: 1, tag: "svg", parentIndex: 0 }),
        ],
        elements: [],
      }),
    });

    expect(findings.map((finding) => finding.elementIndex)).toEqual([1]);
  });

  it("folds a nested movement into its outermost element across a short animation", () => {
    // Outer and inner repeat forever, and the element between them only
    // fades for 300 ms: the nesting is still the nesting, and following it
    // through the qualifying animations alone stopped at the middle entry
    // and reported the pair twice.
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [
          animation({ index: 0, tag: "div", name: "outer-drift" }),
          animation({ index: 1, tag: "div", iterations: 1, durationMs: 300, parentIndex: 0 }),
          animation({ index: 2, tag: "svg", name: "inner-spin", parentIndex: 1 }),
        ],
        elements: [],
      }),
    });

    expect(findings.map((finding) => finding.elementIndex)).toEqual([0]);
    expect(findings[0].evidence.animation).toBe("outer-drift");
    // The movement of the folded descendant is counted where it is reported.
    expect(findings[0].evidence.animations).toBe(2);
  });

  it("reports the animated parent of more children than the cap carries", () => {
    // `getAnimations()` is in neither document nor nesting order, so the
    // children can come first; applying the cap before the nesting spent it
    // on 25 of them and left the parent — the one movement — out.
    const animations = [
      ...Array.from({ length: 30 }, (_, child) =>
        animation({ index: child + 1, tag: "div", parentIndex: 0 })
      ),
      animation({ index: 0, tag: "div", name: "carousel" }),
    ];

    let truncations = 0;
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({ animations, elements: [] }),
      onTruncated: () => {
        truncations++;
      },
    });

    expect(findings.map((finding) => finding.elementIndex)).toEqual([0]);
    expect(findings[0].evidence.animation).toBe("carousel");
    expect(findings[0].evidence.animations).toBe(31);
    // One movement, inside the cap: nothing was dropped.
    expect(truncations).toBe(0);
  });

  it("reports its cap as truncation when it drops a movement of its own", () => {
    const animations = Array.from({ length: 30 }, (_, index) => animation({ index, tag: "div" }));

    let truncated = false;
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({ animations, elements: [] }),
      onTruncated: () => {
        truncated = true;
      },
    });

    expect(findings).toHaveLength(25);
    expect(truncated).toBe(true);
  });

  it("reports autoplaying video without controls and a marquee", () => {
    const findings = motionNotReducedCheck.evaluate({
      condition: REDUCED_MOTION,
      measurement: withMotion({
        animations: [],
        elements: [
          {
            index: 0,
            kind: "video-autoplay",
            selector: "#hero-video",
            html: "<video>",
            tag: "video",
            rect: { x: 0, y: 0, width: 300, height: 200 },
            anchored: false,
          },
          {
            index: 1,
            kind: "marquee",
            selector: "marquee:nth-child(2)",
            html: "<marquee>",
            tag: "marquee",
            rect: { x: 0, y: 0, width: 300, height: 20 },
            anchored: false,
          },
        ],
      }),
    });

    expect(findings.map((finding) => finding.evidence.kind)).toEqual(["video-autoplay", "marquee"]);
    expect(findings[0].failureSummary).toContain("plays by itself");
    expect(findings.every((finding) => finding.impact === "moderate")).toBe(true);
  });

  it("reports nothing when the condition gathered no motion", () => {
    expect(
      motionNotReducedCheck.evaluate({ condition: REDUCED_MOTION, measurement: measurement([]) })
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The vision-deficiency checks
// ---------------------------------------------------------------------------

const PROTANOPIA = resolveCondition("cvd:protanopia");
const DEUTERANOPIA = resolveCondition("cvd:deuteranopia");
const ACHROMATOPSIA = resolveCondition("cvd:achromatopsia");
const REDUCED_CONTRAST = resolveCondition("cvd:reduced-contrast");
const BLURRED_VISION = resolveCondition("cvd:blurred-vision");

function textStyle(overrides: Partial<RenderingTextStyle> = {}): RenderingTextStyle {
  return {
    color: "rgb(0, 0, 136)",
    background: "rgb(255, 255, 255)",
    backgroundImage: false,
    decoration: "none",
    border: false,
    boxShadow: false,
    fontWeight: 400,
    fontStyle: "normal",
    ...overrides,
  };
}

/**
 * A green link in navy text: 3.34:1 as the page is rendered, 2.84:1 under
 * protanopia and 2.83:1 under deuteranopia. The band where a link passes the
 * link-in-text-block ratio and fails it under a deficiency is narrow, because
 * the matrices mostly preserve luminance — these are real colours from it.
 */
function link(overrides: Partial<RenderingLink> = {}): RenderingLink {
  const index = overrides.index ?? nextIndex++;
  return {
    index,
    selector: `#l${index}`,
    html: "<a>",
    tag: "a",
    rect: { x: 10, y: 20, width: 120, height: 18 },
    anchored: false,
    text: "a green link",
    blockSelector: "main > p",
    link: textStyle({ color: "rgb(0, 136, 0)" }),
    surrounding: textStyle(),
    ...overrides,
  };
}

function withLinks(links: RenderingLink[]): RenderingMeasurement {
  return measurement([], { links });
}

describe("cvd-link-distinction", () => {
  it("runs under the deficiencies that are a colour transformation, and no other condition", () => {
    expect(cvdLinkDistinctionCheck.appliesTo(PROTANOPIA)).toBe(true);
    expect(cvdLinkDistinctionCheck.appliesTo(DEUTERANOPIA)).toBe(true);
    expect(cvdLinkDistinctionCheck.appliesTo(ACHROMATOPSIA)).toBe(true);
    // Neither of these is a colour transformation, so there is no matrix.
    expect(cvdLinkDistinctionCheck.appliesTo(REDUCED_CONTRAST)).toBe(false);
    expect(cvdLinkDistinctionCheck.appliesTo(BLURRED_VISION)).toBe(false);
    expect(cvdLinkDistinctionCheck.appliesTo(MEDIA_DARK)).toBe(false);
    expect(cvdLinkDistinctionCheck.appliesTo(VIEWPORT_320)).toBe(false);
  });

  it("reports a colour-only link whose contrast collapses under the deficiency", () => {
    const target = link();
    const findings = cvdLinkDistinctionCheck.evaluate({
      condition: PROTANOPIA,
      measurement: withLinks([target]),
    });

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.checkId).toBe("cvd-link-distinction");
    expect(finding.impact).toBe("moderate");
    expect(finding.selector).toBe(target.selector);
    expect(finding.rect).toEqual(target.rect);
    expect(finding.elementIndex).toBe(target.index);
    expect(finding.helpUrl).toContain("use-of-color");
    expect(finding.evidence.deficiency).toBe("protanopia");
    expect(finding.evidence.contrast).toBe(3.34);
    expect(finding.evidence.simulatedContrast).toBe(2.84);
    expect(finding.evidence.required).toBe(3);
    expect(finding.evidence.simulatedLinkColor).toBe("rgb(139, 122, 0)");
    expect(finding.failureSummary).toContain("3.34:1");
    expect(finding.failureSummary).toContain("2.84:1");
  });

  it("leaves a link axe already fails on the page as it is rendered", () => {
    // 2.58:1 normally: that is `link-in-text-block`, which the engine pass
    // reports, not something the deficiency did.
    const findings = cvdLinkDistinctionCheck.evaluate({
      condition: PROTANOPIA,
      measurement: withLinks([link({ link: textStyle({ color: "rgb(51, 102, 153)" }) })]),
    });

    expect(findings).toEqual([]);
  });

  it("leaves a link whose contrast survives the deficiency", () => {
    expect(
      cvdLinkDistinctionCheck.evaluate({
        condition: ACHROMATOPSIA,
        measurement: withLinks([link()]),
      })
    ).toEqual([]);
  });

  for (const [what, overrides] of [
    ["an underline", { decoration: "underline" }],
    ["a border", { border: true }],
    ["a box-shadow underline", { boxShadow: true }],
    ["a heavier font weight", { fontWeight: 700 }],
    ["an italic style", { fontStyle: "italic" }],
    ["a background of its own", { background: "rgb(230, 230, 180)" }],
  ] as [string, Partial<RenderingTextStyle>][]) {
    it(`leaves a link distinguished by ${what}`, () => {
      expect(
        cvdLinkDistinctionCheck.evaluate({
          condition: PROTANOPIA,
          measurement: withLinks([
            link({ link: textStyle({ color: "rgb(0, 136, 0)", ...overrides }) }),
          ]),
        })
      ).toEqual([]);
    });
  }

  it("leaves a link whose background is an image, where no colour is the painted one", () => {
    expect(
      cvdLinkDistinctionCheck.evaluate({
        condition: PROTANOPIA,
        measurement: withLinks([
          link({ surrounding: textStyle({ backgroundImage: true }) }),
          link({ link: textStyle({ color: "rgb(0, 136, 0)", backgroundImage: true }) }),
        ]),
      })
    ).toEqual([]);
  });

  it("leaves a colour it cannot parse rather than guess at it", () => {
    expect(
      cvdLinkDistinctionCheck.evaluate({
        condition: PROTANOPIA,
        measurement: withLinks([link({ link: textStyle({ color: "oklch(0.7 0.15 250)" }) })]),
      })
    ).toEqual([]);
  });

  it("caps its findings and says so", () => {
    let truncated = 0;
    const findings = cvdLinkDistinctionCheck.evaluate({
      condition: PROTANOPIA,
      measurement: withLinks(Array.from({ length: 30 }, () => link())),
      onTruncated: () => {
        truncated += 1;
      },
    });

    expect(findings).toHaveLength(25);
    expect(truncated).toBe(1);
  });

  it("reports nothing when the condition gathered no links", () => {
    expect(
      cvdLinkDistinctionCheck.evaluate({ condition: PROTANOPIA, measurement: measurement([]) })
    ).toEqual([]);
  });
});

function stateStyle(overrides: Partial<RenderingStateStyle> = {}): RenderingStateStyle {
  return {
    selector: "#state",
    rect: { x: 0, y: 0, width: 80, height: 32 },
    color: "rgb(51, 51, 51)",
    background: "rgb(207, 232, 207)",
    backgroundImage: false,
    borderColor: "rgb(204, 204, 204)",
    borderWidths: "1px 1px 1px 1px",
    outline: false,
    decoration: "none",
    fontWeight: 400,
    fontStyle: "normal",
    fontFamily: "system-ui",
    fontSize: 16,
    text: "",
    textTruncated: false,
    childElements: 1,
    graphics: "svg:7xk1",
    graphicsReadable: true,
    pseudoContent: "|",
    ...overrides,
  };
}

/**
 * A selected icon tab whose only distinction is its background: a green tint
 * against the grey of its sibling, 16.5 apart (CIE76) normally and 9.8 under
 * deuteranopia — below the 10 the check asks for. Both sides carry the same
 * icon and no visible text, which is what makes the colour the only cue:
 * two labels that merely differ as labels do are a difference this check
 * cannot tell from a state marker, and it leaves those pairs alone.
 */
function statePair(overrides: Partial<RenderingStatePair> = {}): RenderingStatePair {
  const index = overrides.index ?? nextIndex++;
  return {
    index,
    html: '<button role="tab" aria-selected="true" aria-label="Chart">',
    tag: "button",
    role: "tab",
    anchored: false,
    state: "aria-selected",
    stateValue: "true",
    element: stateStyle({ selector: `#s${index}` }),
    sibling: stateStyle({
      selector: `#s${index}-other`,
      background: "rgb(238, 238, 238)",
    }),
    ...overrides,
  };
}

function withStates(states: RenderingStatePair[]): RenderingMeasurement {
  return measurement([], { states });
}

describe("cvd-state-by-color", () => {
  it("runs under the deficiencies that are a colour transformation, and no other condition", () => {
    expect(cvdStateByColorCheck.appliesTo(DEUTERANOPIA)).toBe(true);
    expect(cvdStateByColorCheck.appliesTo(ACHROMATOPSIA)).toBe(true);
    expect(cvdStateByColorCheck.appliesTo(REDUCED_CONTRAST)).toBe(false);
    expect(cvdStateByColorCheck.appliesTo(BLURRED_VISION)).toBe(false);
    expect(cvdStateByColorCheck.appliesTo(MEDIA_DARK)).toBe(false);
  });

  it("reports a state whose only cue is a colour the deficiency takes", () => {
    const pair = statePair();
    const findings = cvdStateByColorCheck.evaluate({
      condition: DEUTERANOPIA,
      measurement: withStates([pair]),
    });

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.checkId).toBe("cvd-state-by-color");
    expect(finding.impact).toBe("moderate");
    expect(finding.selector).toBe(pair.element.selector);
    expect(finding.rect).toEqual(pair.element.rect);
    expect(finding.elementIndex).toBe(pair.index);
    expect(finding.helpUrl).toContain("use-of-color");
    expect(finding.evidence.state).toBe("aria-selected");
    expect(finding.evidence.property).toBe("background colour");
    expect(finding.evidence.required).toBe(10);
    expect(Number(finding.evidence.distance)).toBeGreaterThanOrEqual(10);
    expect(Number(finding.evidence.simulatedDistance)).toBeLessThan(10);
    expect(finding.evidence.comparedWith).toBe(pair.sibling.selector);
    expect(finding.failureSummary).toContain("aria-selected");
  });

  it("leaves a state whose colour difference survives the deficiency", () => {
    expect(
      cvdStateByColorCheck.evaluate({
        condition: PROTANOPIA,
        measurement: withStates([statePair()]),
      })
    ).toEqual([]);
  });

  it("leaves a state with no visible colour difference at all", () => {
    expect(
      cvdStateByColorCheck.evaluate({
        condition: DEUTERANOPIA,
        measurement: withStates([
          statePair({
            sibling: stateStyle({ selector: "#other", background: "rgb(205, 230, 205)" }),
          }),
        ]),
      })
    ).toEqual([]);
  });

  for (const [what, overrides] of [
    ["a pseudo-element marker", { pseudoContent: '"✓"|' }],
    ["a marker in its visible text", { text: "Chart (selected)" }],
    ["another icon than its sibling", { graphics: "svg:q3zz" }],
    ["an icon where its sibling has none", { graphics: "" }],
    ["an extra child element", { childElements: 2 }],
    ["a heavier font weight", { fontWeight: 700 }],
    ["an italic style", { fontStyle: "italic" }],
    ["another font family", { fontFamily: "Georgia" }],
    ["a larger font size", { fontSize: 18 }],
    ["an underline", { decoration: "underline" }],
    ["an outline", { outline: true }],
    ["a thicker border", { borderWidths: "1px 1px 3px 1px" }],
    ["a taller box", { rect: { x: 0, y: 0, width: 80, height: 40 } }],
  ] as [string, Partial<RenderingStateStyle>][]) {
    it(`leaves a state that also has ${what}`, () => {
      expect(
        cvdStateByColorCheck.evaluate({
          condition: DEUTERANOPIA,
          measurement: withStates([
            statePair({ element: stateStyle({ selector: "#state", ...overrides }) }),
          ]),
        })
      ).toEqual([]);
    });
  }

  it("leaves a state whose box is a different width, since labels differ in length", () => {
    const findings = cvdStateByColorCheck.evaluate({
      condition: DEUTERANOPIA,
      measurement: withStates([
        statePair({
          element: stateStyle({
            selector: "#state",
            rect: { x: 0, y: 0, width: 140, height: 32 },
          }),
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
  });

  it("keeps a state where one cue collapses and another survives", () => {
    // The background collapses under deuteranopia, the text colour does not.
    expect(
      cvdStateByColorCheck.evaluate({
        condition: DEUTERANOPIA,
        measurement: withStates([
          statePair({
            element: stateStyle({ selector: "#state", color: "rgb(0, 0, 0)" }),
            sibling: stateStyle({
              selector: "#other",
              background: "rgb(238, 238, 238)",
              color: "rgb(150, 150, 150)",
            }),
          }),
        ]),
      })
    ).toEqual([]);
  });

  it("leaves a pair whose background is an image, where no colour is the painted one", () => {
    expect(
      cvdStateByColorCheck.evaluate({
        condition: DEUTERANOPIA,
        measurement: withStates([
          statePair({ element: stateStyle({ selector: "#state", backgroundImage: true }) }),
        ]),
      })
    ).toEqual([]);
  });

  it("reports a state whose background is the colour behind a transparent one", () => {
    // The selected tab paints `#008800`; its sibling paints nothing and
    // shows the `#747474` behind it. Same appearance as two explicit
    // backgrounds, and the same finding: 75 apart (CIE76) normally and gone
    // under achromatopsia.
    const findings = cvdStateByColorCheck.evaluate({
      condition: ACHROMATOPSIA,
      measurement: withStates([
        statePair({
          element: stateStyle({ selector: "#state", background: "rgb(0, 136, 0)" }),
          sibling: stateStyle({ selector: "#other", background: "rgb(116, 116, 116)" }),
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.property).toBe("background colour");
    expect(findings[0].evidence.stateColor).toBe("rgb(0, 136, 0)");
    expect(findings[0].evidence.siblingColor).toBe("rgb(116, 116, 116)");
    expect(Number(findings[0].evidence.distance)).toBeGreaterThan(70);
  });

  it("leaves a pair whose two backgrounds paint the same colour", () => {
    // One side sets the colour, the other inherits it from what is behind
    // it: nothing distinguishes the state at all, which is not a colour that
    // collapses.
    expect(
      cvdStateByColorCheck.evaluate({
        condition: ACHROMATOPSIA,
        measurement: withStates([
          statePair({
            element: stateStyle({ selector: "#state", background: "rgb(116, 116, 116)" }),
            sibling: stateStyle({ selector: "#other", background: "rgb(116, 116, 116)" }),
          }),
        ]),
      })
    ).toEqual([]);
  });

  it("treats a foreground the element paints nowhere as no cue", () => {
    // An empty box paints no foreground, and the measurement reports `""`
    // for it (`RenderingStateStyle.color`): the background is then the only
    // cue there is, and an unused `color` difference can neither make a
    // finding nor suppress one.
    const empty = {
      element: stateStyle({ selector: "#state", color: "", graphics: "" }),
      sibling: stateStyle({ selector: "#other", color: "", graphics: "" }),
    };

    const findings = cvdStateByColorCheck.evaluate({
      condition: ACHROMATOPSIA,
      measurement: withStates([
        statePair({
          element: stateStyle({ ...empty.element, background: "rgb(0, 136, 0)" }),
          sibling: stateStyle({ ...empty.sibling, background: "rgb(116, 116, 116)" }),
        }),
      ]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.property).toBe("background colour");

    // The same two boxes painting the same background: nothing is left to
    // carry the state.
    expect(
      cvdStateByColorCheck.evaluate({
        condition: ACHROMATOPSIA,
        measurement: withStates([
          statePair({
            element: stateStyle({ ...empty.element, background: "rgb(116, 116, 116)" }),
            sibling: stateStyle({ ...empty.sibling, background: "rgb(116, 116, 116)" }),
          }),
        ]),
      })
    ).toEqual([]);
  });

  it("composites a semi-transparent text colour over its background exactly once", () => {
    const findings = cvdStateByColorCheck.evaluate({
      condition: ACHROMATOPSIA,
      measurement: withStates([
        statePair({
          element: stateStyle({
            selector: "#state",
            color: "rgba(0, 136, 0, 0.5)",
            background: "rgb(255, 255, 255)",
          }),
          sibling: stateStyle({
            selector: "#other",
            color: "rgba(187, 0, 0, 0.5)",
            background: "rgb(255, 255, 255)",
          }),
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.property).toBe("text colour");
    // 50% of rgb(0, 136, 0) on white, and no second pass over white.
    expect(findings[0].evidence.stateColor).toBe("rgb(128, 196, 128)");
    expect(findings[0].evidence.siblingColor).toBe("rgb(221, 128, 128)");
  });

  it("leaves a pair whose visible text was cut at its bound", () => {
    // The two texts match up to the cut and could differ past it, so the
    // marker question cannot be answered: a missed finding over a made-up one.
    expect(
      cvdStateByColorCheck.evaluate({
        condition: DEUTERANOPIA,
        measurement: withStates([
          statePair({
            element: stateStyle({ selector: "#state", text: "A".repeat(120), textTruncated: true }),
            sibling: stateStyle({
              selector: "#other",
              background: "rgb(238, 238, 238)",
              text: "A".repeat(120),
            }),
          }),
        ]),
      })
    ).toEqual([]);
  });

  it("leaves a pair holding a graphic it cannot identify", () => {
    expect(
      cvdStateByColorCheck.evaluate({
        condition: DEUTERANOPIA,
        measurement: withStates([
          statePair({
            element: stateStyle({
              selector: "#state",
              graphics: "canvas:unknown",
              graphicsReadable: false,
            }),
            sibling: stateStyle({
              selector: "#other",
              background: "rgb(238, 238, 238)",
              graphics: "canvas:unknown",
              graphicsReadable: false,
            }),
          }),
        ]),
      })
    ).toEqual([]);
  });

  it("reports a border-colour-only state and names the border", () => {
    const findings = cvdStateByColorCheck.evaluate({
      condition: ACHROMATOPSIA,
      measurement: withStates([
        statePair({
          state: "aria-invalid",
          stateValue: "true",
          element: stateStyle({
            selector: "#mail",
            background: "rgb(255, 255, 255)",
            borderColor: "rgb(0, 136, 0)",
            graphics: "",
          }),
          sibling: stateStyle({
            selector: "#name",
            background: "rgb(255, 255, 255)",
            borderColor: "rgb(187, 0, 0)",
            graphics: "",
          }),
        }),
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.property).toBe("border colour");
    expect(findings[0].evidence.state).toBe("aria-invalid");
  });

  it("caps its findings and says so", () => {
    let truncated = 0;
    const findings = cvdStateByColorCheck.evaluate({
      condition: DEUTERANOPIA,
      measurement: withStates(Array.from({ length: 30 }, () => statePair())),
      onTruncated: () => {
        truncated += 1;
      },
    });

    expect(findings).toHaveLength(25);
    expect(truncated).toBe(1);
  });

  it("reports nothing when the condition gathered no states", () => {
    expect(
      cvdStateByColorCheck.evaluate({ condition: DEUTERANOPIA, measurement: measurement([]) })
    ).toEqual([]);
  });
});
