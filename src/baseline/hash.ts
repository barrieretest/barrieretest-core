import type { Issue } from "../types.js";

/**
 * Extracts the element tag name from an HTML string
 */
function extractElementTag(html: string): string {
  const match = html.match(/^<(\w+)/);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Generates a stable hash identifier for an accessibility issue.
 * The hash is based on: rule ID + selector + element context (tag name),
 * plus the rendering condition for a rendering finding.
 */
export function generateIssueHash(issue: Issue): string {
  const parts: string[] = [
    issue.id,
    issue.selector ?? "",
    extractElementTag(issue.nodes[0]?.html ?? ""),
  ];

  // The same element failing the same check is a different regression under
  // a different rendering condition: a paragraph that was only clipped at
  // 320 px and is now clipped under text spacing too is new. Appended, and
  // only for rendering findings, so every hash issued before stays what it
  // was.
  if (issue.rendering) {
    parts.push(issue.rendering.condition);
  }

  const input = parts.join("|");

  // Use a simple hash function (djb2)
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }

  // Convert to hex string
  return (hash >>> 0).toString(16);
}
