import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Issue } from "../types.js";
import { generateIssueHash } from "./hash.js";
import type { BaselineFile, BaselineIssue } from "./types.js";
import { BASELINE_VERSION, isValidBaselineFile } from "./types.js";

function toBaselineIssue(issue: Issue): BaselineIssue {
  return {
    rule: issue.id,
    selector: issue.selector,
    hash: generateIssueHash(issue),
  };
}

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

export async function readBaseline(path: string): Promise<BaselineFile | null> {
  if (!existsSync(path)) {
    return null;
  }

  const content = JSON.parse(readFileSync(path, "utf-8"));

  if (!isValidBaselineFile(content)) {
    if (content.score !== undefined && content.issues && content.documentTitle) {
      throw new Error(
        `"${path}" is an audit result, not a baseline file. ` +
          `Create a baseline with: barrieretest baseline <url> -o <file>`
      );
    }

    throw new Error(`Invalid baseline file: "${path}"`);
  }

  return content;
}

export async function updateBaseline(path: string, newIssues: Issue[]): Promise<void> {
  const existing = await readBaseline(path);

  if (!existing) {
    throw new Error("Baseline file not found");
  }

  const existingHashes = new Set(existing.issues.map((i) => i.hash));
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
