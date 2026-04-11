import type { SemanticCheck } from "../types.js";

export const altTextQualityCheck: SemanticCheck = {
  id: "alt-text-quality",
  title: "Alt Text Quality",
  description:
    "Checks whether image alt texts meaningfully describe the image — not just whether an alt attribute is present.",
  promptSection:
    "**Alt Text Quality**: Check if image alt texts are meaningful and describe the image content (not just present, but actually useful)",
  needsScreenshot: true,
  needsContext: ["images"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html",
};
