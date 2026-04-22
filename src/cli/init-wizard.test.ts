import { describe, expect, it } from "bun:test";
import { BUILT_IN_CHECK_IDS } from "../semantic/checks/index.js";
import type { BarrieretestConfig } from "./config.js";
import {
  buildConfigFromAnswers,
  DEFAULT_MODELS,
  hasExistingSemanticConfig,
  pickDefaultProvider,
  runInit,
} from "./init-wizard.js";

describe("hasExistingSemanticConfig", () => {
  it("is false for empty config", () => {
    expect(hasExistingSemanticConfig({})).toBe(false);
  });

  it("is false when semantic is an empty object", () => {
    expect(hasExistingSemanticConfig({ semantic: {} })).toBe(false);
  });

  it("is true when any semantic field is set", () => {
    expect(hasExistingSemanticConfig({ semantic: { provider: "nebius" } })).toBe(true);
    expect(hasExistingSemanticConfig({ semantic: { model: "gpt-4o" } })).toBe(true);
  });
});

describe("pickDefaultProvider", () => {
  it("uses the provider from existing config first", () => {
    const provider = pickDefaultProvider(
      { semantic: { provider: "anthropic" } },
      { NEBIUS_API_KEY: "nk", OPENAI_API_KEY: "ok" }
    );
    expect(provider).toBe("anthropic");
  });

  it("falls back to the provider for the sole env var", () => {
    expect(pickDefaultProvider({}, { OPENAI_API_KEY: "ok" })).toBe("openai");
    expect(pickDefaultProvider({}, { ANTHROPIC_API_KEY: "ak" })).toBe("anthropic");
  });

  it("returns nebius when no signals are present", () => {
    expect(pickDefaultProvider({}, {})).toBe("nebius");
  });

  it("returns nebius when multiple env keys are present (ambiguous)", () => {
    expect(
      pickDefaultProvider(
        {},
        {
          NEBIUS_API_KEY: "nk",
          OPENAI_API_KEY: "ok",
        }
      )
    ).toBe("nebius");
  });
});

describe("buildConfigFromAnswers", () => {
  it("writes a complete semantic section", () => {
    const next = buildConfigFromAnswers(
      {},
      {
        provider: "nebius",
        model: "openai/gpt-oss-120b",
        checks: ["aria-mismatch", "page-title"],
        timeout: 90_000,
      }
    );

    expect(next).toEqual({
      semantic: {
        provider: "nebius",
        model: "openai/gpt-oss-120b",
        checks: ["aria-mismatch", "page-title"],
        timeout: 90_000,
      },
    });
  });

  it("omits checks when answers.checks is undefined (default = all built-ins)", () => {
    const next = buildConfigFromAnswers({}, { provider: "openai", timeout: 120_000 });
    expect(next.semantic?.checks).toBeUndefined();
  });

  it("omits model when not provided", () => {
    const next = buildConfigFromAnswers({}, { provider: "openai", timeout: 120_000 });
    expect(next.semantic?.model).toBeUndefined();
  });

  it("preserves unrelated top-level keys from the existing config", () => {
    const existing = {
      semantic: { provider: "nebius" },
      // @ts-expect-error — simulating a future top-level key
      experimental: { foo: true },
    } as BarrieretestConfig;

    const next = buildConfigFromAnswers(existing, {
      provider: "openai",
      model: "gpt-4o",
      timeout: 60_000,
    });

    // @ts-expect-error — see above
    expect(next.experimental).toEqual({ foo: true });
    expect(next.semantic).toEqual({
      provider: "openai",
      model: "gpt-4o",
      timeout: 60_000,
    });
  });

  it("replaces the existing semantic section wholesale", () => {
    const existing: BarrieretestConfig = {
      semantic: {
        provider: "nebius",
        model: "openai/gpt-oss-120b",
        checks: ["aria-mismatch"],
        timeout: 90_000,
      },
    };

    const next = buildConfigFromAnswers(existing, {
      provider: "openai",
      model: "gpt-4o",
      timeout: 30_000,
    });

    expect(next.semantic).toEqual({
      provider: "openai",
      model: "gpt-4o",
      timeout: 30_000,
    });
  });
});

describe("DEFAULT_MODELS", () => {
  it("has a default for every supported provider", () => {
    expect(DEFAULT_MODELS.nebius).toBeTruthy();
    expect(DEFAULT_MODELS.openai).toBeTruthy();
    expect(DEFAULT_MODELS.anthropic).toBeTruthy();
  });
});

describe("runInit (non-TTY)", () => {
  it("returns an error in non-TTY environments without prompting", async () => {
    // bun test isn't attached to a TTY, so isInteractive() is false and
    // runInit should bail before any prompt is shown.
    const result = await runInit({ env: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain("interactive terminal");
    expect(BUILT_IN_CHECK_IDS.length).toBeGreaterThan(0); // sanity: registry populated
  });
});
