import { describe, expect, it } from "bun:test";
import { BUILT_IN_CHECK_IDS } from "../semantic/checks/index.js";
import type { BarrieretestConfig } from "./config.js";
import {
  buildConfigFromAnswers,
  DEFAULT_MODELS,
  hasExistingSemanticConfig,
  MISTRAL_SMALL_MODEL,
  pickDefaultProvider,
  PROVIDER_OPTIONS,
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

  it("returns mistral when no signals are present", () => {
    expect(pickDefaultProvider({}, {})).toBe("mistral");
  });

  it("returns mistral when multiple env keys are present (ambiguous)", () => {
    expect(
      pickDefaultProvider(
        {},
        {
          NEBIUS_API_KEY: "nk",
          OPENAI_API_KEY: "ok",
        }
      )
    ).toBe("mistral");
  });

  it("falls back to mistral for a configured provider the wizard does not offer", () => {
    expect(pickDefaultProvider({ semantic: { provider: "openai-compatible" } }, {})).toBe(
      "mistral"
    );
  });

  it("falls back to the provider for a sole MISTRAL_API_KEY", () => {
    expect(pickDefaultProvider({}, { MISTRAL_API_KEY: "mk" })).toBe("mistral");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("offers Mistral first", () => {
    expect(PROVIDER_OPTIONS[0].value).toBe("mistral");
    expect(PROVIDER_OPTIONS[0].hint).toContain("alt text");
  });

  it("keeps the previously offered providers", () => {
    expect(PROVIDER_OPTIONS.map((o) => o.value)).toEqual([
      "mistral",
      "nebius",
      "openai",
      "anthropic",
    ]);
  });

  it("does not offer openai-compatible (config/flag only)", () => {
    expect(PROVIDER_OPTIONS.map((o) => String(o.value))).not.toContain("openai-compatible");
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

  it("writes the small tier when the small-model question was answered yes", () => {
    const next = buildConfigFromAnswers(
      {},
      {
        provider: "mistral",
        model: "mistral-large-4",
        smallTierModel: MISTRAL_SMALL_MODEL,
        timeout: 120_000,
      }
    );

    expect(next.semantic?.tiers).toEqual({ small: { model: "mistral-small-2603" } });
    // Provider omitted means "same provider as the default".
    expect(next.semantic?.tiers?.small?.provider).toBeUndefined();
  });

  it("omits tiers when the small-model question was declined", () => {
    const next = buildConfigFromAnswers(
      {},
      { provider: "mistral", model: "mistral-large-4", timeout: 120_000 }
    );
    expect(next.semantic?.tiers).toBeUndefined();
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

  it("suggests Mistral Large for the default tier and Small for the cheap one", () => {
    expect(DEFAULT_MODELS.mistral).toBe("mistral-large-4");
    expect(MISTRAL_SMALL_MODEL).toBe("mistral-small-2603");
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
