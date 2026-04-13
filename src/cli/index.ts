import { audit } from "../audit.js";
import { CACHE_DIR, getLastRun } from "../baseline/cache.js";
import { readBaseline, updateBaseline, writeBaseline } from "../baseline/write.js";
import { formatActionable, formatFixReady, formatMinimal } from "../report.js";
import type { AuditEngine, AuditOptions, DetailLevel, Issue, IssueSeverity } from "../types.js";

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
  engine?: AuditEngine;
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

    if (arg === "-e" || arg === "--engine") {
      result.engine = nextArg as AuditEngine;
      i++;
    } else if (arg === "-d" || arg === "--detail") {
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

function progressLine(message: string, percent: number): string {
  return `  ${message} (${percent}%)`;
}

function writeProgress(message: string, percent: number): void {
  const line = progressLine(message, percent);

  if (process.stderr.isTTY) {
    process.stderr.write(`\r${line}\x1B[K`);
    if (percent === 100) {
      process.stderr.write("\n");
    }
    return;
  }

  process.stderr.write(`${line}\n`);
}

function issueIcon(impact: IssueSeverity): string {
  if (impact === "critical") return "✗";
  if (impact === "serious") return "!";
  return "-";
}

function truncate(text: string, maxLength: number = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function addIssueLines(lines: string[], issues: Issue[], detail: DetailLevel): void {
  switch (detail) {
    case "minimal": {
      for (const issue of formatMinimal(issues)) {
        lines.push(
          `  ${issueIcon(issue.impact)} ${issue.impact}: ${issue.id}${issue.count > 1 ? ` (×${issue.count})` : ""}`
        );
      }
      return;
    }

    case "fix-ready": {
      for (const issue of formatFixReady(issues)) {
        lines.push(
          `  ${issueIcon(issue.impact)} ${issue.impact}: ${issue.id}${issue.count > 1 ? ` (×${issue.count})` : ""}`
        );
        if (issue.selector) lines.push(`    Element: ${issue.selector}`);
        if (issue.description) lines.push(`    ${issue.description}`);
        if (issue.help) lines.push(`    Help: ${issue.help}`);
        if (issue.codeSnippet) lines.push(`    Code: ${truncate(issue.codeSnippet)}`);
        if (issue.failureSummary) {
          for (const line of issue.failureSummary.split("\n")) {
            lines.push(`    ${line}`);
          }
        }
        if (issue.documentationUrl) lines.push(`    Docs: ${issue.documentationUrl}`);
      }
      return;
    }

    case "actionable":
    default: {
      for (const issue of formatActionable(issues)) {
        lines.push(
          `  ${issueIcon(issue.impact)} ${issue.impact}: ${issue.id}${issue.count > 1 ? ` (×${issue.count})` : ""}`
        );
        if (issue.selector) lines.push(`    Element: ${issue.selector}`);
        if (issue.description) lines.push(`    ${issue.description}`);
        if (issue.help) lines.push(`    Help: ${issue.help}`);
      }
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
        message: `barrieretest - Single-page accessibility testing CLI

Usage:
  barrieretest <url>                    Run a single-page accessibility audit
  barrieretest audit <url> [options]    Run a single-page accessibility audit
  barrieretest baseline <url> [options] Create or update a single-page baseline
  barrieretest baseline:accept <file>   Accept the last audit run into a baseline
  barrieretest baseline:update <dir>    Re-audit and update all baselines

Audit options:
  -e, --engine <engine>      axe | pa11y (default: axe)
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

  const detail = args.detail ?? "actionable";
  const options: AuditOptions = {
    engine: args.engine,
    headless: args.headless ?? true,
    detail,
    minSeverity: args.minSeverity,
    ignore: args.ignore,
    baseline: args.baseline,
  };

  if (!args.json) {
    options.onProgress = async ({ percent, message }) => {
      writeProgress(message, percent);
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

  const lines: string[] = [];
  lines.push("");
  lines.push(`  barrieretest ${result.url}`);
  lines.push(`  Score: ${result.score}/100 (${result.severityLevel})`);
  lines.push("");

  if (result.issues.length === 0) {
    lines.push("  No accessibility issues found.");
  } else {
    addIssueLines(lines, result.issues, detail);
    lines.push("");
    lines.push(`  ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} found`);
  }

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

    const result = await audit(url, { headless: args.headless ?? true });
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

  const existing = await readBaseline(file);

  if (existing) {
    await updateBaseline(file, lastRun.issues);
    return {
      success: true,
      message: `Added ${lastRun.issues.length} issues to ${file}`,
    };
  }

  await writeBaseline(file, lastRun.url, lastRun.issues);
  return {
    success: true,
    message: `Created baseline with ${lastRun.issues.length} issues at ${file}`,
  };
}
