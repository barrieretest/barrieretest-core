import type { DetailLevel, Issue, IssueSeverity } from "./types.js";

export interface MinimalIssue {
  id: string;
  impact: IssueSeverity;
  count: number;
}

export interface ActionableIssue {
  id: string;
  impact: IssueSeverity;
  description: string;
  help: string;
  selector: string | null;
  wcagCriterion: string | null;
  count: number;
}

export interface FixReadyIssue {
  id: string;
  impact: IssueSeverity;
  description: string;
  help: string;
  selector: string | null;
  wcagCriterion: string | null;
  count: number;
  failureSummary: string | null;
  codeSnippet: string | null;
  documentationUrl: string | null;
}

type IssueGroup = {
  issue: Issue;
  count: number;
};

const severityOrder: IssueSeverity[] = ["critical", "serious", "moderate", "minor"];

function sortBySeverityAndCount(
  a: { impact: IssueSeverity; count: number },
  b: { impact: IssueSeverity; count: number }
): number {
  const severityDiff = severityOrder.indexOf(a.impact) - severityOrder.indexOf(b.impact);
  if (severityDiff !== 0) return severityDiff;
  return b.count - a.count;
}

function groupIssuesByKey(
  issues: Issue[],
  getKey: (issue: Issue) => string = (issue) => issue.id
): Map<string, IssueGroup> {
  const groups = new Map<string, IssueGroup>();

  for (const issue of issues) {
    const key = getKey(issue);
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, { issue, count: 1 });
    }
  }

  return groups;
}

function getFixReadyIssueKey(issue: Issue): string {
  return JSON.stringify({
    id: issue.id,
    impact: issue.impact,
    description: issue.description,
    help: issue.help,
    helpUrl: issue.helpUrl ?? null,
    failureSummary: issue.failureSummary ?? null,
    selector: issue.selector,
    codeSnippet: issue.nodes[0]?.html ?? null,
  });
}

function extractWcagCriterion(issueId: string): string | null {
  const match = issueId.match(/(\d+)_(\d+)_(\d+)/);
  if (match) {
    return `${match[1]}.${match[2]}.${match[3]}`;
  }
  return null;
}

export function formatMinimal(issues: Issue[]): MinimalIssue[] {
  const groups = groupIssuesByKey(issues);
  return Array.from(groups.values())
    .map(({ issue, count }) => ({
      id: issue.id,
      impact: issue.impact,
      count,
    }))
    .sort(sortBySeverityAndCount);
}

export function formatActionable(issues: Issue[]): ActionableIssue[] {
  const groups = groupIssuesByKey(issues);
  return Array.from(groups.values())
    .map(({ issue, count }) => ({
      id: issue.id,
      impact: issue.impact,
      description: issue.description,
      help: issue.help,
      selector: issue.selector,
      wcagCriterion: extractWcagCriterion(issue.id),
      count,
    }))
    .sort(sortBySeverityAndCount);
}

export function formatFixReady(issues: Issue[]): FixReadyIssue[] {
  const groups = groupIssuesByKey(issues, getFixReadyIssueKey);
  return Array.from(groups.values())
    .map(({ issue, count }) => ({
      id: issue.id,
      impact: issue.impact,
      description: issue.description,
      help: issue.help,
      selector: issue.selector,
      wcagCriterion: extractWcagCriterion(issue.id),
      count,
      failureSummary: issue.failureSummary ?? null,
      codeSnippet: issue.nodes[0]?.html || null,
      documentationUrl: issue.helpUrl ?? null,
    }))
    .sort(sortBySeverityAndCount);
}

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
