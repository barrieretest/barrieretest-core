import type { DetailLevel, Issue, IssueSeverity } from "./types.js";

/**
 * Minimal issue representation (rule, severity, count)
 */
export interface MinimalIssue {
  id: string;
  impact: IssueSeverity;
  count: number;
}

/**
 * Actionable issue representation (minimal + selector, WCAG, description)
 */
export interface ActionableIssue {
  id: string;
  impact: IssueSeverity;
  description: string;
  selector: string | null;
  wcagCriterion: string | null;
  count: number;
}

/**
 * Fix-ready issue representation (actionable + suggested fix, code snippet, docs)
 */
export interface FixReadyIssue {
  id: string;
  impact: IssueSeverity;
  description: string;
  selector: string | null;
  wcagCriterion: string | null;
  count: number;
  suggestedFix: string;
  codeSnippet: string | null;
  documentationUrl: string | null;
}

/**
 * Grouped issue counts by rule ID
 */
type IssueGroup = {
  issue: Issue;
  count: number;
};

/**
 * Group issues by their rule ID and count occurrences
 */
function groupIssues(issues: Issue[]): Map<string, IssueGroup> {
  const groups = new Map<string, IssueGroup>();

  for (const issue of issues) {
    const existing = groups.get(issue.id);
    if (existing) {
      existing.count++;
    } else {
      groups.set(issue.id, { issue, count: 1 });
    }
  }

  return groups;
}

/**
 * Extract WCAG criterion from issue ID
 * e.g., "WCAG2AA.Principle1.Guideline1_4.1_4_3" -> "1.4.3"
 */
function extractWcagCriterion(issueId: string): string | null {
  // Match patterns like "1_4_3" and convert to "1.4.3"
  const match = issueId.match(/(\d+)_(\d+)_(\d+)/);
  if (match) {
    return `${match[1]}.${match[2]}.${match[3]}`;
  }
  return null;
}

/**
 * Generate a suggested fix based on the issue type
 */
function generateSuggestedFix(issue: Issue): string {
  const criterion = extractWcagCriterion(issue.id);

  // Common fixes based on WCAG criteria
  const fixes: Record<string, string> = {
    "1.4.3": "Ensure text has a contrast ratio of at least 4.5:1 against its background.",
    "1.4.6": "Ensure text has a contrast ratio of at least 7:1 against its background.",
    "1.1.1": 'Add descriptive alt text to images, or mark decorative images with alt="".',
    "1.3.1": "Use semantic HTML elements and ARIA roles to convey structure.",
    "2.4.1": "Add skip links to allow users to bypass repeated content.",
    "2.4.2": "Provide a descriptive page title using the <title> element.",
    "2.4.4": "Ensure link text clearly describes the link destination.",
    "2.4.6": "Use descriptive headings and labels that identify the purpose.",
    "3.1.1": "Specify the page language using the lang attribute on <html>.",
    "3.1.2": "Mark language changes within content using the lang attribute.",
    "4.1.1": "Fix HTML validation errors such as duplicate IDs or invalid nesting.",
    "4.1.2": "Ensure all interactive elements have accessible names and roles.",
  };

  if (criterion && fixes[criterion]) {
    return fixes[criterion];
  }

  // Generic fix based on severity
  switch (issue.impact) {
    case "critical":
      return "This is a critical accessibility barrier. Review the element and ensure it meets WCAG requirements.";
    case "serious":
      return "This issue significantly impacts accessibility. Review the WCAG criterion and apply the appropriate fix.";
    case "moderate":
      return "Consider addressing this issue to improve accessibility for all users.";
    default:
      return "Review this element for potential accessibility improvements.";
  }
}

/**
 * Generate documentation URL for a WCAG criterion
 */
function getDocumentationUrl(issue: Issue): string | null {
  const criterion = extractWcagCriterion(issue.id);
  if (criterion) {
    // Link to WCAG Quick Reference
    const criterionSlug = criterion.replace(/\./g, "");
    return `https://www.w3.org/WAI/WCAG21/Understanding/${criterionSlug}`;
  }
  return issue.helpUrl || null;
}

/**
 * Format issues at minimal detail level
 * Returns aggregated issues with rule, severity, and count
 */
export function formatMinimal(issues: Issue[]): MinimalIssue[] {
  const groups = groupIssues(issues);
  return Array.from(groups.values())
    .map(({ issue, count }) => ({
      id: issue.id,
      impact: issue.impact,
      count,
    }))
    .sort((a, b) => {
      // Sort by severity (critical first), then by count
      const severityOrder = ["critical", "serious", "moderate", "minor"];
      const severityDiff = severityOrder.indexOf(a.impact) - severityOrder.indexOf(b.impact);
      if (severityDiff !== 0) return severityDiff;
      return b.count - a.count;
    });
}

/**
 * Format issues at actionable detail level
 * Returns issues with selector, WCAG criterion, and description
 */
export function formatActionable(issues: Issue[]): ActionableIssue[] {
  const groups = groupIssues(issues);
  return Array.from(groups.values())
    .map(({ issue, count }) => ({
      id: issue.id,
      impact: issue.impact,
      description: issue.description,
      selector: issue.selector,
      wcagCriterion: extractWcagCriterion(issue.id),
      count,
    }))
    .sort((a, b) => {
      const severityOrder = ["critical", "serious", "moderate", "minor"];
      const severityDiff = severityOrder.indexOf(a.impact) - severityOrder.indexOf(b.impact);
      if (severityDiff !== 0) return severityDiff;
      return b.count - a.count;
    });
}

/**
 * Format issues at fix-ready detail level
 * Returns issues with suggested fixes, code snippets, and documentation
 */
export function formatFixReady(issues: Issue[]): FixReadyIssue[] {
  const groups = groupIssues(issues);
  return Array.from(groups.values())
    .map(({ issue, count }) => ({
      id: issue.id,
      impact: issue.impact,
      description: issue.description,
      selector: issue.selector,
      wcagCriterion: extractWcagCriterion(issue.id),
      count,
      suggestedFix: generateSuggestedFix(issue),
      codeSnippet: issue.nodes[0]?.html || null,
      documentationUrl: getDocumentationUrl(issue),
    }))
    .sort((a, b) => {
      const severityOrder = ["critical", "serious", "moderate", "minor"];
      const severityDiff = severityOrder.indexOf(a.impact) - severityOrder.indexOf(b.impact);
      if (severityDiff !== 0) return severityDiff;
      return b.count - a.count;
    });
}

/**
 * Format issues based on detail level
 */
export function formatIssues(
  issues: Issue[],
  detail: DetailLevel = "actionable"
): MinimalIssue[] | ActionableIssue[] | FixReadyIssue[] {
  switch (detail) {
    case "minimal":
      return formatMinimal(issues);
    case "fix-ready":
      return formatFixReady(issues);
    case "actionable":
    default:
      return formatActionable(issues);
  }
}
