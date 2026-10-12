import type { SemanticCheck } from "../types.js";

export const langAttributeCheck: SemanticCheck = {
  id: "lang-attribute",
  title: "Language Attribute Match",
  description:
    "Reports a missing `lang` attribute on `<html>` or one that does not match the dominant language of the visible text.",
  promptSection:
    "**Language Attribute Match**: Failure when the `lang` attribute on `<html>` is missing, or when the declared language does not match the dominant language of the visible text.\n" +
    "   Not a failure: a declaration that matches the content — do not report a match at all; individual foreign words, names, or quotations inside otherwise matching content.\n" +
    '   Severity: "error".',
  needsScreenshot: false,
  needsContext: ["head", "body"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html",
};
