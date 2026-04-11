import type { SemanticCheck } from "../types.js";

export const pageTitleCheck: SemanticCheck = {
  id: "page-title",
  title: "Page Title Quality",
  description:
    "Evaluates whether the page title is descriptive, unique, and accurately represents the page content.",
  promptSection:
    "**Page Title Quality**: Evaluate if the page title is descriptive, unique, and accurately represents the page content",
  needsScreenshot: true,
  needsContext: ["head"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/page-titled.html",
};
