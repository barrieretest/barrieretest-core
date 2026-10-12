import type { SemanticCheck } from "../types.js";

export const formLabelClarityCheck: SemanticCheck = {
  id: "form-label-clarity",
  title: "Form Label Clarity",
  description:
    "Reports form fields that have no label at all or a label too generic to indicate the expected input.",
  promptSection:
    '**Form Label Clarity**: Failure when a field has no label and relies on a placeholder alone; when the label is so generic that the expected input stays unclear ("Field 1", "Input", "Auswahl"); or when the label contradicts the field type.\n' +
    '   Not a failure: short labels that name the input ("Name", "E-Mail"); labels that do not explain the purpose of the whole form; labels written in the page language.\n' +
    "   The FORM ELEMENTS section lists one line per field with its resolved label. A field whose line shows `label: (none)` and no `aria-label` or `aria-labelledby` is unlabeled; a field whose line shows a label text is labeled, regardless of whether it also has a placeholder.\n" +
    '   Severity: "error" for a missing label, "warning" for an unclear or contradicting one.',
  needsScreenshot: true,
  needsContext: ["forms"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions.html",
};
