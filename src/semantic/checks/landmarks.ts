import type { SemanticCheck } from "../types.js";

export const landmarksCheck: SemanticCheck = {
  id: "landmarks",
  title: "Landmark Regions",
  description:
    "Identifies landmark regions (main, navigation, complementary, etc.) and verifies they are properly labeled.",
  promptSection:
    "**Landmarks**: Identify landmark regions (main, navigation, complementary, etc.) and check if they're properly labeled",
  needsScreenshot: true,
  needsContext: ["landmarks"],
  helpUrl: "https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/",
};
