/**
 * Rendering that is gone, or frozen, in Windows High Contrast.
 *
 * Under `forced-colors: active` the system replaces the author's colours.
 * Two things go wrong, and this reports both, as `serious`:
 *
 * 1. **Paint-only elements.** An element whose *only* visual rendering is a
 *    `background-image` or a border has nothing left that the forced palette
 *    can carry: the image keeps the colours it was drawn with, so a dark
 *    icon on a now-black surface is invisible, and a border that said
 *    "selected" is forced to the same colour as every other border. "Only
 *    visual rendering" is exactly, and only, this:
 *    - no text anywhere in the subtree (an icon button has none),
 *    - it is not, and does not contain, an `img`, `svg`, `canvas`, `video`,
 *      `object` or image input, because replaced and vector content keeps
 *      rendering,
 *    - a non-`none` `background-image` or a border side that paints,
 *    - not `aria-hidden` — decoration the accessibility tree already drops
 *      is not information to lose,
 *    - and it carries a function or a name: it is interactive, sits inside a
 *      rendered link or button, has `aria-label`, `aria-labelledby` or
 *      `title`, or has an explicit role. A decorative divider with a border
 *      is not a finding; the icon inside the search button is.
 * 2. **`forced-color-adjust: none`.** The author opted the element out of
 *    the forced palette, so it keeps colours the user chose a high-contrast
 *    theme to get rid of. The property is inherited, so the finding is
 *    reported at the element that sets it and not at every descendant that
 *    came by it; a descendant can still be a finding for reason 1. It takes
 *    precedence over the paint-only reason on the element itself: opting out
 *    is the stronger statement.
 */

import type { PerConditionCheck, RenderingFinding, RenderingPaintedElement } from "../types.js";

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html";

const PAINT_DESCRIPTION =
  "An element whose only visual rendering is a background image or a border loses it in forced-colours mode.";

const PAINT_HELP =
  "Draw icons and indicators with content the forced palette can carry: an inline `svg` with `fill: currentColor`, a text label, or a `background-image` paired with a visible border and `@media (forced-colors: active)` rules that restore the distinction.";

const ADJUST_DESCRIPTION =
  "The element sets `forced-color-adjust: none`, so it keeps the author's colours in forced-colours mode.";

const ADJUST_HELP =
  "Leave `forced-color-adjust` at `auto` so the user's high-contrast theme applies. Use `none` only where the colours themselves are the content, such as a colour picker swatch.";

/** Never report more than this many elements per condition. */
const MAX_FINDINGS = 25;

/**
 * Whether the element carries a function or a name, as opposed to being
 * decoration. Without this every bordered card and every hero with a
 * background image would be a finding.
 */
function isMeaningful(element: RenderingPaintedElement): boolean {
  if (element.interactive || element.inControl || element.named) return true;
  return element.role !== null && element.role !== "presentation" && element.role !== "none";
}

/** The paint-only rule, spelled out in the module comment. */
function paintsOnly(element: RenderingPaintedElement): boolean {
  if (element.hasContentText || element.hasGraphic) return false;
  if (element.ariaHidden) return false;
  if (element.backgroundImage === "none" && !element.border) return false;
  return isMeaningful(element);
}

export const forcedColorsLossCheck: PerConditionCheck = {
  id: "forced-colors-loss",
  kind: "per-condition",
  collect: { elements: true, forcedColors: true },

  appliesTo: (condition) => condition.media?.forcedColors === "active",

  evaluate({ measurement, onTruncated }) {
    const findings: RenderingFinding[] = [];

    for (const element of measurement.painted ?? []) {
      // Inherited `none` is the ancestor's decision and is reported there.
      const optedOut = element.forcedColorAdjust === "none" && element.setsForcedColorAdjust;
      if (!optedOut && !paintsOnly(element)) continue;

      // Asked after the filters, so it is only truncation when what the cap
      // drops is a finding.
      if (findings.length >= MAX_FINDINGS) {
        onTruncated?.();
        break;
      }

      const paint =
        element.backgroundImage !== "none" && element.border
          ? "a background image and a border"
          : element.backgroundImage !== "none"
            ? "a background image"
            : "a border";

      findings.push({
        checkId: "forced-colors-loss",
        impact: "serious",
        description: optedOut ? ADJUST_DESCRIPTION : PAINT_DESCRIPTION,
        help: optedOut ? ADJUST_HELP : PAINT_HELP,
        helpUrl: HELP_URL,
        failureSummary: optedOut
          ? `The <${element.tag}> sets \`forced-color-adjust: none\`, so forced colours do not reach it and the user's high-contrast theme is ignored here.`
          : `The <${element.tag}> is rendered by ${paint} alone — no text and no image, icon or other graphic in it — so there is nothing left to see once the system forces its own colours.`,
        selector: element.selector,
        html: element.html,
        rect: element.rect,
        elementIndex: element.index,
        ...(element.anchored ? { anchored: true } : {}),
        evidence: {
          reason: optedOut ? "forced-color-adjust" : "paint-only",
          backgroundImage: element.backgroundImage !== "none",
          border: element.border,
          interactive: element.interactive,
          inControl: element.inControl,
          named: element.named,
          width: Math.round(element.rect.width),
          height: Math.round(element.rect.height),
        },
      });
    }

    return findings;
  },
};
