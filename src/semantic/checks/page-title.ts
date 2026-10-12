import type { SemanticCheck } from "../types.js";

export const pageTitleCheck: SemanticCheck = {
  id: "page-title",
  title: "Page Title Quality",
  description:
    "Reports page titles that are missing, generic, in a different language than the content, or unrelated to the content.",
  promptSection:
    '**Page Title Quality**: Failure when the page has no title; when the title is generic ("Home", "Untitled", the bare domain name); when it is in a different language than the content; or when it is unrelated to what the page is about.\n' +
    "   Not a failure: a title that is specific and matches the content, even if it could be shorter or longer.\n" +
    '   Severity: "warning".',
  needsScreenshot: true,
  needsContext: ["head"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/page-titled.html",
};
