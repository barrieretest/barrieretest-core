/**
 * Two blocks of text drawn on top of each other — the usual symptom of a
 * layout that breaks under a narrow viewport or the WCAG 1.4.12 text-spacing
 * override.
 *
 * Only pairs in the same stacking context count, and neither may be an
 * ancestor of the other: a text block inside another one is nesting, not
 * overlap. Anchored (`fixed` or `sticky`) elements are left out, because
 * their place in a full-page capture is not where the user sees them.
 *
 * An inline element that wraps occupies one box per line, and its rect is
 * only their union — a rectangle it does not fill, which two links in one
 * paragraph can appear to share without a pixel being drawn on top of
 * anything. The pairs are therefore judged on the line boxes themselves,
 * which for the ordinary single-box element is the rect.
 */

import type { MeasuredRect } from "../../annotate/index.js";
import type { PerConditionCheck, RenderingElement, RenderingFinding } from "../types.js";

const REFLOW_HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html";
const TEXT_SPACING_HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html";

const DESCRIPTION = "Two blocks of text overlap, so both are hard or impossible to read.";

const HELP =
  "Give text boxes room to grow: avoid fixed heights and absolute positioning for text, and check the layout at 320 CSS px and with the text-spacing override applied.";

/** Share of the smaller box that has to be covered before this is a finding. */
const MIN_OVERLAP_RATIO = 0.1;

/** Smaller than this in either direction is not a text block worth pairing. */
const MIN_SIDE_PX = 2;

/** Never report more than this many pairs per condition. */
const MAX_FINDINGS = 25;

function intersection(a: MeasuredRect, b: MeasuredRect): MeasuredRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function area(rect: MeasuredRect): number {
  return rect.width * rect.height;
}

/** The boxes the element occupies: its line boxes, or its rect. */
function boxesOf(element: RenderingElement): MeasuredRect[] {
  return element.boxes && element.boxes.length > 0 ? element.boxes : [element.rect];
}

/**
 * The largest single overlap between two sets of line boxes, with the share
 * of the smaller of the two boxes it covers. Reporting the largest one keeps
 * the finding's rect on the collision a reader can see.
 */
function largestOverlap(
  a: MeasuredRect[],
  b: MeasuredRect[]
): { rect: MeasuredRect; ratio: number } | null {
  let best: { rect: MeasuredRect; ratio: number } | null = null;

  for (const boxA of a) {
    for (const boxB of b) {
      const rect = intersection(boxA, boxB);
      if (!rect) continue;
      const smaller = Math.min(area(boxA), area(boxB));
      if (smaller <= 0) continue;
      const ratio = area(rect) / smaller;
      if (!best || area(rect) > area(best.rect)) best = { rect, ratio };
    }
  }

  return best;
}

/** True when one of the two is an ancestor of the other. */
function related(a: RenderingElement, b: RenderingElement, elements: RenderingElement[]): boolean {
  const isAncestor = (ancestor: number, descendant: RenderingElement): boolean => {
    let index = descendant.parentIndex;
    while (index >= 0 && index < elements.length) {
      if (index === ancestor) return true;
      index = elements[index].parentIndex;
    }
    return false;
  };
  return isAncestor(a.index, b) || isAncestor(b.index, a);
}

export const overlapTextCheck: PerConditionCheck = {
  id: "overlap-text",
  kind: "per-condition",
  collect: { elements: true, stacking: true },

  appliesTo: (condition) => condition.viewport !== undefined || condition.textSpacing === true,

  evaluate({ condition, measurement }) {
    const findings: RenderingFinding[] = [];
    const helpUrl = condition.textSpacing ? TEXT_SPACING_HELP_URL : REFLOW_HELP_URL;

    const candidates = measurement.elements.filter(
      (element) =>
        element.hasText &&
        element.rendered &&
        !element.anchored &&
        // An element the measurement wrapped into more line boxes than it
        // carries is left out: its union rect cannot answer the question.
        ((element.fragments ?? 1) === 1 || element.boxes !== undefined) &&
        element.rect.width >= MIN_SIDE_PX &&
        element.rect.height >= MIN_SIDE_PX
    );

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const first = candidates[i];
        const second = candidates[j];

        if (first.stackingContext !== second.stackingContext) continue;
        if (related(first, second, measurement.elements)) continue;

        // The union rects are the cheap pre-test; the line boxes decide.
        if (!intersection(first.rect, second.rect)) continue;

        const overlap = largestOverlap(boxesOf(first), boxesOf(second));
        if (!overlap || overlap.ratio <= MIN_OVERLAP_RATIO) continue;

        const { rect, ratio } = overlap;

        if (findings.length >= MAX_FINDINGS) return findings;

        findings.push({
          checkId: "overlap-text",
          impact: "serious",
          description: DESCRIPTION,
          help: HELP,
          helpUrl,
          failureSummary: `The <${second.tag}> overlaps the <${first.tag}> over ${Math.round(
            ratio * 100
          )}% of the smaller box${condition.textSpacing ? " under the WCAG text-spacing override" : ""}. Other element: ${first.selector}. Text: "${second.text}" over "${first.text}".`,
          selector: second.selector,
          html: second.html,
          // The element, not the intersection: the same element can overlap
          // several others, and its mark has to sit in one place and carry
          // one number. The collision itself is in the evidence.
          rect: second.rect,
          elementIndex: second.index,
          evidence: {
            overlapRatio: Math.round(ratio * 100) / 100,
            otherSelector: first.selector,
            overlapX: Math.round(rect.x),
            overlapY: Math.round(rect.y),
            overlapWidth: Math.round(rect.width),
            overlapHeight: Math.round(rect.height),
          },
        });
      }
    }

    return findings;
  },
};
