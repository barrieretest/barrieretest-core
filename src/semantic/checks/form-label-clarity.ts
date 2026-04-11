import type { SemanticCheck } from "../types.js";

export const formLabelClarityCheck: SemanticCheck = {
  id: "form-label-clarity",
  title: "Form Label Clarity",
  description:
    "Assesses whether form labels are clear, descriptive, and provide sufficient context for assistive technology users.",
  promptSection:
    "**Form Label Clarity**: Assess if form labels are clear, descriptive, and provide sufficient context",
  needsScreenshot: true,
  needsContext: ["forms"],
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions.html",
};
