/**
 * Built-in rendering check registry.
 *
 * Adding a check is two lines: a new file in this directory exporting a
 * `RenderingCheck`, and one entry in `BUILT_IN_RENDERING_CHECKS` below,
 * mirroring `src/semantic/checks/`.
 */

import type { RenderingCheck } from "../types.js";
import { contentHiddenAtViewportCheck } from "./content-hidden-at-viewport.js";
import { contrastUnderModeCheck } from "./contrast-under-mode.js";
import { cvdLinkDistinctionCheck } from "./cvd-link-distinction.js";
import { cvdStateByColorCheck } from "./cvd-state-by-color.js";
import { forcedColorsLossCheck } from "./forced-colors-loss.js";
import { motionNotReducedCheck } from "./motion-not-reduced.js";
import { overflowClippedTextCheck } from "./overflow-clipped-text.js";
import { overlapTextCheck } from "./overlap-text.js";
import { reflowHorizontalScrollCheck } from "./reflow-horizontal-scroll.js";
import { targetSizeCheck } from "./target-size.js";

export const BUILT_IN_RENDERING_CHECKS: readonly RenderingCheck[] = [
  reflowHorizontalScrollCheck,
  overflowClippedTextCheck,
  overlapTextCheck,
  contentHiddenAtViewportCheck,
  targetSizeCheck,
  contrastUnderModeCheck,
  forcedColorsLossCheck,
  motionNotReducedCheck,
  cvdLinkDistinctionCheck,
  cvdStateByColorCheck,
];

export const BUILT_IN_RENDERING_CHECK_IDS: readonly string[] = BUILT_IN_RENDERING_CHECKS.map(
  (check) => check.id
);

/**
 * Resolve the checks to run. Throws on an unknown id, naming what is known:
 * a typo must not silently run less than was asked for.
 */
export function resolveRenderingChecks(requestedIds?: string[]): RenderingCheck[] {
  if (!requestedIds || requestedIds.length === 0) return [...BUILT_IN_RENDERING_CHECKS];

  const registry = new Map(BUILT_IN_RENDERING_CHECKS.map((check) => [check.id, check]));
  const resolved: RenderingCheck[] = [];
  const unknown: string[] = [];

  for (const id of requestedIds) {
    const check = registry.get(id);
    if (check) {
      if (!resolved.includes(check)) resolved.push(check);
    } else {
      unknown.push(id);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown rendering check id(s): ${unknown.join(", ")}. Known: ${BUILT_IN_RENDERING_CHECK_IDS.join(", ")}`
    );
  }

  return resolved;
}

export { contentHiddenAtViewportCheck } from "./content-hidden-at-viewport.js";
export { contrastUnderModeCheck } from "./contrast-under-mode.js";
export { cvdLinkDistinctionCheck } from "./cvd-link-distinction.js";
export { cvdStateByColorCheck } from "./cvd-state-by-color.js";
export { forcedColorsLossCheck } from "./forced-colors-loss.js";
export { motionNotReducedCheck } from "./motion-not-reduced.js";
export { overflowClippedTextCheck } from "./overflow-clipped-text.js";
export { overlapTextCheck } from "./overlap-text.js";
export { reflowHorizontalScrollCheck } from "./reflow-horizontal-scroll.js";
export { targetSizeCheck } from "./target-size.js";
