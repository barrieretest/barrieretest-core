/**
 * Built-in semantic check registry.
 *
 * Adding a new built-in check is two lines: a new file in this directory
 * exporting a `SemanticCheck`, and one entry in `BUILT_IN_CHECKS` below.
 *
 * Users can also pass `customChecks` at call time without modifying the
 * registry — see `SemanticOptions.customChecks`.
 */

import type { SemanticCheck, SemanticContextSection, UserCheckConfig } from "../types.js";
import { SEMANTIC_CONTEXT_SECTIONS, USER_CHECK_ID_PATTERN } from "../types.js";
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

/**
 * Convert a declarative user check config into a runtime `SemanticCheck`.
 *
 * Throws with a user-facing message when the config is invalid — the CLI
 * surfaces these as-is so authors see actionable errors.
 *
 * The runtime `promptSection` follows the built-in convention
 * (`**Title**: instruction`) so the assembled prompt stays uniform.
 */
export function userCheckConfigToSemanticCheck(cfg: UserCheckConfig): SemanticCheck {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("Custom check must be an object");
  }

  const id = String(cfg.id ?? "").trim();
  if (!id) {
    throw new Error("Custom check is missing required field 'id'");
  }
  if (!USER_CHECK_ID_PATTERN.test(id)) {
    throw new Error(
      `Custom check id '${id}' is invalid. Use 2-40 lowercase alphanumerics or hyphens, starting with a letter or digit.`
    );
  }
  if (BUILT_IN_CHECK_IDS.includes(id)) {
    throw new Error(
      `Custom check id '${id}' collides with a built-in check. Built-ins cannot be overridden; pick a different id.`
    );
  }

  const title = String(cfg.title ?? "").trim();
  if (!title) {
    throw new Error(`Custom check '${id}' is missing required field 'title'`);
  }

  const description = String(cfg.description ?? "").trim();
  if (!description) {
    throw new Error(`Custom check '${id}' is missing required field 'description'`);
  }

  const prompt = String(cfg.prompt ?? "").trim();
  if (!prompt) {
    throw new Error(`Custom check '${id}' is missing required field 'prompt'`);
  }

  const needsScreenshot = typeof cfg.needsScreenshot === "boolean" ? cfg.needsScreenshot : false;

  const needsContext = resolveUserContext(cfg.context, id);

  const helpUrl = cfg.helpUrl ? String(cfg.helpUrl) : undefined;

  return {
    id,
    title,
    description,
    promptSection: `**${title}**: ${prompt}`,
    needsScreenshot,
    needsContext,
    ...(helpUrl ? { helpUrl } : {}),
  };
}

function resolveUserContext(
  raw: SemanticContextSection[] | undefined,
  checkId: string
): SemanticContextSection[] {
  if (raw === undefined) {
    return ["body"];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Custom check '${checkId}' has an invalid 'context' field — must be a non-empty array or omitted.`
    );
  }
  const allowed = new Set<string>(SEMANTIC_CONTEXT_SECTIONS);
  const bad = raw.filter((s) => !allowed.has(s));
  if (bad.length > 0) {
    throw new Error(
      `Custom check '${checkId}' has unknown context section(s): ${bad.join(", ")}. ` +
        `Allowed: ${SEMANTIC_CONTEXT_SECTIONS.join(", ")}`
    );
  }
  return Array.from(new Set(raw));
}

export { altTextQualityCheck } from "./alt-text-quality.js";
export { ariaMismatchCheck } from "./aria-mismatch.js";
export { formLabelClarityCheck } from "./form-label-clarity.js";
export { landmarksCheck } from "./landmarks.js";
export { langAttributeCheck } from "./lang-attribute.js";
export { pageTitleCheck } from "./page-title.js";
