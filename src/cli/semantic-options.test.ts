import { describe, expect, it } from "bun:test";
import { BUILT_IN_CHECK_IDS } from "../semantic/checks/index.js";
import type { BarrieretestConfig } from "./config.js";
import { resolveSemanticOptions, semanticRequested } from "./semantic-options.js";

const EMPTY_CONFIG: BarrieretestConfig = {};

describe("semanticRequested", () => {
  it("is false when no semantic flags are present", () => {
    expect(
      semanticRequested({
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toBe(false);
  });

  it("is true when --semantic is explicitly set", () => {
    expect(
      semanticRequested({
        semantic: true,
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toBe(true);
  });

  it("is true when --semantic-provider is set implicitly", () => {
    expect(
      semanticRequested({
        semanticProvider: "nebius",
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toBe(true);
  });

  it("is true when --semantic-model is set implicitly", () => {
    expect(
      semanticRequested({
        semanticModel: "gpt-4o",
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toBe(true);
  });

  it("is true when --semantic-checks is set implicitly", () => {
    expect(
      semanticRequested({
        semanticChecks: ["aria-mismatch"],
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toBe(true);
  });

  it("is true when --semantic-timeout is set implicitly", () => {
    expect(
      semanticRequested({
        semanticTimeout: 60_000,
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toBe(true);
  });

  it("is false when only config defaults are set", () => {
    expect(
      semanticRequested({
        config: { semantic: { provider: "nebius" } },
        env: { NEBIUS_API_KEY: "secret" },
      })
    ).toBe(false);
  });
});

describe("resolveSemanticOptions", () => {
  it("returns undefined when not requested", () => {
    const result = resolveSemanticOptions({
      config: EMPTY_CONFIG,
      env: {},
    });
    expect(result).toBeUndefined();
  });

  it("uses the CLI-provided provider", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "openai",
      config: { semantic: { provider: "nebius" } },
      env: { OPENAI_API_KEY: "sk-openai", NEBIUS_API_KEY: "nk-nebius" },
    });

    expect(result?.provider.name).toBe("openai");
    expect(result?.provider.apiKey).toBe("sk-openai");
  });

  it("uses the config default provider when CLI is absent", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: { semantic: { provider: "anthropic", model: "claude" } },
      env: { ANTHROPIC_API_KEY: "ak-anthropic" },
    });

    expect(result?.provider.name).toBe("anthropic");
    expect(result?.provider.apiKey).toBe("ak-anthropic");
    expect(result?.provider.model).toBe("claude");
  });

  it("infers provider from env when exactly one key is present", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: EMPTY_CONFIG,
      env: { NEBIUS_API_KEY: "nk" },
    });
    expect(result?.provider.name).toBe("nebius");
    expect(result?.provider.apiKey).toBe("nk");
  });

  it("errors when no provider can be resolved", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toThrow(/No semantic provider selected/);
  });

  it("errors when multiple env keys are present and provider is unset", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: EMPTY_CONFIG,
        env: { NEBIUS_API_KEY: "nk", OPENAI_API_KEY: "ok" },
      })
    ).toThrow(/Multiple semantic provider API keys/);
  });

  it("errors when the chosen provider has no matching env key", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "nebius",
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toThrow(/NEBIUS_API_KEY is not set/);
  });

  it("errors on an invalid provider string", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "llama",
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toThrow(/Invalid semantic provider 'llama'/);
  });

  it("rejects unknown semantic check IDs", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "nebius",
        semanticChecks: ["page-title", "nonsense-check"],
        config: EMPTY_CONFIG,
        env: { NEBIUS_API_KEY: "nk" },
      })
    ).toThrow(/Unknown semantic check id\(s\): nonsense-check/);
  });

  it("accepts all built-in checks", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "nebius",
      semanticChecks: [...BUILT_IN_CHECK_IDS],
      config: EMPTY_CONFIG,
      env: { NEBIUS_API_KEY: "nk" },
    });

    expect(result?.checks).toEqual([...BUILT_IN_CHECK_IDS]);
  });

  it("fails when combined with --engine pa11y", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        engine: "pa11y",
        semanticProvider: "nebius",
        config: EMPTY_CONFIG,
        env: { NEBIUS_API_KEY: "nk" },
      })
    ).toThrow(/pa11y/);
  });

  it("passes through the timeout from config when CLI omits it", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: { semantic: { provider: "nebius", timeout: 90_000 } },
      env: { NEBIUS_API_KEY: "nk" },
    });
    expect(result?.timeout).toBe(90_000);
  });

  it("lets CLI timeout override config", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticTimeout: 30_000,
      config: { semantic: { provider: "nebius", timeout: 90_000 } },
      env: { NEBIUS_API_KEY: "nk" },
    });
    expect(result?.timeout).toBe(30_000);
  });

  it("rejects an invalid timeout", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "nebius",
        semanticTimeout: -1,
        config: EMPTY_CONFIG,
        env: { NEBIUS_API_KEY: "nk" },
      })
    ).toThrow(/Invalid semantic timeout/);
  });

  it("lets CLI model override config", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticModel: "gpt-4o-mini",
      config: { semantic: { provider: "openai", model: "gpt-4o" } },
      env: { OPENAI_API_KEY: "sk" },
    });
    expect(result?.provider.model).toBe("gpt-4o-mini");
  });

  it("omits model and timeout when not set anywhere", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "nebius",
      config: EMPTY_CONFIG,
      env: { NEBIUS_API_KEY: "nk" },
    });
    expect(result?.provider.model).toBeUndefined();
    expect(result?.timeout).toBeUndefined();
    expect(result?.checks).toBeUndefined();
  });

  it("is triggered implicitly by --semantic-* flags", () => {
    const result = resolveSemanticOptions({
      semanticProvider: "openai",
      config: EMPTY_CONFIG,
      env: { OPENAI_API_KEY: "sk" },
    });
    expect(result?.provider.name).toBe("openai");
  });
});
