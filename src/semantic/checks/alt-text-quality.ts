import type { SemanticCheck } from "../types.js";

export const altTextQualityCheck: SemanticCheck = {
  id: "alt-text-quality",
  title: "Alt Text Quality",
  description:
    "Reports informative images whose alt text is missing, empty, a placeholder, in the wrong language, or contradicted by what the image shows.",
  promptSection:
    "**Alt Text Quality**: Decide per image by looking up its line in the IMAGES section, in this order:\n" +
    '   a) The line says `alt text = (missing)` — the alt attribute is absent. Failure, severity "error".\n' +
    '   b) The line says `alt text = (empty)` — `alt=""`. Failure with severity "error" when the screenshot shows an informative image at that position: a photo, a screenshot, a chart, a product image, or a logo that is the only content of a link or button. Not a failure when the screenshot shows a purely decorative image: a background, a divider, an icon next to a text label, or an image inside a link or button that already has text.\n' +
    '   c) The line shows an alt text, e.g. `alt text = "Portrait von X"`. Failure only when that alt text is a filename, a generic placeholder, identical to the visible text next to it, in a different language than the page content, or contradicts what the screenshot shows at that position. Otherwise it is not a failure, however short it is.\n' +
    "   The `alt text =` value is the alt attribute. The `selector =` value is only where the image is; it is never the alt text and must not be judged.\n" +
    '   A line that also shows `accessible name = "…" (via aria-label)` or `(via aria-labelledby)` names the image through ARIA: judge that name instead of the alt, and an empty alt with such a name is not a failure.\n' +
    "   A filename alt means the alt text itself ends in an image extension or is a hash. Compare the alt text only.\n" +
    "   Sufficient alt texts, never a failure: `Screenshot of the SELF tool.`, `Portrait of Andreas Steinkellner`, `Acurion Logo`, `Mitglieds-Logo der Charta der Vielfalt`. An alt is generic only when it carries no information about this particular image, such as `image`, `photo`, `logo`, `icon`, `Bild`.\n" +
    "   Evaluate exactly the images listed in the IMAGES section and no others; images absent from the list are out of scope.\n" +
    '   The IMAGES section is the authoritative record of each image\'s alt attribute. Never report an alt as missing or empty when the line shows an alt text. Quote the alt value from the line in "context".\n' +
    "   Report `location` as the `selector =` value, unchanged.\n" +
    '   Severity: "error" for a missing alt, an empty alt on an informative image, or a filename or placeholder alt; "warning" for a wrong-language, duplicated, or contradicting alt.',
  needsScreenshot: true,
  needsContext: ["images"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html",
};
