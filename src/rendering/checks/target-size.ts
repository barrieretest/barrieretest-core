/**
 * WCAG 2.5.8 Target Size (Minimum), as axe sees it under a viewport.
 *
 * The rule ships disabled in axe-core and is now enabled in the engine pass
 * as well (contract decision 2 of 2026-10-14), so the baseline viewport is
 * covered there too; what this adds is the phone, where targets sit closer
 * together and a tap area that passes at 1280 px can fail at 360 px, and the
 * capture that shows it.
 *
 * Axe's `incomplete` results — a target it could not decide about, usually
 * because something overlaps it — become findings marked as needing review:
 * same issue shape, `needsReview: true` in the evidence and a failure
 * summary that opens with it, so a report can separate them from the ones
 * axe is sure about.
 *
 * A target the engine pass already reported is not reported again, at any
 * viewport: the engine pass audits at the caller's viewport, 1280 by
 * default, so on a live page the same two search buttons came back from
 * both and cost the score twice for one problem. What this check adds is
 * the target that passes at the engine pass's viewport and fails on the
 * phone, typically because spacing collapses in the narrow layout.
 */

import type { PerConditionCheck, RenderingFinding } from "../types.js";

/** The axe rule this check is a thin, condition-aware wrapper around. */
export const TARGET_SIZE_RULE = "target-size";

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html";

const DESCRIPTION = "Touch targets are smaller than 24 by 24 CSS px and sit too close together.";

const HELP =
  "Give every touch target at least 24 by 24 CSS px, or enough space around it that a 24 px circle on its centre touches no other target.";

/** Never report more than this many targets per condition. */
const MAX_FINDINGS = 25;

/** The viewport the engine pass itself audits at, unless a caller says otherwise. */
const BASELINE_VIEWPORT_WIDTH = 1280;

/** Axe's summaries are multi-line lists; one line reads better in a report. */
function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export const targetSizeCheck: PerConditionCheck = {
  id: "target-size",
  kind: "per-condition",
  // No element walk: axe's own nodes carry everything, rect included.
  collect: { elements: false, axeRules: [TARGET_SIZE_RULE] },

  // The phone, where the rule bites, and the baseline viewport, so a report
  // can show the same targets as the page is normally rendered.
  appliesTo: (condition) =>
    condition.viewport !== undefined &&
    (condition.viewport.width === 360 || condition.viewport.width === BASELINE_VIEWPORT_WIDTH),

  evaluate({ condition, measurement, onTruncated }) {
    const findings: RenderingFinding[] = [];
    const width = Math.round(condition.viewport?.width ?? 0);

    for (const result of measurement.axe?.results ?? []) {
      if (result.id !== TARGET_SIZE_RULE) continue;
      const needsReview = result.outcome === "incomplete";

      for (const node of result.nodes) {
        // The engine pass already reported this target.
        if (node.inBaseline) continue;
        if (findings.length >= MAX_FINDINGS) {
          onTruncated?.();
          break;
        }

        const summary = oneLine(node.failureSummary);
        findings.push({
          checkId: "target-size",
          // As axe reports it, which is what the contract asks for.
          impact: node.impact,
          description: result.description || DESCRIPTION,
          help: result.help || HELP,
          helpUrl: result.helpUrl || HELP_URL,
          failureSummary: needsReview
            ? `Needs review: at a ${width} px wide viewport axe could not decide whether this target is large enough.${summary ? ` ${summary}` : ""}`
            : `At a ${width} px wide viewport: ${summary || "the target is smaller than 24 by 24 CSS px and has no space around it."}`,
          selector: node.selector === "" ? null : node.selector,
          ...(node.html ? { html: node.html } : {}),
          ...(node.rect ? { rect: node.rect } : {}),
          elementIndex: node.index,
          ...(node.anchored ? { anchored: true } : {}),
          evidence: {
            rule: TARGET_SIZE_RULE,
            viewportWidth: width,
            outcome: result.outcome,
            ...(needsReview ? { needsReview: true } : {}),
          },
        });
      }
    }

    return findings;
  },
};
