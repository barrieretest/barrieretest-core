/**
 * Screenshot output utilities for CI and file-based workflows
 *
 * Saves element screenshots to disk and tracks file paths.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateIssueHash } from "../baseline/hash";
import type { Issue } from "../types";
import type { LocalizedIssue } from "./index";

export interface ScreenshotOutputOptions {
  /** Directory to save screenshots */
  outputDir: string;
  /** Prefix for screenshot filenames */
  filenamePrefix?: string;
  /** Whether to create the directory if it doesn't exist */
  createDir?: boolean;
}

export interface ScreenshotOutputResult {
  /** Issue ID */
  issueId: string;
  /** Issue hash (used for filename) */
  hash: string;
  /** Full path to the saved screenshot */
  filePath: string;
  /** Whether the screenshot was saved successfully */
  success: boolean;
  /** Error message if save failed */
  error?: string;
}

/**
 * Saves a single issue's screenshot to disk
 *
 * @param issue - Localized issue with screenshot
 * @param options - Output options
 * @returns Result with file path
 */
export async function saveIssueScreenshot(
  issue: LocalizedIssue,
  options: ScreenshotOutputOptions
): Promise<ScreenshotOutputResult | null> {
  const { outputDir, filenamePrefix = "issue", createDir = true } = options;

  // Check if issue has a screenshot
  if (!issue.localization?.screenshot) {
    return null;
  }

  const hash = generateIssueHash(issue);
  const filename = `${filenamePrefix}-${hash}.png`;
  const filePath = join(outputDir, filename);

  try {
    // Create directory if needed
    if (createDir) {
      await mkdir(outputDir, { recursive: true });
    }

    // Write screenshot to disk
    await writeFile(filePath, issue.localization.screenshot);

    return {
      issueId: issue.id,
      hash,
      filePath,
      success: true,
    };
  } catch (error) {
    return {
      issueId: issue.id,
      hash,
      filePath,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Saves all issue screenshots to disk
 *
 * @param issues - Array of localized issues
 * @param options - Output options
 * @returns Array of results for each issue with a screenshot
 */
export async function saveAllScreenshots(
  issues: LocalizedIssue[],
  options: ScreenshotOutputOptions
): Promise<ScreenshotOutputResult[]> {
  const results: ScreenshotOutputResult[] = [];

  // Create directory once if needed
  if (options.createDir) {
    await mkdir(options.outputDir, { recursive: true });
  }

  for (const issue of issues) {
    const result = await saveIssueScreenshot(issue, {
      ...options,
      createDir: false, // Already created
    });

    if (result) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Issue with screenshot path (for JSON output)
 */
export interface IssueWithScreenshotPath extends Issue {
  /** Path to screenshot file (if saved) */
  screenshotPath?: string;
}

/**
 * Converts localized issues to output format with file paths
 *
 * Replaces screenshot buffers with file paths for JSON serialization.
 *
 * @param issues - Localized issues
 * @param screenshotResults - Results from saveAllScreenshots
 * @returns Issues with screenshot paths instead of buffers
 */
export function issuesWithScreenshotPaths(
  issues: LocalizedIssue[],
  screenshotResults: ScreenshotOutputResult[]
): IssueWithScreenshotPath[] {
  // Create a map of issue hash to file path
  const pathMap = new Map<string, string>();
  for (const result of screenshotResults) {
    if (result.success) {
      pathMap.set(result.hash, result.filePath);
    }
  }

  return issues.map((issue) => {
    const hash = generateIssueHash(issue);
    const screenshotPath = pathMap.get(hash);

    // Create a copy without the screenshot buffer
    const { localization, ...rest } = issue;

    const output: IssueWithScreenshotPath = {
      ...rest,
      screenshotPath,
    };

    // Include localization data without the buffer
    if (localization) {
      const { screenshot, ...localizationRest } = localization;
      if (Object.keys(localizationRest).length > 0) {
        (output as LocalizedIssue).localization =
          localizationRest as LocalizedIssue["localization"];
      }
    }

    return output;
  });
}

/**
 * Prepares audit results for JSON output with screenshot paths
 *
 * Use this when you need to serialize results to JSON and want
 * screenshots saved to disk rather than embedded as buffers.
 *
 * @param issues - Localized issues from audit
 * @param outputDir - Directory to save screenshots
 * @returns Object with issues (containing paths) and screenshot save results
 */
export async function prepareOutputWithScreenshots(
  issues: LocalizedIssue[],
  outputDir: string
): Promise<{
  issues: IssueWithScreenshotPath[];
  screenshots: ScreenshotOutputResult[];
}> {
  const screenshots = await saveAllScreenshots(issues, { outputDir });
  const issuesOutput = issuesWithScreenshotPaths(issues, screenshots);

  return {
    issues: issuesOutput,
    screenshots,
  };
}
