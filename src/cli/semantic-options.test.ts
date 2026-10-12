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

  it("passes user-defined customChecks through to SemanticOptions", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "nebius",
      config: {
        semantic: {
          customChecks: [
            {
              id: "button-verbs",
              title: "Button Verbs",
              description: "Buttons use clear action verbs",
              prompt: "Flag buttons whose label is not a clear action verb.",
            },
          ],
        },
      },
      env: { NEBIUS_API_KEY: "nk" },
    });

    expect(result?.customChecks).toBeDefined();
    expect(result?.customChecks?.map((c) => c.id)).toEqual(["button-verbs"]);
    // Converted to runtime shape:
    expect(result?.customChecks?.[0].needsScreenshot).toBe(false);
    expect(result?.customChecks?.[0].needsContext).toEqual(["body"]);
  });

  it("accepts --semantic-checks pointing at a user-defined id", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "nebius",
      semanticChecks: ["button-verbs"],
      config: {
        semantic: {
          customChecks: [
            {
              id: "button-verbs",
              title: "Button Verbs",
              description: "Buttons use clear action verbs",
              prompt: "Flag buttons whose label is not a clear action verb.",
            },
          ],
        },
      },
      env: { NEBIUS_API_KEY: "nk" },
    });

    expect(result?.checks).toEqual(["button-verbs"]);
  });

  it("rejects --semantic-checks ids that match neither built-in nor user checks", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "nebius",
        semanticChecks: ["nope"],
        config: {
          semantic: {
            customChecks: [
              {
                id: "button-verbs",
                title: "Button Verbs",
                description: "X",
                prompt: "Flag buttons whose label is not a clear action verb.",
              },
            ],
          },
        },
        env: { NEBIUS_API_KEY: "nk" },
      })
    ).toThrow(/Unknown semantic check/);
  });
});

describe("semanticRequested (new flags)", () => {
  it("is true for --semantic-base-url and the per-tier flags", () => {
    for (const input of [
      { semanticBaseUrl: "https://api.eu.mistral.ai/v1" },
      { semanticSmallProvider: "mistral" },
      { semanticSmallModel: "mistral-small-2603" },
      { semanticLargeProvider: "mistral" },
      { semanticLargeModel: "mistral-large-4" },
    ]) {
      expect(semanticRequested({ ...input, config: EMPTY_CONFIG, env: {} })).toBe(true);
    }
  });

  it("is false when only tier config defaults are set", () => {
    expect(
      semanticRequested({
        config: { semantic: { provider: "mistral", tiers: { small: { model: "x" } } } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toBe(false);
  });
});

describe("resolveSemanticOptions (providers and env vars)", () => {
  it("infers mistral from MISTRAL_API_KEY", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: EMPTY_CONFIG,
      env: { MISTRAL_API_KEY: "mk" },
    });
    expect(result?.provider.name).toBe("mistral");
    expect(result?.provider.apiKey).toBe("mk");
  });

  it("infers openai-compatible from OPENAI_COMPATIBLE_API_KEY with its base URL", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticModel: "some/model",
      config: EMPTY_CONFIG,
      env: {
        OPENAI_COMPATIBLE_API_KEY: "ck",
        OPENAI_COMPATIBLE_BASE_URL: "https://api.tokenfactory.nebius.com/v1",
      },
    });
    expect(result?.provider.name).toBe("openai-compatible");
    expect(result?.provider.baseUrl).toBe("https://api.tokenfactory.nebius.com/v1");
  });

  it("lists all five env vars when none is set", () => {
    expect(() => resolveSemanticOptions({ semantic: true, config: EMPTY_CONFIG, env: {} })).toThrow(
      /MISTRAL_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENAI_COMPATIBLE_API_KEY, NEBIUS_API_KEY/
    );
  });

  it("reports ambiguity when mistral and nebius keys are both present", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: EMPTY_CONFIG,
        env: { MISTRAL_API_KEY: "mk", NEBIUS_API_KEY: "nk" },
      })
    ).toThrow(
      /Multiple semantic provider API keys found in env \(MISTRAL_API_KEY, NEBIUS_API_KEY\)/
    );
  });

  it("names MISTRAL_API_KEY when mistral is selected without a key", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "mistral",
        config: EMPTY_CONFIG,
        env: {},
      })
    ).toThrow(/MISTRAL_API_KEY is not set/);
  });

  it("takes the base URL from the flag over config and env", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "openai-compatible",
      semanticBaseUrl: "https://flag.example.com/v1",
      semanticModel: "some/model",
      config: { semantic: { baseUrl: "https://config.example.com/v1" } },
      env: {
        OPENAI_COMPATIBLE_API_KEY: "ck",
        OPENAI_COMPATIBLE_BASE_URL: "https://env.example.com/v1",
      },
    });
    expect(result?.provider.baseUrl).toBe("https://flag.example.com/v1");
  });

  it("takes the base URL from config over env", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "openai-compatible",
      config: { semantic: { baseUrl: "https://config.example.com/v1", model: "some/model" } },
      env: {
        OPENAI_COMPATIBLE_API_KEY: "ck",
        OPENAI_COMPATIBLE_BASE_URL: "https://env.example.com/v1",
      },
    });
    expect(result?.provider.baseUrl).toBe("https://config.example.com/v1");
  });

  it("fails loudly when openai-compatible has no base URL", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "openai-compatible",
        semanticModel: "some/model",
        config: EMPTY_CONFIG,
        env: { OPENAI_COMPATIBLE_API_KEY: "ck" },
      })
    ).toThrow(
      /requires a base URL\. Pass --semantic-base-url, set semantic\.baseUrl, or export OPENAI_COMPATIBLE_BASE_URL/
    );
  });

  it("fails loudly when openai-compatible has no model", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "openai-compatible",
        semanticBaseUrl: "https://api.example.com/v1",
        config: EMPTY_CONFIG,
        env: { OPENAI_COMPATIBLE_API_KEY: "ck" },
      })
    ).toThrow(/requires a model\. Pass --semantic-model or set semantic\.model/);
  });

  it("passes a base URL through for a vendor provider too", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "mistral",
      semanticBaseUrl: "https://api.eu.mistral.ai/v1",
      config: EMPTY_CONFIG,
      env: { MISTRAL_API_KEY: "mk" },
    });
    expect(result?.provider.baseUrl).toBe("https://api.eu.mistral.ai/v1");
  });

  it("omits baseUrl for a vendor provider when nothing set it", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "mistral",
      config: EMPTY_CONFIG,
      env: { MISTRAL_API_KEY: "mk", OPENAI_COMPATIBLE_BASE_URL: "https://ignored.example.com" },
    });
    expect(result?.provider.baseUrl).toBeUndefined();
  });
});

describe("resolveSemanticOptions (model tiers)", () => {
  it("emits no tiers when nothing addresses a tier", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "mistral",
      config: EMPTY_CONFIG,
      env: { MISTRAL_API_KEY: "mk" },
    });
    expect(result?.tiers).toBeUndefined();
  });

  it("completes a config tier that only names a model", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: {
        semantic: {
          provider: "mistral",
          model: "mistral-large-4",
          tiers: { small: { model: "mistral-small-2603" } },
        },
      },
      env: { MISTRAL_API_KEY: "mk" },
    });

    expect(result?.tiers).toEqual({
      small: { name: "mistral", apiKey: "mk", model: "mistral-small-2603" },
    });
    expect(result?.provider.model).toBe("mistral-large-4");
  });

  it("inherits the default model when the tier only switches nothing", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticLargeProvider: "mistral",
      config: { semantic: { provider: "mistral", model: "mistral-large-4" } },
      env: { MISTRAL_API_KEY: "mk" },
    });
    expect(result?.tiers?.large?.model).toBe("mistral-large-4");
  });

  it("drops the inherited model when the tier switches provider", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticSmallProvider: "openai",
      config: { semantic: { provider: "mistral", model: "mistral-large-4" } },
      env: { MISTRAL_API_KEY: "mk", OPENAI_API_KEY: "sk" },
    });

    expect(result?.tiers?.small).toEqual({ name: "openai", apiKey: "sk" });
    expect(result?.provider).toEqual({
      name: "mistral",
      apiKey: "mk",
      model: "mistral-large-4",
    });
  });

  it("lets tier flags win over tier config", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticSmallProvider: "openai",
      semanticSmallModel: "gpt-4o-mini",
      config: {
        semantic: {
          provider: "mistral",
          tiers: { small: { provider: "mistral", model: "mistral-small-2603" } },
        },
      },
      env: { MISTRAL_API_KEY: "mk", OPENAI_API_KEY: "sk" },
    });
    expect(result?.tiers?.small).toEqual({ name: "openai", apiKey: "sk", model: "gpt-4o-mini" });
  });

  it("puts the two tiers on different providers", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticSmallProvider: "mistral",
      semanticSmallModel: "mistral-small-2603",
      semanticLargeProvider: "anthropic",
      semanticLargeModel: "claude-sonnet-4-5",
      config: { semantic: { provider: "mistral" } },
      env: { MISTRAL_API_KEY: "mk", ANTHROPIC_API_KEY: "ak" },
    });

    expect(result?.tiers).toEqual({
      small: { name: "mistral", apiKey: "mk", model: "mistral-small-2603" },
      large: { name: "anthropic", apiKey: "ak", model: "claude-sonnet-4-5" },
    });
  });

  it("fails loudly when the tier provider's API key is missing", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticSmallProvider: "openai",
        config: { semantic: { provider: "mistral" } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/OPENAI_API_KEY is not set/);
  });

  it("rejects an invalid tier provider", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticLargeProvider: "llama",
        config: { semantic: { provider: "mistral" } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic provider 'llama'/);
  });

  it("names the tier config key when an openai-compatible tier has no base URL", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticSmallProvider: "openai-compatible",
        semanticSmallModel: "some/model",
        config: { semantic: { provider: "mistral" } },
        env: { MISTRAL_API_KEY: "mk", OPENAI_COMPATIBLE_API_KEY: "ck" },
      })
    ).toThrow(
      /for the small tier requires a base URL\. Set semantic\.tiers\.small\.baseUrl or export OPENAI_COMPATIBLE_BASE_URL\./
    );
  });

  it("names the tier flag when an openai-compatible tier has no model", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticLargeProvider: "openai-compatible",
        config: {
          semantic: {
            provider: "mistral",
            tiers: { large: { baseUrl: "https://a.example.com/v1" } },
          },
        },
        env: { MISTRAL_API_KEY: "mk", OPENAI_COMPATIBLE_API_KEY: "ck" },
      })
    ).toThrow(/for the large tier requires a model\. Pass --semantic-large-model/);
  });

  it("takes an openai-compatible tier base URL from config", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: {
        semantic: {
          provider: "mistral",
          tiers: {
            large: {
              provider: "openai-compatible",
              model: "some/model",
              baseUrl: "https://a.example.com/v1",
            },
          },
        },
      },
      env: { MISTRAL_API_KEY: "mk", OPENAI_COMPATIBLE_API_KEY: "ck" },
    });

    expect(result?.tiers?.large).toEqual({
      name: "openai-compatible",
      apiKey: "ck",
      model: "some/model",
      baseUrl: "https://a.example.com/v1",
    });
  });

  it("inherits the default base URL for a tier that stays on the default provider", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      semanticProvider: "mistral",
      semanticBaseUrl: "https://api.eu.mistral.ai/v1",
      semanticSmallModel: "mistral-small-2603",
      config: EMPTY_CONFIG,
      env: { MISTRAL_API_KEY: "mk" },
    });
    expect(result?.tiers?.small?.baseUrl).toBe("https://api.eu.mistral.ai/v1");
  });

  it("inherits reasoningEffort for a tier that stays on the default provider", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: {
        semantic: {
          provider: "mistral",
          model: "mistral-large-4",
          reasoningEffort: "high",
          tiers: { small: { model: "mistral-small-2603" } },
        },
      },
      env: { MISTRAL_API_KEY: "mk" },
    });

    expect(result?.provider.reasoningEffort).toBe("high");
    expect(result?.tiers?.small).toEqual({
      name: "mistral",
      apiKey: "mk",
      model: "mistral-small-2603",
      reasoningEffort: "high",
    });
  });

  it("takes a tier's own reasoningEffort and drops the inherited one on a provider switch", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: {
        semantic: {
          provider: "mistral",
          reasoningEffort: "high",
          tiers: {
            large: { reasoningEffort: "none" },
            small: { provider: "openai", model: "gpt-4o-mini" },
          },
        },
      },
      env: { MISTRAL_API_KEY: "mk", OPENAI_API_KEY: "sk" },
    });

    expect(result?.tiers?.large).toEqual({
      name: "mistral",
      apiKey: "mk",
      reasoningEffort: "none",
    });
    expect(result?.tiers?.small).toEqual({
      name: "openai",
      apiKey: "sk",
      model: "gpt-4o-mini",
    });
  });

  it("ignores an empty tier object in config", () => {
    const result = resolveSemanticOptions({
      semantic: true,
      config: { semantic: { provider: "mistral", tiers: { small: {} } } },
      env: { MISTRAL_API_KEY: "mk" },
    });
    expect(result?.tiers).toBeUndefined();
  });
});

describe("resolveSemanticOptions (invalid config and flag values)", () => {
  it("rejects a whitespace-only semantic.model", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: { semantic: { provider: "mistral", model: "   " } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/semantic\.model cannot be empty/);
  });

  it("rejects a semantic.baseUrl that is not an http(s) URL", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: { semantic: { provider: "mistral", baseUrl: "ftp://example.com" } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic\.baseUrl 'ftp:\/\/example\.com': must be an http\(s\) URL/);
  });

  it("rejects a --semantic-base-url that is not an http(s) URL", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticBaseUrl: "not a url",
        config: { semantic: { provider: "mistral" } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid --semantic-base-url 'not a url': must be an http\(s\) URL/);
  });

  it("rejects a blank --semantic-small-model", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticSmallModel: " ",
        config: { semantic: { provider: "mistral" } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/--semantic-small-model cannot be empty/);
  });

  it("rejects a whitespace-only tier model from config", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: { semantic: { provider: "mistral", tiers: { small: { model: "  " } } } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/semantic\.tiers\.small\.model cannot be empty/);
  });

  it("rejects a bad tier base URL from config", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: {
          semantic: {
            provider: "mistral",
            tiers: { large: { baseUrl: "ftp://example.com" } },
          },
        },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic\.tiers\.large\.baseUrl 'ftp:\/\/example\.com'/);
  });

  it("names the config key for an invalid tier provider in config", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: {
          semantic: {
            provider: "mistral",
            // biome-ignore lint/suspicious/noExplicitAny: hand-edited config can hold anything
            tiers: { small: { provider: "llama" as any } },
          },
        },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic provider 'llama' for semantic\.tiers\.small\.provider/);
  });

  it("names the env var for a bad OPENAI_COMPATIBLE_BASE_URL", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticProvider: "openai-compatible",
        semanticModel: "some/model",
        config: EMPTY_CONFIG,
        env: { OPENAI_COMPATIBLE_API_KEY: "ck", OPENAI_COMPATIBLE_BASE_URL: "ftp://example.com" },
      })
    ).toThrow(/Invalid OPENAI_COMPATIBLE_BASE_URL 'ftp:\/\/example\.com'/);
  });
});

describe("semanticRequested (explicitly empty flag values)", () => {
  it("is true for an empty value on any value-taking flag", () => {
    for (const input of [
      { semanticProvider: "" },
      { semanticModel: "" },
      { semanticBaseUrl: "" },
      { semanticSmallProvider: "" },
      { semanticSmallModel: "" },
      { semanticLargeProvider: "" },
      { semanticLargeModel: "" },
      { semanticChecks: [] },
    ]) {
      expect(semanticRequested({ ...input, config: EMPTY_CONFIG, env: {} })).toBe(true);
    }
  });
});

describe("resolveSemanticOptions (explicitly empty flag values)", () => {
  const MISTRAL_CONFIG: BarrieretestConfig = { semantic: { provider: "mistral" } };
  const MISTRAL_ENV = { MISTRAL_API_KEY: "mk" };

  it("rejects an empty --semantic-small-model instead of ignoring it", () => {
    expect(() =>
      resolveSemanticOptions({
        semanticSmallModel: "",
        config: MISTRAL_CONFIG,
        env: MISTRAL_ENV,
      })
    ).toThrow(/--semantic-small-model cannot be empty/);
  });

  it("rejects an empty --semantic-large-model", () => {
    expect(() =>
      resolveSemanticOptions({
        semanticLargeModel: "",
        config: MISTRAL_CONFIG,
        env: MISTRAL_ENV,
      })
    ).toThrow(/--semantic-large-model cannot be empty/);
  });

  it("rejects an empty --semantic-small-provider rather than using the default", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticSmallProvider: "",
        config: MISTRAL_CONFIG,
        env: MISTRAL_ENV,
      })
    ).toThrow(/Invalid semantic provider '' for --semantic-small-provider/);
  });

  it("rejects an empty --semantic-large-provider", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        semanticLargeProvider: "",
        config: MISTRAL_CONFIG,
        env: MISTRAL_ENV,
      })
    ).toThrow(/Invalid semantic provider '' for --semantic-large-provider/);
  });

  it("rejects an empty --semantic-provider rather than inferring from env", () => {
    expect(() =>
      resolveSemanticOptions({
        semanticProvider: "",
        config: EMPTY_CONFIG,
        env: MISTRAL_ENV,
      })
    ).toThrow(/Invalid semantic provider '' for --semantic-provider/);
  });

  it("rejects an empty --semantic-model", () => {
    expect(() =>
      resolveSemanticOptions({
        semanticModel: "",
        config: MISTRAL_CONFIG,
        env: MISTRAL_ENV,
      })
    ).toThrow(/--semantic-model cannot be empty/);
  });

  it("rejects an empty --semantic-base-url", () => {
    expect(() =>
      resolveSemanticOptions({
        semanticBaseUrl: "",
        config: MISTRAL_CONFIG,
        env: MISTRAL_ENV,
      })
    ).toThrow(/Invalid --semantic-base-url '': must be an http\(s\) URL/);
  });

  it("rejects an empty --semantic-checks instead of falling back to config", () => {
    expect(() =>
      resolveSemanticOptions({
        semanticChecks: [],
        config: { semantic: { provider: "mistral", checks: ["page-title"] } },
        env: MISTRAL_ENV,
      })
    ).toThrow(/--semantic-checks cannot be empty/);
  });
});

describe("resolveSemanticOptions (non-string config values)", () => {
  it("names the key for a numeric semantic.model", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        // biome-ignore lint/suspicious/noExplicitAny: hand-edited config can hold anything
        config: { semantic: { provider: "mistral", model: 5 as any } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic\.model: must be a string/);
  });

  it("names the key for an object tier model", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: {
          semantic: {
            provider: "mistral",
            // biome-ignore lint/suspicious/noExplicitAny: hand-edited config can hold anything
            tiers: { small: { model: {} as any } },
          },
        },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic\.tiers\.small\.model: must be a string/);
  });

  it("names the key for a non-string semantic.baseUrl", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        // biome-ignore lint/suspicious/noExplicitAny: hand-edited config can hold anything
        config: { semantic: { provider: "mistral", baseUrl: 42 as any } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic\.baseUrl: must be a string/);
  });

  it("names the key for a non-string semantic.reasoningEffort", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        // biome-ignore lint/suspicious/noExplicitAny: hand-edited config can hold anything
        config: { semantic: { provider: "mistral", reasoningEffort: true as any } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic\.reasoningEffort: must be a string/);
  });

  it("rejects a whitespace-only tier reasoningEffort", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        config: {
          semantic: { provider: "mistral", tiers: { large: { reasoningEffort: "  " } } },
        },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/semantic\.tiers\.large\.reasoningEffort cannot be empty/);
  });

  it("names the key for a non-string semantic.provider", () => {
    expect(() =>
      resolveSemanticOptions({
        semantic: true,
        // biome-ignore lint/suspicious/noExplicitAny: hand-edited config can hold anything
        config: { semantic: { provider: 7 as any } },
        env: { MISTRAL_API_KEY: "mk" },
      })
    ).toThrow(/Invalid semantic\.provider: must be a string/);
  });
});
