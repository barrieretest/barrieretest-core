import type { Issue } from "../types";
import { CACHE_DIR, saveLastRun } from "./cache";
import { type BaselineDiffResult, diffAgainstBaseline } from "./diff";
import type { BaselineFile, BaselineIssue } from "./types";
import { readBaseline, updateBaseline as updateBaselineFile, writeBaseline } from "./write";

/**
 * Baseline information included in audit results
 */
export interface BaselineInfo {
  /** Path to the baseline file */
  path: string;
  /** New issues (regressions) not in baseline */
  newIssues: Issue[];
  /** Issues that match the baseline */
  knownIssues: Issue[];
  /** Issues in baseline but now fixed */
  fixedIssues: BaselineIssue[];
}

/**
 * Options for baseline processing
 */
export interface BaselineProcessOptions {
  /** Path to baseline file */
  baseline?: string;
  /** Whether to update/create baseline with current issues */
  updateBaseline?: boolean;
}

/**
 * Result of processing audit with baseline
 */
export interface BaselineIntegrationResult {
  /** All issues from the audit */
  allIssues: Issue[];
  /** Baseline comparison info (if baseline was provided) */
  baseline?: BaselineInfo;
}

/**
 * Checks if baseline update is requested via environment variable
 */
function shouldUpdateFromEnv(): boolean {
  return process.env.BARRIERETEST_UPDATE_BASELINE === "true";
}

/**
 * Process audit issues against a baseline
 */
export async function processAuditWithBaseline(
  issues: Issue[],
  url: string,
  options: BaselineProcessOptions,
  cacheDir: string = CACHE_DIR
): Promise<BaselineIntegrationResult> {
  const { baseline: baselinePath, updateBaseline } = options;
  const shouldUpdate = updateBaseline || shouldUpdateFromEnv();

  // Always cache the last run for baseline:accept
  if (baselinePath) {
    await saveLastRun(url, issues, cacheDir);
  }

  // No baseline path provided - return issues as-is
  if (!baselinePath) {
    return { allIssues: issues };
  }

  // Try to read existing baseline
  const existingBaseline = await readBaseline(baselinePath);

  // Handle update/create baseline
  if (shouldUpdate) {
    if (existingBaseline) {
      // Update existing baseline with new issues
      await updateBaselineFile(baselinePath, issues);
    } else {
      // Create new baseline
      await writeBaseline(baselinePath, url, issues);
    }

    // After update, all issues are known
    const updatedBaseline = await readBaseline(baselinePath);
    if (updatedBaseline) {
      const diff = diffAgainstBaseline(issues, updatedBaseline);
      return {
        allIssues: issues,
        baseline: {
          path: baselinePath,
          newIssues: diff.new,
          knownIssues: diff.known,
          fixedIssues: diff.fixed,
        },
      };
    }
  }

  // No existing baseline and not updating - return issues without baseline info
  if (!existingBaseline) {
    return { allIssues: issues };
  }

  // Diff against existing baseline
  const diff = diffAgainstBaseline(issues, existingBaseline);

  return {
    allIssues: issues,
    baseline: {
      path: baselinePath,
      newIssues: diff.new,
      knownIssues: diff.known,
      fixedIssues: diff.fixed,
    },
  };
}
