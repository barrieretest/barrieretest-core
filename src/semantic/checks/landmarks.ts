import type { SemanticCheck } from "../types.js";

export const landmarksCheck: SemanticCheck = {
  id: "landmarks",
  title: "Landmark Regions",
  description:
    "Reports a missing main landmark, primary content outside every landmark, generic divs used for navigation, header, or footer regions, and same-type landmarks without distinguishing labels.",
  promptSection:
    "**Landmarks**: Failure when the page has no main landmark; when primary content sits outside every landmark; when a region that is clearly navigation, header, or footer uses a generic div instead of a landmark element or role; or when two or more landmarks of the same type lack distinguishing labels.\n" +
    "   Not a failure: an unlabeled landmark when only one of that type exists; a header that contains only navigation; sections without a landmark role.\n" +
    '   Severity: "warning" for a missing main landmark, "notice" otherwise.',
  needsScreenshot: true,
  needsContext: ["landmarks"],
  helpUrl: "https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/",
};
