/**
 * `barrieretest check add` — interactive wizard for authoring a
 * `UserCheckConfig`. Mirrors the style of `init-wizard.ts`.
 *
 * The wizard is a thin TUI on top of pure helpers — `buildCheckFromAnswers`
 * and validation live in `check.ts` / `semantic/checks/index.ts` and are
 * what the tests actually exercise.
 */

import { BUILT_IN_CHECK_IDS } from "../semantic/checks/index.js";
import {
  SEMANTIC_CONTEXT_SECTIONS,
  USER_CHECK_ID_PATTERN,
  type SemanticContextSection,
  type UserCheckConfig,
} from "../semantic/types.js";
import { confirm, multiselect, select, text } from "./prompt.js";

export type WizardScope = "global" | "project";

export interface CheckWizardAnswers {
  check: UserCheckConfig;
  scope: WizardScope;
}

export interface CheckWizardContext {
  /** Existing user check IDs in global scope. */
  globalIds: readonly string[];
  /** Existing user check IDs in project scope (if a project config is active). */
  projectIds: readonly string[];
  /** Whether a project config file was discovered. */
  projectDiscovered: boolean;
}

/**
 * Drive the full check-add wizard. Returns the authored check plus the
 * scope the user chose.
 */
export async function runCheckAddWizard(ctx: CheckWizardContext): Promise<CheckWizardAnswers> {
  const scope = await select<WizardScope>({
    message: "Save this check to:",
    options: [
      {
        value: "project",
        label: "Project (.barrieretest.json in repo root)",
        hint: ctx.projectDiscovered ? "existing" : "will be created",
      },
      {
        value: "global",
        label: "Global (~/.barrieretest/config.json)",
        hint: "applies to every project",
      },
    ],
  });

  const existingInScope = scope === "project" ? ctx.projectIds : ctx.globalIds;

  const id = await text({
    message: "Check id (lowercase, 2-40 chars, alphanumerics and hyphens):",
    validate: (v) => validateIdForScope(v, existingInScope),
  });

  const title = await text({
    message: "Short title (shown in reports):",
    validate: (v) => (v.trim() ? null : "Title cannot be empty."),
  });

  const description = await text({
    message: "One-line description:",
    validate: (v) => (v.trim() ? null : "Description cannot be empty."),
  });

  const prompt = await text({
    message: "Prompt for the AI (what should it look for?):",
    validate: (v) => (v.trim().length >= 10 ? null : "Prompt must be at least 10 characters."),
  });

  const needsScreenshot = await confirm({
    message: "Does this check need a screenshot (visual reasoning)?",
    default: false,
  });

  const context = await multiselect<SemanticContextSection>({
    message: "Which page-context sections should the AI receive?",
    options: SEMANTIC_CONTEXT_SECTIONS.map((s) => ({
      value: s,
      label: s,
      hint: CONTEXT_HINTS[s],
    })),
    initialValues: ["body"],
    required: true,
  });

  const check: UserCheckConfig = {
    id: id.trim(),
    title: title.trim(),
    description: description.trim(),
    prompt: prompt.trim(),
    needsScreenshot,
    context,
  };

  return { check, scope };
}

/**
 * Shared validator for the ID prompt. Also reused by the non-interactive
 * flag-based flow, so keeping it exported.
 */
export function validateIdForScope(
  value: string,
  existingInScope: readonly string[]
): string | null {
  const v = value.trim();
  if (!v) return "ID cannot be empty.";
  if (!USER_CHECK_ID_PATTERN.test(v)) {
    return "Use 2-40 lowercase alphanumerics or hyphens, starting with a letter or digit.";
  }
  if ((BUILT_IN_CHECK_IDS as readonly string[]).includes(v)) {
    return `'${v}' is a built-in check id. Pick a different one.`;
  }
  if (existingInScope.includes(v)) {
    return `'${v}' already exists in this scope.`;
  }
  return null;
}

const CONTEXT_HINTS: Record<SemanticContextSection, string> = {
  head: "<title>, <meta>, <link>",
  body: "visible page text",
  aria: "aria-* attributes on elements",
  forms: "<form>, <input>, <label>",
  images: '<img> and role="img"',
  landmarks: "header/main/nav/etc.",
};
