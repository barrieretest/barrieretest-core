import type { Issue } from "../types";

/**
 * Extracts the element tag name from an HTML string
 */
function extractElementTag(html: string): string {
  const match = html.match(/^<(\w+)/);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Generates a stable hash identifier for an accessibility issue.
 * The hash is based on: rule ID + selector + element context (tag name)
 */
export function generateIssueHash(issue: Issue): string {
  const parts: string[] = [
    issue.id,
    issue.selector ?? "",
    extractElementTag(issue.nodes[0]?.html ?? ""),
  ];

  const input = parts.join("|");

  // Use a simple hash function (djb2)
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }

  // Convert to hex string
  return (hash >>> 0).toString(16);
}
