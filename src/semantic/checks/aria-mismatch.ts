import type { SemanticCheck } from "../types.js";

export const ariaMismatchCheck: SemanticCheck = {
  id: "aria-mismatch",
  title: "ARIA Label Mismatches",
  description:
    "Reports controls whose accessible name from aria-label or aria-labelledby contradicts or omits their visible text.",
  promptSection:
    "**ARIA Label Mismatches**: Failure when an aria-label or aria-labelledby yields an accessible name that contradicts the visible text of the same control, omits that visible text, or describes a different action than the control performs.\n" +
    "   Not a failure: an aria-label identical to the visible text (redundant but harmless); a label that adds context while still containing the visible text.\n" +
    '   Severity: "error" when the announced action differs from the actual action, "warning" otherwise.',
  needsScreenshot: true,
  needsContext: ["aria"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/label-in-name.html",
};
