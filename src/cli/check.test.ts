import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserCheckConfig } from "../semantic/types.js";
import { runCheck } from "./check.js";
import { type BarrieretestConfig, PROJECT_CONFIG_FILENAME } from "./config.js";
import type { ParsedArgs } from "./index.js";

const TEST_DIR = "/tmp/barrieretest-check-test";
const GLOBAL_PATH = join(TEST_DIR, "global.json");
const PROJECT_PATH = join(TEST_DIR, PROJECT_CONFIG_FILENAME);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

function args(overrides: Partial<ParsedArgs>): ParsedArgs {
  return { command: "check", ...overrides };
}

function readJson(path: string): BarrieretestConfig {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// check add (non-interactive, flag-driven)
// ---------------------------------------------------------------------------

describe("check add (flag-driven)", () => {
  const baseFlags = {
    checkSubcommand: "add" as const,
    checkId: "button-verbs",
    checkTitle: "Button Verbs",
    checkDescription: "Buttons use clear action verbs",
    checkPrompt: "Flag buttons whose label is not a clear action verb.",
  };

  it("writes a new check to global config", async () => {
    const result = await runCheck(args({ ...baseFlags, checkScope: "global" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(true);
    const cfg = readJson(GLOBAL_PATH);
    expect(cfg.semantic?.customChecks?.[0].id).toBe("button-verbs");
  });

  it("writes a new check to project config (creates file if missing)", async () => {
    const result = await runCheck(args({ ...baseFlags, checkScope: "project" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(true);
    expect(existsSync(PROJECT_PATH)).toBe(true);
    const cfg = readJson(PROJECT_PATH);
    expect(cfg.semantic?.customChecks?.[0].id).toBe("button-verbs");
  });

  it("writes to the repo root when cwd is nested inside a git repo", async () => {
    const repoRoot = join(TEST_DIR, "repo");
    const nested = join(repoRoot, "packages", "web");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repoRoot, ".git"), { recursive: true });

    const result = await runCheck(args({ ...baseFlags, checkScope: "project" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: nested,
    });
    expect(result.success).toBe(true);
    const atRoot = join(repoRoot, PROJECT_CONFIG_FILENAME);
    expect(existsSync(atRoot)).toBe(true);
    expect(existsSync(join(nested, PROJECT_CONFIG_FILENAME))).toBe(false);
    const cfg = readJson(atRoot);
    expect(cfg.semantic?.customChecks?.[0].id).toBe("button-verbs");
  });

  it("rejects a duplicate id in the same scope", async () => {
    const existing: UserCheckConfig = {
      id: "button-verbs",
      title: "X",
      description: "X",
      prompt: "Flag stuff properly and exhaustively.",
    };
    writeFileSync(GLOBAL_PATH, JSON.stringify({ semantic: { customChecks: [existing] } }));
    const result = await runCheck(args({ ...baseFlags, checkScope: "global" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already exists/);
  });

  it("rejects an id that collides with a built-in", async () => {
    const result = await runCheck(
      args({
        ...baseFlags,
        checkId: "aria-mismatch",
        checkScope: "global",
      }),
      { env: {}, configPath: GLOBAL_PATH, cwd: TEST_DIR }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/built-in/);
  });

  it("rejects an invalid id shape", async () => {
    const result = await runCheck(args({ ...baseFlags, checkId: "Bad Id", checkScope: "global" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid/);
  });
});

// ---------------------------------------------------------------------------
// check list
// ---------------------------------------------------------------------------

describe("check list", () => {
  it("shows only built-ins when no user checks exist", async () => {
    const result = await runCheck(args({ checkSubcommand: "list" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain("[built-in] aria-mismatch");
    expect(result.message).toContain("No user checks defined");
  });

  it("annotates checks by source and flags overrides", async () => {
    const globalCheck: UserCheckConfig = {
      id: "shared-id",
      title: "Shared",
      description: "d",
      prompt: "Flag something that would not normally be caught.",
    };
    const projectCheck: UserCheckConfig = {
      id: "shared-id",
      title: "Shared project variant",
      description: "d",
      prompt: "Flag the project-specific variant of the shared check.",
    };
    writeFileSync(GLOBAL_PATH, JSON.stringify({ semantic: { customChecks: [globalCheck] } }));
    writeFileSync(PROJECT_PATH, JSON.stringify({ semantic: { customChecks: [projectCheck] } }));
    const result = await runCheck(args({ checkSubcommand: "list" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain("[global]");
    expect(result.message).toContain("[project]");
    expect(result.message).toContain("overridden by project");
  });
});

// ---------------------------------------------------------------------------
// check remove
// ---------------------------------------------------------------------------

describe("check remove", () => {
  const sample: UserCheckConfig = {
    id: "button-verbs",
    title: "X",
    description: "X",
    prompt: "Flag buttons whose label is not a clear action verb.",
  };

  it("removes from global when the id is only in global", async () => {
    writeFileSync(GLOBAL_PATH, JSON.stringify({ semantic: { customChecks: [sample] } }));
    const result = await runCheck(args({ checkSubcommand: "remove", checkId: "button-verbs" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(true);
    const cfg = readJson(GLOBAL_PATH);
    expect(cfg.semantic?.customChecks).toBeUndefined();
  });

  it("removes from project when the id is only in project", async () => {
    writeFileSync(PROJECT_PATH, JSON.stringify({ semantic: { customChecks: [sample] } }));
    const result = await runCheck(args({ checkSubcommand: "remove", checkId: "button-verbs" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(true);
    const cfg = readJson(PROJECT_PATH);
    expect(cfg.semantic?.customChecks).toBeUndefined();
  });

  it("uses --scope to disambiguate when the id is in both", async () => {
    writeFileSync(GLOBAL_PATH, JSON.stringify({ semantic: { customChecks: [sample] } }));
    writeFileSync(PROJECT_PATH, JSON.stringify({ semantic: { customChecks: [sample] } }));
    const result = await runCheck(
      args({
        checkSubcommand: "remove",
        checkId: "button-verbs",
        checkScope: "project",
      }),
      { env: {}, configPath: GLOBAL_PATH, cwd: TEST_DIR }
    );
    expect(result.success).toBe(true);
    // Global still has it; project should not.
    expect(readJson(GLOBAL_PATH).semantic?.customChecks?.[0].id).toBe("button-verbs");
    expect(readJson(PROJECT_PATH).semantic?.customChecks).toBeUndefined();
  });

  it("errors when the id does not exist in either scope", async () => {
    const result = await runCheck(args({ checkSubcommand: "remove", checkId: "nope" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No user check/);
  });
});

// ---------------------------------------------------------------------------
// check test (argument validation only — the audit runs the real semantic
// pipeline, which needs network + provider credentials)
// ---------------------------------------------------------------------------

describe("check test (validation)", () => {
  it("errors when id or url is missing", async () => {
    const r1 = await runCheck(args({ checkSubcommand: "test" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(r1.success).toBe(false);

    const r2 = await runCheck(args({ checkSubcommand: "test", checkId: "aria-mismatch" }), {
      env: {},
      configPath: GLOBAL_PATH,
      cwd: TEST_DIR,
    });
    expect(r2.success).toBe(false);
  });

  it("errors on an unknown check id", async () => {
    const result = await runCheck(
      args({
        checkSubcommand: "test",
        checkId: "does-not-exist",
        checkUrl: "https://example.com",
      }),
      {
        env: { NEBIUS_API_KEY: "nk" },
        configPath: GLOBAL_PATH,
        cwd: TEST_DIR,
      }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown check id/);
  });
});
