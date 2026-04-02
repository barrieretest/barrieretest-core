/**
 * Current baseline file version
 */
export const BASELINE_VERSION = 1 as const;

/**
 * A single issue stored in the baseline
 */
export interface BaselineIssue {
  /** Rule/code identifier (e.g., "WCAG2AA.Principle1.Guideline1_4.1_4_3") */
  rule: string;
  /** CSS selector for the affected element, or null for global issues */
  selector: string | null;
  /** Stable hash identifier for this issue */
  hash: string;
}

/**
 * Baseline file structure for tracking known issues
 */
export interface BaselineFile {
  /** Schema version (always 1) */
  version: typeof BASELINE_VERSION;
  /** ISO date when baseline was first created */
  created: string;
  /** ISO date when baseline was last updated */
  updated: string;
  /** URL this baseline applies to */
  url: string;
  /** Known issues in this baseline */
  issues: BaselineIssue[];
}

/**
 * Validates that an unknown value is a valid BaselineFile
 */
export function isValidBaselineFile(value: unknown): value is BaselineFile {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (obj.version !== BASELINE_VERSION) {
    return false;
  }

  if (typeof obj.url !== "string") {
    return false;
  }

  if (typeof obj.created !== "string") {
    return false;
  }

  if (typeof obj.updated !== "string") {
    return false;
  }

  if (!Array.isArray(obj.issues)) {
    return false;
  }

  return true;
}
