/**
 * WCAG 1.4.10 Reflow: content must not require scrolling in two dimensions.
 *
 * Reported per overflowing element, so the finding can be boxed on the
 * capture; when the document scrolls horizontally without a nameable culprit
 * — a margin, a negative position, an element the walk's cap cut off — one
 * page-level finding states that instead.
 */

import type { PerConditionCheck, RenderingElement, RenderingFinding } from "../types.js";

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html";

const DESCRIPTION =
  "Content does not reflow to a 320 CSS px wide viewport: the page has to be scrolled horizontally to read it.";

const HELP =
  "Let content reflow into a single column at 320 CSS px without horizontal scrolling. Replace fixed widths with relative ones, and exempt only content that needs two-dimensional layout, such as data tables or maps.";

/** Tolerance for sub-pixel layout, in CSS px. */
const TOLERANCE = 1;

/** Never report more than this many elements per condition. */
const MAX_FINDINGS = 25;

/**
 * True when an already flagged ancestor explains this element's overflow, so
 * only the outermost offender is reported. Ancestors always have a lower
 * index than their descendants: the measurement walks in document order.
 */
function hasFlaggedAncestor(
  element: RenderingElement,
  elements: RenderingElement[],
  flagged: Set<number>
): boolean {
  let index = element.parentIndex;
  while (index >= 0 && index < elements.length) {
    if (flagged.has(index)) return true;
    index = elements[index].parentIndex;
  }
  return false;
}

export const reflowHorizontalScrollCheck: PerConditionCheck = {
  id: "reflow-horizontal-scroll",
  kind: "per-condition",
  collect: { elements: true },

  // The normative reflow test is 320 CSS px, which is also where the
  // composite `viewport:320+text-spacing` lands.
  appliesTo: (condition) => condition.viewport !== undefined && condition.viewport.width <= 320,

  evaluate({ condition, measurement, onTruncated }) {
    const findings: RenderingFinding[] = [];
    const available = measurement.client.width;
    const documentScrolls = measurement.document.width > available + TOLERANCE;

    const flagged = new Set<number>();
    /**
     * Whether anything overflows at all, exempt or not: a page whose only
     * overflow is a data table or a map scrolls horizontally by design, and
     * the exemption would be worthless if the page-level finding still named
     * it.
     */
    let overflowSeen = false;

    for (const element of measurement.elements) {
      if (!element.rendered) continue;
      if (element.rect.x + element.rect.width - available > TOLERANCE) overflowSeen = true;
      if (element.exempt) continue;
      // An ancestor that clips horizontal overflow makes the element's
      // overflow unreachable rather than scrollable: off-canvas drawers and
      // sliders live there, and they are not a reflow failure.
      if (element.clipped) continue;

      const right = element.rect.x + element.rect.width;
      const overflowBy = right - available;
      if (overflowBy <= TOLERANCE) continue;
      // An ancestor that overflows for the same reason already says it.
      if (hasFlaggedAncestor(element, measurement.elements, flagged)) continue;

      flagged.add(element.index);
      if (findings.length >= MAX_FINDINGS) {
        onTruncated?.();
        continue;
      }

      findings.push({
        checkId: "reflow-horizontal-scroll",
        impact: "serious",
        description: DESCRIPTION,
        help: HELP,
        helpUrl: HELP_URL,
        failureSummary: `The <${element.tag}> extends ${Math.round(overflowBy)} px past the ${Math.round(available)} px wide viewport${
          condition.textSpacing ? " under the WCAG text-spacing override" : ""
        }. The document is ${Math.round(measurement.document.width)} px wide.`,
        selector: element.selector,
        html: element.html,
        rect: element.rect,
        elementIndex: element.index,
        ...(element.anchored ? { anchored: true } : {}),
        evidence: {
          overflowBy: Math.round(overflowBy),
          viewportWidth: Math.round(available),
          scrollWidth: Math.round(measurement.document.width),
          elementRight: Math.round(right),
        },
      });
    }

    if (documentScrolls && findings.length === 0 && !overflowSeen) {
      findings.push({
        checkId: "reflow-horizontal-scroll",
        impact: "serious",
        description: DESCRIPTION,
        help: HELP,
        helpUrl: HELP_URL,
        failureSummary: `The document is ${Math.round(measurement.document.width)} px wide in a ${Math.round(available)} px wide viewport, so it scrolls horizontally. No single element accounts for the overflow.`,
        selector: "html",
        pageLevel: true,
        evidence: {
          scrollWidth: Math.round(measurement.document.width),
          clientWidth: Math.round(available),
        },
      });
    }

    return findings;
  },
};
