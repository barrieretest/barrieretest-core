import type { SemanticCheck } from "../types.js";

export const ariaMismatchCheck: SemanticCheck = {
  id: "aria-mismatch",
  title: "ARIA Label Mismatches",
  description:
    "Detects elements where aria-label/aria-labelledby text contradicts the visible text or visual content.",
  promptSection:
    "**ARIA Label Mismatches**: Find elements where aria-label/aria-labelledby text doesn't match the visible text or visual content",
  needsScreenshot: true,
  needsContext: ["aria"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/label-in-name.html",
};
