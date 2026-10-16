/**
 * Links that only colour tells apart, and whose colour a deficiency takes.
 *
 * WCAG 1.4.1 Use of Color, and its link-in-text-block technique: a link
 * inside a block of text that is distinguished from the surrounding text by
 * colour alone needs 3:1 between the two colours — and that contrast has to
 * hold for the reader who is actually looking at it. This check asks the
 * question again with the deficiency applied: the link and the surrounding
 * text are simulated with the matrices Chromium's emulation uses
 * (`src/rendering/color.ts`), and the pair is a finding when the simulated
 * contrast falls below 3:1 while the unsimulated one meets it.
 *
 * Both halves of that matter. Without the simulated test there is nothing
 * the deficiency added; without the unsimulated one the check would repeat
 * axe's own `link-in-text-block` finding, which the engine pass already
 * reports on the page as it is normally rendered, under a condition that has
 * nothing to do with it.
 *
 * A link with any non-colour distinction is not reported at all: an
 * underline or other text decoration, a border, a box-shadow underline, a
 * different font weight or style, or a background of its own. That list is
 * the whole test — a reader who cannot see the colour difference can still
 * see any one of those, whatever the deficiency.
 *
 * `cvd:reduced-contrast` and `cvd:blurred-vision` are not colour
 * transformations, so they have no matrix and this check does not run under
 * them.
 */

import {
  compositeOver,
  contrastRatio,
  deltaE,
  isSimulatedDeficiency,
  parseColor,
  type Rgb,
  simulateDeficiency,
  type SimulatedDeficiency,
} from "../color.js";
import type { PerConditionCheck, RenderingFinding, RenderingTextStyle } from "../types.js";

/**
 * WCAG's link-in-text-block ratio: a link distinguished from its surrounding
 * text by colour alone needs this much contrast against that text.
 */
export const LINK_TEXT_CONTRAST_RATIO = 3;

/**
 * Two backgrounds this far apart (CIE76) are a distinction of their own, so
 * the link is not colour-only. Just above the just-noticeable difference of
 * about 2.3, which is what keeps a rounding difference between two
 * composited colours from counting as a cue.
 */
const MIN_BACKGROUND_DELTA_E = 3;

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html";

const DESCRIPTION =
  "A link inside a block of text is distinguished from the surrounding text by colour alone, and that colour difference disappears for a reader with this colour-vision deficiency.";

const HELP =
  "Give links in text blocks a distinction that is not colour: underline them, or add a border, a box-shadow underline or a heavier font weight. Colour alone needs 3:1 against the surrounding text for every reader, which a deficiency can take away.";

/** Never report more than this many links per condition. */
const MAX_FINDINGS = 25;

/** The deficiency in the words a report shows. */
const DEFICIENCY_NAMES: Record<SimulatedDeficiency, string> = {
  protanopia: "protanopia",
  deuteranopia: "deuteranopia",
  tritanopia: "tritanopia",
  achromatopsia: "achromatopsia",
};

/** What is painted: the text colour composited over the background behind it. */
function paintedColor(style: RenderingTextStyle): Rgb | null {
  const color = parseColor(style.color);
  const background = parseColor(style.background);
  if (!color || !background) return null;
  return compositeOver(color, compositeOver(background, { r: 255, g: 255, b: 255 }));
}

function sameDecoration(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** `rgb(r, g, b)`, for the evidence. */
function colorText(color: Rgb): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export const cvdLinkDistinctionCheck: PerConditionCheck = {
  id: "cvd-link-distinction",
  kind: "per-condition",
  // No element walk: the link group carries the selector, the rect and the
  // colours of both sides.
  collect: { elements: false, links: true },

  appliesTo: (condition) => isSimulatedDeficiency(condition.visionDeficiency),

  evaluate({ condition, measurement, onTruncated }) {
    const deficiency = condition.visionDeficiency;
    if (!isSimulatedDeficiency(deficiency)) return [];

    const findings: RenderingFinding[] = [];

    for (const link of measurement.links ?? []) {
      // Text on an image or a gradient: the background colour is not what is
      // on the screen, so no colour judgement is possible — the case axe
      // reports as `incomplete`.
      if (link.link.backgroundImage || link.surrounding.backgroundImage) continue;

      // Any non-colour distinction, and the link is not colour-only.
      if (!sameDecoration(link.link.decoration, link.surrounding.decoration)) continue;
      if (link.link.border !== link.surrounding.border) continue;
      if (link.link.boxShadow !== link.surrounding.boxShadow) continue;
      if (link.link.fontWeight !== link.surrounding.fontWeight) continue;
      if (link.link.fontStyle !== link.surrounding.fontStyle) continue;

      const linkColor = paintedColor(link.link);
      const textColor = paintedColor(link.surrounding);
      if (!linkColor || !textColor) continue;

      const linkBackground = parseColor(link.link.background);
      const textBackground = parseColor(link.surrounding.background);
      if (!linkBackground || !textBackground) continue;
      const background = compositeOver(linkBackground, { r: 255, g: 255, b: 255 });
      const surroundingBackground = compositeOver(textBackground, { r: 255, g: 255, b: 255 });
      // A background of its own is a distinction that is not the text colour.
      if (deltaE(background, surroundingBackground) >= MIN_BACKGROUND_DELTA_E) continue;

      const normal = contrastRatio(linkColor, textColor);
      // The page fails this as it is normally rendered: that is axe's
      // `link-in-text-block`, which the engine pass reports, not something
      // the deficiency did.
      if (normal < LINK_TEXT_CONTRAST_RATIO) continue;

      const simulatedLink = simulateDeficiency(linkColor, deficiency);
      const simulatedText = simulateDeficiency(textColor, deficiency);
      const simulated = contrastRatio(simulatedLink, simulatedText);
      if (simulated >= LINK_TEXT_CONTRAST_RATIO) continue;

      // Asked after the filters, so it is only truncation when what the cap
      // drops is a finding.
      if (findings.length >= MAX_FINDINGS) {
        onTruncated?.();
        break;
      }

      const name = DEFICIENCY_NAMES[deficiency];
      findings.push({
        checkId: "cvd-link-distinction",
        impact: "moderate",
        description: DESCRIPTION,
        help: HELP,
        helpUrl: HELP_URL,
        failureSummary: `The link "${link.text}" has no underline, border, box-shadow or font difference from the text around it, so only its colour sets it apart. That colour difference is ${normal.toFixed(2)}:1 against the surrounding text as the page is normally rendered and ${simulated.toFixed(2)}:1 under ${name} — below the 3:1 the link-in-text-block technique asks for.`,
        selector: link.selector,
        html: link.html,
        rect: link.rect,
        elementIndex: link.index,
        ...(link.anchored ? { anchored: true } : {}),
        evidence: {
          deficiency: name,
          contrast: Number(normal.toFixed(2)),
          simulatedContrast: Number(simulated.toFixed(2)),
          required: LINK_TEXT_CONTRAST_RATIO,
          linkColor: colorText(linkColor),
          textColor: colorText(textColor),
          simulatedLinkColor: colorText(simulatedLink),
          simulatedTextColor: colorText(simulatedText),
          block: link.blockSelector,
        },
      });
    }

    return findings;
  },
};
