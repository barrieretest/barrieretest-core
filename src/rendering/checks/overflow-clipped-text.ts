/**
 * Text cut off by a clipping container: WCAG 1.4.12 Text Spacing under the
 * text-spacing override, WCAG 1.4.10 Reflow under a narrow viewport.
 *
 * Only hard clipping counts (`overflow: hidden` and `clip`). `auto` and
 * `scroll` are "not visible" as well, but they give the user a scrollbar, so
 * the text is still reachable and reporting them would be a false positive.
 * Each axis is judged by its own computed value, so the common
 * `overflow-x: hidden; overflow-y: auto` pair is read correctly.
 */

import type { ElementClipping, PerConditionCheck, RenderingFinding } from "../types.js";

const REFLOW_HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html";
const TEXT_SPACING_HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html";

const DESCRIPTION = "Text is cut off by a container that clips its overflow.";

const HELP =
  "Let the container grow with its text instead of clipping it: no fixed height on text, and no `overflow: hidden` where the text can become taller or wider than the box.";

/** Tolerance for sub-pixel layout, in CSS px. */
const TOLERANCE = 1;

/** Never report more than this many elements per condition. */
const MAX_FINDINGS = 25;

function clipsHard(value: string): boolean {
  return value === "hidden" || value === "clip";
}

/**
 * A single line of text ending in an ellipsis is a deliberate truncation with
 * a visible cue, so it is reported as `minor`; everything else loses text
 * without saying so.
 */
function isSingleLineEllipsis(clipping: ElementClipping): boolean {
  if (clipping.textOverflow !== "ellipsis") return false;
  if (clipping.whiteSpace === "nowrap" || clipping.whiteSpace === "pre") return true;
  return clipping.lineHeight > 0 && clipping.clientHeight <= clipping.lineHeight * 1.6;
}

export const overflowClippedTextCheck: PerConditionCheck = {
  id: "overflow-clipped-text",
  kind: "per-condition",
  collect: { elements: true, clipping: true },

  appliesTo: (condition) => condition.viewport !== undefined || condition.textSpacing === true,

  evaluate({ condition, measurement, onTruncated }) {
    const findings: RenderingFinding[] = [];
    const helpUrl = condition.textSpacing ? TEXT_SPACING_HELP_URL : REFLOW_HELP_URL;

    for (const element of measurement.elements) {
      const clipping = element.clipping;
      if (!clipping || !element.rendered || !element.hasContentText) continue;

      const verticalBy = clipping.scrollHeight - clipping.clientHeight;
      const horizontalBy = clipping.scrollWidth - clipping.clientWidth;
      const vertical = clipsHard(clipping.overflowY) && verticalBy > TOLERANCE;
      const horizontal = clipsHard(clipping.overflowX) && horizontalBy > TOLERANCE;
      if (!vertical && !horizontal) continue;

      if (findings.length >= MAX_FINDINGS) {
        onTruncated?.();
        break;
      }

      const minor = isSingleLineEllipsis(clipping);
      const axis = vertical ? "below" : "beyond";
      const amount = Math.round(vertical ? verticalBy : horizontalBy);

      findings.push({
        checkId: "overflow-clipped-text",
        impact: minor ? "minor" : "serious",
        description: DESCRIPTION,
        help: HELP,
        helpUrl,
        failureSummary: `The <${element.tag}> clips ${amount} px of its content ${axis} the visible box (${
          vertical
            ? `content height ${Math.round(clipping.scrollHeight)} px, box height ${Math.round(clipping.clientHeight)} px`
            : `content width ${Math.round(clipping.scrollWidth)} px, box width ${Math.round(clipping.clientWidth)} px`
        })${minor ? ", truncated with an ellipsis" : ""}.${
          element.text ? ` Text: "${element.text}".` : ""
        }`,
        selector: element.selector,
        html: element.html,
        rect: element.rect,
        elementIndex: element.index,
        ...(element.anchored ? { anchored: true } : {}),
        evidence: {
          axis: vertical ? "vertical" : "horizontal",
          clippedBy: amount,
          scrollHeight: Math.round(clipping.scrollHeight),
          clientHeight: Math.round(clipping.clientHeight),
          scrollWidth: Math.round(clipping.scrollWidth),
          clientWidth: Math.round(clipping.clientWidth),
          ellipsis: minor,
        },
      });
    }

    return findings;
  },
};
