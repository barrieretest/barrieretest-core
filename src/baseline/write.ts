import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Issue } from "../types";
import { generateIssueHash } from "./hash";
import type { BaselineFile, BaselineIssue } from "./types";
import { BASELINE_VERSION, isValidBaselineFile } from "./types";

/**
 * Converts an Issue to a BaselineIssue for storage
 */
function toBaselineIssue(issue: Issue): BaselineIssue {
  return {
    rule: issue.id,
    selector: issue.selector,
    hash: generateIssueHash(issue),
  };
}

/**
 * Writes a new baseline file with the given issues
 */
export async function writeBaseline(path: string, url: string, issues: Issue[]): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const now = new Date().toISOString();
  const baseline: BaselineFile = {
    version: BASELINE_VERSION,
    created: now,
    updated: now,
    url,
    issues: issues.map(toBaselineIssue),
  };

  writeFileSync(path, JSON.stringify(baseline, null, 2));
}

/**
 * Reads a baseline file from disk
 * Returns null if file doesn't exist
 * Throws if file is invalid
 */
export async function readBaseline(path: string): Promise<BaselineFile | null> {
  if (!existsSync(path)) {
    return null;
  }

  const content = JSON.parse(readFileSync(path, "utf-8"));

  if (!isValidBaselineFile(content)) {
    throw new Error("Invalid baseline file");
  }

  return content;
}

/**
 * Updates an existing baseline by merging in new issues
 * Throws if baseline file doesn't exist
 */
export async function updateBaseline(path: string, newIssues: Issue[]): Promise<void> {
  const existing = await readBaseline(path);

  if (!existing) {
    throw new Error("Baseline file not found");
  }

  // Create a set of existing hashes for quick lookup
  const existingHashes = new Set(existing.issues.map((i) => i.hash));

  // Add only new issues (by hash)
  const newBaselineIssues = newIssues
    .map(toBaselineIssue)
    .filter((i) => !existingHashes.has(i.hash));

  const updated: BaselineFile = {
    ...existing,
    updated: new Date().toISOString(),
    issues: [...existing.issues, ...newBaselineIssues],
  };

  writeFileSync(path, JSON.stringify(updated, null, 2));
}
