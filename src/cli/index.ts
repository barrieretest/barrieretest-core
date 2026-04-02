import { audit } from "../audit";
import { CACHE_DIR, getLastRun } from "../baseline/cache";
import { readBaseline, updateBaseline, writeBaseline } from "../baseline/write";
import { formatActionable } from "../report";
import type { AuditOptions, DetailLevel, IssueSeverity } from "../types";

export const CLI_COMMANDS = ["audit", "baseline", "baseline:accept", "baseline:update"] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number] | "help";

export interface ParsedArgs {
  command: CliCommand;
  url?: string;
  output?: string;
  update?: string;
  headless?: boolean;
  file?: string;
  dir?: string;
  baseUrl?: string;
  detail?: DetailLevel;
  minSeverity?: IssueSeverity;
  ignore?: string[];
  baseline?: string;
  json?: boolean;
}

export interface CliResult {
  success: boolean;
  message?: string;
  error?: string;
  exitCode?: number;
}

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    return { command: "help" };
  }

  const first = args[0];

  // Implicit audit: first arg is a URL
  if (first.startsWith("http://") || first.startsWith("https://")) {
    const result: ParsedArgs = { command: "audit", url: first, headless: true };
    parseAuditFlags(args, 1, result);
    return result;
  }

  if (first === "help") {
    return { command: "help" };
  }

  if (!CLI_COMMANDS.includes(first as (typeof CLI_COMMANDS)[number])) {
    return { command: "help" };
  }

  const command = first as CliCommand;
  const result: ParsedArgs = { command, headless: true };

  if (command === "audit") {
    result.url = args[1];
    parseAuditFlags(args, 2, result);
  } else if (command === "baseline") {
    result.url = args[1];
    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      const nextArg = args[i + 1];
      if (arg === "-o" || arg === "--output") {
        result.output = nextArg;
        i++;
      } else if (arg === "--update") {
        result.update = nextArg;
        i++;
      } else if (arg === "--headless") {
        result.headless = nextArg !== "false";
        i++;
      }
    }
  } else if (command === "baseline:accept") {
    result.file = args[1];
  } else if (command === "baseline:update") {
    result.dir = args[1];
    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      const nextArg = args[i + 1];
      if (arg === "--base-url") {
        result.baseUrl = nextArg;
        i++;
      } else if (arg === "--headless") {
        result.headless = nextArg !== "false";
        i++;
      }
    }
  }

  return result;
}

function parseAuditFlags(args: string[], startIndex: number, result: ParsedArgs): void {
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === "-d" || arg === "--detail") {
      result.detail = nextArg as DetailLevel;
      i++;
    } else if (arg === "-s" || arg === "--min-severity") {
      result.minSeverity = nextArg as IssueSeverity;
      i++;
    } else if (arg === "--ignore") {
      result.ignore = nextArg.split(",");
      i++;
    } else if (arg === "-b" || arg === "--baseline") {
      result.baseline = nextArg;
      i++;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "-o" || arg === "--output") {
      result.output = nextArg;
      i++;
    } else if (arg === "--headless") {
      result.headless = nextArg !== "false";
      i++;
    }
  }
}

/**
 * Run CLI command
 */
export async function runCli(args: ParsedArgs, cacheDir: string = CACHE_DIR): Promise<CliResult> {
  switch (args.command) {
    case "audit":
      return runAudit(args);

    case "baseline":
      return runBaseline(args);

    case "baseline:accept":
      return runBaselineAccept(args.file!, cacheDir);

    case "baseline:update":
      return runBaselineUpdate(args);

    case "help":
    default:
      return {
        success: true,
        message: `barrieretest - Accessibility testing CLI

Usage:
  barrieretest <url>                    Run accessibility audit
  barrieretest audit <url> [options]    Run accessibility audit
  barrieretest baseline <url> [options] Create or update baseline
  barrieretest baseline:accept <file>   Accept last run into baseline
  barrieretest baseline:update <dir>    Re-audit and update all baselines

Audit options:
  -d, --detail <level>       minimal | actionable | fix-ready (default: actionable)
  -s, --min-severity <level> critical | serious | moderate | minor
  --ignore <rules>           Comma-separated rule IDs to ignore
  -b, --baseline <file>      Compare against baseline
  --json                     Output JSON
  -o, --output <file>        Write JSON results to file
  --headless <bool>          Run headless (default: true)

Baseline options:
  -o, --output <file>        Output file (default: ./baseline.json)
  --update <file>            Update existing baseline
  --base-url <url>           Override base URL for baseline:update`,
      };
  }
}

async function runAudit(args: ParsedArgs): Promise<CliResult> {
  if (!args.url) return { success: false, error: "URL required", exitCode: 1 };

  const options: AuditOptions = {
    headless: args.headless ?? true,
    detail: args.detail ?? "actionable",
    minSeverity: args.minSeverity,
    ignore: args.ignore,
    baseline: args.baseline,
  };

  // Print progress to stderr so stdout stays clean for results
  if (!args.json) {
    options.onProgress = async ({ percent, message }) => {
      process.stderr.write(`\r  ${message} (${percent}%)`);
    };
  }

  const result = await audit(args.url, options);

  if (args.json || args.output) {
    const json = JSON.stringify(result, null, 2);
    if (args.output) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(args.output), { recursive: true });
      writeFileSync(args.output, json);
    }
    if (args.json) return { success: true, message: json };
  }

  // Pretty-print results to stdout
  const lines: string[] = [];
  lines.push("");
  lines.push(`  barrieretest ${result.url}`);
  lines.push(`  Score: ${result.score}/100 (${result.severityLevel})`);
  lines.push("");

  if (result.issues.length === 0) {
    lines.push("  No accessibility issues found.");
  } else {
    const formatted = formatActionable(result.issues);

    for (const issue of formatted) {
      const icon = issue.impact === "critical" ? "✗" : issue.impact === "serious" ? "!" : "-";
      lines.push(
        `  ${icon} ${issue.impact}: ${issue.id}${issue.count > 1 ? ` (×${issue.count})` : ""}`
      );
      if (issue.selector) lines.push(`    Element: ${issue.selector}`);
      if (issue.description) lines.push(`    ${issue.description}`);
    }
    lines.push("");
    lines.push(`  ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} found`);
  }

  // Baseline info
  if (result.baseline) {
    const b = result.baseline;
    lines.push(
      `  Baseline: ${b.newIssues.length} new, ${b.knownIssues.length} known, ${b.fixedIssues.length} fixed`
    );
  }

  lines.push("");

  const hasIssues = result.baseline
    ? result.baseline.newIssues.length > 0
    : result.issues.length > 0;

  return {
    success: !hasIssues,
    message: lines.join("\n"),
    exitCode: hasIssues ? 1 : 0,
  };
}

async function runBaseline(args: ParsedArgs): Promise<CliResult> {
  if (!args.url) return { success: false, error: "URL required", exitCode: 1 };

  const result = await audit(args.url, { headless: args.headless ?? true });

  if (args.update) {
    await updateBaseline(args.update, result.issues);
    return {
      success: true,
      message: `Updated baseline at ${args.update} (${result.issues.length} issues)`,
    };
  }

  const output = args.output ?? "./baseline.json";
  await writeBaseline(output, result.url, result.issues);
  return {
    success: true,
    message: `Created baseline at ${output} (${result.issues.length} issues)`,
  };
}

async function runBaselineUpdate(args: ParsedArgs): Promise<CliResult> {
  if (!args.dir) return { success: false, error: "Directory required", exitCode: 1 };

  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const files = readdirSync(args.dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    return { success: false, error: `No baseline files found in ${args.dir}`, exitCode: 1 };
  }

  let updated = 0;
  for (const file of files) {
    const path = join(args.dir, file);
    const baseline = await readBaseline(path);
    if (!baseline) continue;

    const url = args.baseUrl
      ? baseline.url.replace(/^https?:\/\/[^/]+/, args.baseUrl)
      : baseline.url;

    const result = await audit(url, { headless: true });
    await writeBaseline(path, url, result.issues);
    updated++;
  }

  return {
    success: true,
    message: `Updated ${updated} baseline${updated === 1 ? "" : "s"} in ${args.dir}`,
  };
}

/**
 * Accept issues from last run into baseline
 */
async function runBaselineAccept(file: string, cacheDir: string): Promise<CliResult> {
  const lastRun = await getLastRun(cacheDir);

  if (!lastRun) {
    return {
      success: false,
      error: "No recent audit run found. Run an audit first.",
    };
  }

  // Check if baseline exists
  const existing = await readBaseline(file);

  if (existing) {
    // Merge into existing baseline
    await updateBaseline(file, lastRun.issues);
    return {
      success: true,
      message: `Added ${lastRun.issues.length} issues to ${file}`,
    };
  } else {
    // Create new baseline
    await writeBaseline(file, lastRun.url, lastRun.issues);
    return {
      success: true,
      message: `Created baseline with ${lastRun.issues.length} issues at ${file}`,
    };
  }
}
