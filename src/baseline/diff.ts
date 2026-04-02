import type { Issue } from "../types.js";
import { generateIssueHash } from "./hash.js";
import type { BaselineFile, BaselineIssue } from "./types.js";

/**
 * Result of comparing current issues against a baseline
 */
export interface BaselineDiffResult {
  /** Issues in current run but not in baseline (new regressions) */
  new: Issue[];
  /** Issues in both current run and baseline (known issues) */
  known: Issue[];
  /** Issues in baseline but not in current run (fixed issues) */
  fixed: BaselineIssue[];
}

/**
 * Compares current issues against a baseline to identify new, known, and fixed issues.
 */
export function diffAgainstBaseline(issues: Issue[], baseline: BaselineFile): BaselineDiffResult {
  const baselineHashes = new Set(baseline.issues.map((i) => i.hash));
  const currentHashes = new Map<string, Issue>();

  // Generate hashes for current issues
  for (const issue of issues) {
    const hash = generateIssueHash(issue);
    currentHashes.set(hash, issue);
  }

  const newIssues: Issue[] = [];
  const knownIssues: Issue[] = [];

  // Categorize current issues
  for (const [hash, issue] of currentHashes) {
    if (baselineHashes.has(hash)) {
      knownIssues.push(issue);
    } else {
      newIssues.push(issue);
    }
  }

  // Find fixed issues (in baseline but not in current)
  const fixedIssues = baseline.issues.filter(
    (baselineIssue) => !currentHashes.has(baselineIssue.hash)
  );

  return {
    new: newIssues,
    known: knownIssues,
    fixed: fixedIssues,
  };
}
