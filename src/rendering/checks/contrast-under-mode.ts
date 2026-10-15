/**
 * Contrast and link distinction that only fail in a colour mode.
 *
 * Axe's `color-contrast` and `link-in-text-block` run again under
 * `media:dark`, `media:forced-colors` and `media:more-contrast`, and a node
 * is a finding only when the engine pass did not already report the same
 * rule on the same element: what is reported is what the mode broke, not the
 * page's own contrast problems a second time. The collection marks every
 * node it found in the baseline (`inBaseline`), so this stays a pure
 * function of the data it is handed.
 *
 * Only axe's violations count. Its `incomplete` results for contrast are the
 * cases it cannot measure at all — text over an image or a gradient — and
 * they are as undecidable in the baseline as they are under the mode, so
 * reporting them here would say "this mode broke it" about something nobody
 * measured.
 *
 * One thing axe cannot measure under forced colours either: it reads
 * `-webkit-text-fill-color` in preference to `color`, and Chromium forces
 * `color` and paints with it while leaving the fill colour at the author's
 * value. An element that the forced palette reaches and whose two values
 * disagree then yields a contrast ratio for a colour that is nowhere on the
 * screen — 14 of 14 findings on one live site, measured 2026-10-15 — so
 * under `media:forced-colors` those `color-contrast` nodes are dropped. The
 * collection decides that, not this check: an element that opted out of the
 * forced palette (`forced-color-adjust: none`) keeps both of its author-set
 * values, so axe measured what is painted and the finding stands, which is
 * the case worth having.
 */

import type { MediaFeatures, PerConditionCheck, RenderingFinding } from "../types.js";

/** The axe rules this check re-runs under the mode. */
export const CONTRAST_RULES = ["color-contrast", "link-in-text-block"];

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html";

/** Never report more than this many nodes per condition. */
const MAX_FINDINGS = 25;

/** The mode in the words a report shows. */
function modeName(media: MediaFeatures | undefined): string {
  if (media?.colorScheme === "dark") return "dark mode";
  if (media?.forcedColors === "active") return "forced colours";
  if (media?.prefersContrast === "more") return "the increased-contrast mode";
  return "this mode";
}

function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export const contrastUnderModeCheck: PerConditionCheck = {
  id: "contrast-under-mode",
  kind: "per-condition",
  // No element walk: axe's nodes carry the selector, the summary and the rect.
  collect: { elements: false, axeRules: CONTRAST_RULES },

  appliesTo: (condition) =>
    condition.media?.colorScheme === "dark" ||
    condition.media?.forcedColors === "active" ||
    condition.media?.prefersContrast === "more",

  evaluate({ condition, measurement, onTruncated }) {
    const findings: RenderingFinding[] = [];
    const mode = modeName(condition.media);
    const forcedColors = condition.media?.forcedColors === "active";

    for (const result of measurement.axe?.results ?? []) {
      if (!CONTRAST_RULES.includes(result.id)) continue;
      if (result.outcome !== "violation") continue;

      for (const node of result.nodes) {
        // The page already fails this rule here; the mode added nothing.
        if (node.inBaseline) continue;
        // Axe measured a colour forced colours do not paint.
        if (forcedColors && result.id === "color-contrast" && node.textFillMismatch) continue;
        if (findings.length >= MAX_FINDINGS) {
          onTruncated?.();
          break;
        }

        const summary = oneLine(node.failureSummary);
        findings.push({
          checkId: "contrast-under-mode",
          // As axe reports it, which is what the contract asks for.
          impact: node.impact,
          description: `${result.description} This fails under ${mode} only; the page passes it as it is normally rendered.`,
          help: result.help,
          helpUrl: result.helpUrl || HELP_URL,
          failureSummary: `Under ${mode}: ${summary || "axe reports this element as failing the rule."} The engine pass did not report this element for ${result.id}.`,
          selector: node.selector === "" ? null : node.selector,
          ...(node.html ? { html: node.html } : {}),
          ...(node.rect ? { rect: node.rect } : {}),
          elementIndex: node.index,
          ...(node.anchored ? { anchored: true } : {}),
          evidence: {
            rule: result.id,
            mode,
            inBaseline: false,
          },
        });
      }
    }

    return findings;
  },
};
