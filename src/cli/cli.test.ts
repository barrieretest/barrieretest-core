import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveLastRun } from "../baseline/cache.js";
import { writeBaseline } from "../baseline/write.js";
import type { Issue } from "../types.js";
import { CLI_COMMANDS, parseArgs, runCli } from "./index.js";

const TEST_DIR = "/tmp/barrieretest-cli-test";
const TEST_BASELINE = join(TEST_DIR, "baseline.json");
const TEST_CACHE = join(TEST_DIR, "cache");

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
  impact: "critical",
  description: "Contrast issue",
  help: "Fix the contrast",
  selector: "button.submit",
  nodes: [{ html: '<button class="submit">Submit</button>' }],
  ...overrides,
});

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_CACHE, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("parseArgs", () => {
  it("parses baseline command with url", () => {
    const args = parseArgs(["baseline", "https://example.com"]);

    expect(args.command).toBe("baseline");
    expect(args.url).toBe("https://example.com");
  });

  it("parses baseline command with output option", () => {
    const args = parseArgs(["baseline", "https://example.com", "-o", "output.json"]);

    expect(args.output).toBe("output.json");
  });

  it("parses baseline command with --update option", () => {
    const args = parseArgs(["baseline", "https://example.com", "--update", "existing.json"]);

    expect(args.update).toBe("existing.json");
  });

  it("parses baseline command with --headless option", () => {
    const args = parseArgs(["baseline", "https://example.com", "--headless", "false"]);

    expect(args.headless).toBe(false);
  });

  it("defaults headless to true", () => {
    const args = parseArgs(["baseline", "https://example.com"]);

    expect(args.headless).toBe(true);
  });

  it("parses baseline:accept command", () => {
    const args = parseArgs(["baseline:accept", "path/to/baseline.json"]);

    expect(args.command).toBe("baseline:accept");
    expect(args.file).toBe("path/to/baseline.json");
  });

  it("parses baseline:update command", () => {
    const args = parseArgs(["baseline:update", "./baselines"]);

    expect(args.command).toBe("baseline:update");
    expect(args.dir).toBe("./baselines");
  });

  it("parses baseline:update with --base-url", () => {
    const args = parseArgs(["baseline:update", "./baselines", "--base-url", "https://example.com"]);

    expect(args.baseUrl).toBe("https://example.com");
  });

  it("returns help for unknown command", () => {
    const args = parseArgs(["unknown"]);

    expect(args.command).toBe("help");
  });

  it("returns help for no arguments", () => {
    const args = parseArgs([]);

    expect(args.command).toBe("help");
  });

  // New tests for implicit audit and audit command
  it("treats URL as first arg as implicit audit command", () => {
    const args = parseArgs(["https://example.com"]);

    expect(args.command).toBe("audit");
    expect(args.url).toBe("https://example.com");
  });

  it("treats http:// URL as implicit audit command", () => {
    const args = parseArgs(["http://example.com"]);

    expect(args.command).toBe("audit");
    expect(args.url).toBe("http://example.com");
  });

  it("parses explicit audit command", () => {
    const args = parseArgs(["audit", "https://example.com"]);

    expect(args.command).toBe("audit");
    expect(args.url).toBe("https://example.com");
  });

  it("parses explicit audit command with --json flag", () => {
    const args = parseArgs(["audit", "https://example.com", "--json"]);

    expect(args.command).toBe("audit");
    expect(args.json).toBe(true);
  });
  it("parses engine with -e flag", () => {
    const args = parseArgs(["audit", "https://example.com", "-e", "pa11y"]);

    expect(args.engine).toBe("pa11y");
  });

  it("parses engine with --engine flag", () => {
    const args = parseArgs(["https://example.com", "--engine", "axe"]);

    expect(args.engine).toBe("axe");
  });


  it("parses detail level with -d flag", () => {
    const args = parseArgs(["audit", "https://example.com", "-d", "minimal"]);

    expect(args.detail).toBe("minimal");
  });

  it("parses detail level with --detail flag", () => {
    const args = parseArgs(["audit", "https://example.com", "--detail", "fix-ready"]);

    expect(args.detail).toBe("fix-ready");
  });

  it("parses min-severity with -s flag", () => {
    const args = parseArgs(["https://example.com", "-s", "serious"]);

    expect(args.minSeverity).toBe("serious");
  });

  it("parses min-severity with --min-severity flag", () => {
    const args = parseArgs(["https://example.com", "--min-severity", "critical"]);

    expect(args.minSeverity).toBe("critical");
  });

  it("parses ignore with comma-separated rule IDs", () => {
    const args = parseArgs(["https://example.com", "--ignore", "rule1,rule2"]);

    expect(args.ignore).toEqual(["rule1", "rule2"]);
  });

  it("parses single ignore rule", () => {
    const args = parseArgs(["https://example.com", "--ignore", "rule1"]);

    expect(args.ignore).toEqual(["rule1"]);
  });

  it("parses baseline file with -b flag", () => {
    const args = parseArgs(["https://example.com", "-b", "baseline.json"]);

    expect(args.baseline).toBe("baseline.json");
  });

  it("parses output file with -o flag for audit", () => {
    const args = parseArgs(["https://example.com", "-o", "results.json"]);

    expect(args.output).toBe("results.json");
  });

  it("returns help for 'help' argument", () => {
    const args = parseArgs(["help"]);

    expect(args.command).toBe("help");
  });

  it("parses implicit audit with multiple flags", () => {
    const args = parseArgs(["https://example.com", "-d", "actionable", "-s", "serious", "--json"]);

    expect(args.command).toBe("audit");
    expect(args.url).toBe("https://example.com");
    expect(args.detail).toBe("actionable");
    expect(args.minSeverity).toBe("serious");
    expect(args.json).toBe(true);
  });
});

describe("CLI_COMMANDS", () => {
  it("exports audit command", () => {
    expect(CLI_COMMANDS).toContain("audit");
  });

  it("exports baseline command", () => {
    expect(CLI_COMMANDS).toContain("baseline");
  });

  it("exports baseline:accept command", () => {
    expect(CLI_COMMANDS).toContain("baseline:accept");
  });

  it("exports baseline:update command", () => {
    expect(CLI_COMMANDS).toContain("baseline:update");
  });
});

describe("runCli help", () => {
  it("returns help text", async () => {
    const result = await runCli({ command: "help" });

    expect(result.success).toBe(true);
    expect(result.message).toContain("barrieretest");
    expect(result.message).toContain("audit");
    expect(result.message).toContain("baseline");
  });

  it("returns help for no-args", async () => {
    const parsed = parseArgs([]);
    const result = await runCli(parsed);

    expect(result.success).toBe(true);
    expect(result.message).toContain("barrieretest");
  });
});

describe("runCli baseline:accept", () => {
  it("accepts issues from last run into baseline", async () => {
    const issue = createIssue();

    // Save last run
    await saveLastRun("https://example.com", [issue], TEST_CACHE);

    // Accept into new baseline
    const result = await runCli(
      {
        command: "baseline:accept",
        file: TEST_BASELINE,
      },
      TEST_CACHE
    );

    expect(result.success).toBe(true);
    expect(existsSync(TEST_BASELINE)).toBe(true);

    // Verify baseline content
    const baseline = await Bun.file(TEST_BASELINE).json();
    expect(baseline.issues).toHaveLength(1);
  });

  it("merges into existing baseline", async () => {
    const existingIssue = createIssue({ selector: "#existing" });
    const newIssue = createIssue({ selector: "#new" });

    // Create existing baseline
    await writeBaseline(TEST_BASELINE, "https://example.com", [existingIssue]);

    // Save last run with new issue
    await saveLastRun("https://example.com", [newIssue], TEST_CACHE);

    // Accept
    await runCli(
      {
        command: "baseline:accept",
        file: TEST_BASELINE,
      },
      TEST_CACHE
    );

    // Verify merged
    const baseline = await Bun.file(TEST_BASELINE).json();
    expect(baseline.issues).toHaveLength(2);
  });

  it("fails when no last run exists", async () => {
    const result = await runCli(
      {
        command: "baseline:accept",
        file: TEST_BASELINE,
      },
      "/non/existent/cache"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No recent audit run found");
  });
});
