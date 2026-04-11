/**
 * Built-in semantic check registry.
 *
 * Adding a new built-in check is two lines: a new file in this directory
 * exporting a `SemanticCheck`, and one entry in `BUILT_IN_CHECKS` below.
 *
 * Users can also pass `customChecks` at call time without modifying the
 * registry — see `SemanticOptions.customChecks`.
 */

import type { SemanticCheck } from "../types.js";
import { altTextQualityCheck } from "./alt-text-quality.js";
import { ariaMismatchCheck } from "./aria-mismatch.js";
import { formLabelClarityCheck } from "./form-label-clarity.js";
import { landmarksCheck } from "./landmarks.js";
import { langAttributeCheck } from "./lang-attribute.js";
import { pageTitleCheck } from "./page-title.js";

export const BUILT_IN_CHECKS: readonly SemanticCheck[] = [
  ariaMismatchCheck,
  pageTitleCheck,
  altTextQualityCheck,
  formLabelClarityCheck,
  langAttributeCheck,
  landmarksCheck,
];

export const BUILT_IN_CHECK_IDS: readonly string[] = BUILT_IN_CHECKS.map((c) => c.id);

/**
 * Resolve the set of checks to run for a given semanticAudit invocation.
 *
 * - When `requestedIds` is provided, only those IDs are kept.
 * - `customChecks` are merged in. A custom check with the same ID as a
 *   built-in check overrides it (so users can tweak prompt sections).
 * - Throws if any requested ID is unknown — surfacing typos early.
 */
export function resolveChecks(
  requestedIds: string[] | undefined,
  customChecks: SemanticCheck[] | undefined
): SemanticCheck[] {
  const registry = new Map<string, SemanticCheck>();
  for (const check of BUILT_IN_CHECKS) {
    registry.set(check.id, check);
  }
  for (const check of customChecks ?? []) {
    registry.set(check.id, check);
  }

  if (!requestedIds || requestedIds.length === 0) {
    return Array.from(registry.values());
  }

  const resolved: SemanticCheck[] = [];
  const unknown: string[] = [];
  for (const id of requestedIds) {
    const check = registry.get(id);
    if (check) {
      resolved.push(check);
    } else {
      unknown.push(id);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown semantic check id(s): ${unknown.join(", ")}. ` +
        `Known: ${Array.from(registry.keys()).join(", ")}`
    );
  }

  return resolved;
}

export { altTextQualityCheck } from "./alt-text-quality.js";
export { ariaMismatchCheck } from "./aria-mismatch.js";
export { formLabelClarityCheck } from "./form-label-clarity.js";
export { landmarksCheck } from "./landmarks.js";
export { langAttributeCheck } from "./lang-attribute.js";
export { pageTitleCheck } from "./page-title.js";
