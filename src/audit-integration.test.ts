/**
 * Integration tests for `audit()` orchestration.
 *
 * These mock the engine and semantic-runner modules so we can exercise
 * audit()'s merge / filter / baseline / warn-and-continue logic without
 * launching a real browser or hitting an AI provider.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Issue } from "./types.js";

// ----- shared mock state -----

interface EngineCall {
  url: string;
  hadPage: boolean;
}

interface SemanticCall {
  url: string;
  pagePrepared: boolean | undefined;
}

let engineCalls: EngineCall[];
let semanticCalls: SemanticCall[];
let nextEngineIssues: Issue[];
let nextSemanticIssues: Issue[];
let nextSemanticThrows: Error | null;
let consoleWarnSpy: { calls: unknown[][]; restore: () => void };

const ENGINE_URL = "https://example.test/page";

mock.module("./engines/axe.js", () => ({
  runAxeCore: async (
    url: string,
    options: { page?: unknown }
  ): Promise<{
    issues: Issue[];
    documentTitle: string;
    pageUrl: string;
    screenshot?: Uint8Array;
  }> => {
    engineCalls.push({ url, hadPage: !!options.page });
    return {
      issues: [...nextEngineIssues],
      documentTitle: "Stub Doc",
      pageUrl: url,
      screenshot: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
  },
  transformAxeViolation: () => [],
}));

mock.module("./semantic/runner.js", () => ({
  runSemanticAudit: async (
    runContext: { url: string; pagePrepared?: boolean }
  ) => {
    semanticCalls.push({
      url: runContext.url,
      pagePrepared: runContext.pagePrepared,
    });
    if (nextSemanticThrows) throw nextSemanticThrows;
    return {
      url: runContext.url,
      issues: [...nextSemanticIssues],
      meta: {
        checksRun: ["aria-mismatch"],
        provider: "stub",
        model: "stub-model",
      },
      screenshot: undefined,
      timestamp: new Date().toISOString(),
    };
  },
  // Re-export the helper used by other call sites that import it from runner.
  validateFindingsAgainstChecks: () => ({ valid: [], dropped: [] }),
}));

// Stub puppeteer-launch so audit() doesn't try to launch a real browser
// when handed a URL with `semantic` set.
mock.module("./puppeteer-launch.js", () => ({
  launchPuppeteerSession: async () => ({
    browser: { close: async () => undefined },
    page: {
      url: () => "about:blank",
      title: async () => "Stub",
      goto: async () => undefined,
      evaluate: async () => ({}),
      screenshot: async () => new Uint8Array(),
      close: async () => undefined,
    },
  }),
  closeSession: async () => undefined,
  navigateTo: async () => undefined,
}));

const { audit } = await import("./audit.js");

// ----- helpers -----

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "engine-rule",
    impact: "moderate",
    description: "stub",
    help: "stub help",
    selector: ".x",
    nodes: [{ html: "<div></div>" }],
    ...overrides,
  };
}

function makeSemanticIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "semantic:aria-mismatch",
    impact: "serious",
    description: "label mismatch",
    help: "fix it",
    selector: "button",
    nodes: [{ html: "<button></button>" }],
    semantic: { checkType: "aria-mismatch", confidence: 0.8 },
    ...overrides,
  };
}

beforeEach(() => {
  engineCalls = [];
  semanticCalls = [];
  nextEngineIssues = [];
  nextSemanticIssues = [];
  nextSemanticThrows = null;

  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  consoleWarnSpy = {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
});

afterEach(() => {
  consoleWarnSpy.restore();
});

// ----- the actual integration tests -----

describe("audit() merge ordering", () => {
  it("returns engine + semantic issues merged in result.issues", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-a" }), makeIssue({ id: "engine-b" })];
    nextSemanticIssues = [makeSemanticIssue()];

    const result = await audit(ENGINE_URL, {
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(result.issues.map((i) => i.id)).toEqual([
      "engine-a",
      "engine-b",
      "semantic:aria-mismatch",
    ]);
    expect(result.semanticMeta?.provider).toBe("stub");
  });

  it("passes pagePrepared:true to the semantic runner", async () => {
    nextEngineIssues = [];
    nextSemanticIssues = [];

    await audit(ENGINE_URL, {
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(semanticCalls).toHaveLength(1);
    expect(semanticCalls[0].pagePrepared).toBe(true);
  });
});

describe("audit() minSeverity + ignore on merged set", () => {
  it("minSeverity drops low-severity semantic issues", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-critical", impact: "critical" })];
    nextSemanticIssues = [
      makeSemanticIssue({ id: "semantic:aria-mismatch", impact: "minor" }),
      makeSemanticIssue({ id: "semantic:page-title", impact: "serious" }),
    ];

    const result = await audit(ENGINE_URL, {
      minSeverity: "serious",
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain("engine-critical");
    expect(ids).toContain("semantic:page-title");
    expect(ids).not.toContain("semantic:aria-mismatch");
  });

  it("ignore drops semantic issues by id", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-x" })];
    nextSemanticIssues = [
      makeSemanticIssue({ id: "semantic:aria-mismatch" }),
      makeSemanticIssue({ id: "semantic:page-title" }),
    ];

    const result = await audit(ENGINE_URL, {
      ignore: ["semantic:aria-mismatch"],
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain("engine-x");
    expect(ids).toContain("semantic:page-title");
    expect(ids).not.toContain("semantic:aria-mismatch");
  });

  it("minSeverity also drops low-severity engine issues before semantic runs", async () => {
    nextEngineIssues = [
      makeIssue({ id: "engine-minor", impact: "minor" }),
      makeIssue({ id: "engine-critical", impact: "critical" }),
    ];
    nextSemanticIssues = [];

    const result = await audit(ENGINE_URL, {
      minSeverity: "serious",
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain("engine-critical");
    expect(ids).not.toContain("engine-minor");
  });
});

describe("audit() warn-and-continue on semantic failure", () => {
  it("returns engine results, no semanticMeta, and logs a warning when semantic throws", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-only" })];
    nextSemanticThrows = new Error("nebius down");

    const result = await audit(ENGINE_URL, {
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(result.issues.map((i) => i.id)).toEqual(["engine-only"]);
    expect(result.semanticMeta).toBeUndefined();
    expect(
      consoleWarnSpy.calls.some((args) =>
        String(args[0] ?? "").includes("Semantic audit failed")
      )
    ).toBe(true);
  });
});
