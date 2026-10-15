/**
 * Checks are pure functions of a measurement, so these fixtures are written
 * by hand: no browser, and a false positive can be reproduced from the
 * numbers alone.
 */

import { describe, expect, it } from "bun:test";
import { contentHiddenAtViewportCheck } from "./checks/content-hidden-at-viewport.js";
import { overflowClippedTextCheck } from "./checks/overflow-clipped-text.js";
import { overlapTextCheck } from "./checks/overlap-text.js";
import { reflowHorizontalScrollCheck } from "./checks/reflow-horizontal-scroll.js";
import { resolveCondition } from "./conditions.js";
import type { ElementClipping, RenderingElement, RenderingMeasurement } from "./types.js";

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
