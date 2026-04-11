import type { SemanticCheck } from "../types.js";

export const langAttributeCheck: SemanticCheck = {
  id: "lang-attribute",
  title: "Language Attribute Match",
  description:
    "Checks whether the declared `lang` attribute on `<html>` matches the actual language of the page content.",
  promptSection:
    "**Language Attribute Match**: Check if the declared lang attribute matches the actual language of the page content",
  needsScreenshot: false,
  needsContext: ["head", "body"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html",
};
