import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BarrieretestConfig,
  findProjectConfigPath,
  findRepoRoot,
  getConfigPath,
  getConfigValue,
  loadMergedConfig,
  mergeConfigs,
  PROJECT_CONFIG_FILENAME,
  readConfig,
  resolveProjectConfigWritePath,
  SEMANTIC_PROVIDERS,
  setConfigValue,
  SUPPORTED_CONFIG_KEYS,
  unsetConfigValue,
  writeConfig,
} from "./config.js";

const TEST_DIR = "/tmp/barrieretest-config-test";
const TEST_CONFIG = join(TEST_DIR, "config.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("getConfigPath", () => {
  it("returns a path under the user's home directory", () => {
    const path = getConfigPath();
    expect(path).toContain(".barrieretest");
    expect(path.endsWith("config.json")).toBe(true);
  });
});

describe("readConfig", () => {
  it("returns an empty object when the file does not exist", () => {
    const cfg = readConfig(join(TEST_DIR, "missing.json"));
    expect(cfg).toEqual({});
  });

  it("parses a valid config file", () => {
    writeFileSync(
      TEST_CONFIG,
      JSON.stringify({
        semantic: { provider: "nebius", timeout: 90_000 },
      })
    );

    const cfg = readConfig(TEST_CONFIG);
    expect(cfg.semantic?.provider).toBe("nebius");
    expect(cfg.semantic?.timeout).toBe(90_000);
  });

  it("returns empty object for malformed JSON", () => {
    writeFileSync(TEST_CONFIG, "{ not valid json");
    expect(readConfig(TEST_CONFIG)).toEqual({});
  });

  it("returns empty object when file is not an object", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify(["a", "b"]));
    expect(readConfig(TEST_CONFIG)).toEqual({});
  });

  it("throws a friendly error when semantic.customChecks is not an array", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { customChecks: {} } }));
    expect(() => readConfig(TEST_CONFIG)).toThrow(/semantic\.customChecks must be an array/);
  });

  it("throws when semantic.customChecks is a string", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { customChecks: "oops" } }));
    expect(() => readConfig(TEST_CONFIG)).toThrow(/semantic\.customChecks must be an array/);
  });

  it("throws when a customChecks entry is null or a primitive", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { customChecks: [null] } }));
    expect(() => readConfig(TEST_CONFIG)).toThrow(/customChecks\[0\] must be an object/);
  });

  it("includes the file path in the error message", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { customChecks: {} } }));
    expect(() => readConfig(TEST_CONFIG)).toThrow(new RegExp(TEST_CONFIG));
  });

  it("throws when semantic.tiers is not an object", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { tiers: "small" } }));
    expect(() => readConfig(TEST_CONFIG)).toThrow(/semantic\.tiers must be an object/);
    expect(() => readConfig(TEST_CONFIG)).toThrow(new RegExp(TEST_CONFIG));
  });

  it("throws when a tier entry is not an object", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { tiers: { small: "mistral" } } }));
    expect(() => readConfig(TEST_CONFIG)).toThrow(/semantic\.tiers\.small must be an object/);

    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { tiers: { large: [] } } }));
    expect(() => readConfig(TEST_CONFIG)).toThrow(/semantic\.tiers\.large must be an object/);
  });

  it("accepts a config without tiers and one with empty tier objects", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ semantic: { tiers: { small: {} } } }));
    expect(readConfig(TEST_CONFIG)).toEqual({ semantic: { tiers: { small: {} } } });
  });
});

describe("writeConfig", () => {
  it("creates the parent directory if missing", () => {
    const nested = join(TEST_DIR, "nested", "deep", "config.json");
    writeConfig({ semantic: { provider: "openai" } }, nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("round-trips a config through read/write", () => {
    const cfg: BarrieretestConfig = {
      semantic: {
        provider: "nebius",
        model: "openai/gpt-oss-120b",
        checks: ["aria-mismatch", "page-title"],
        timeout: 120_000,
      },
    };

    writeConfig(cfg, TEST_CONFIG);
    const read = readConfig(TEST_CONFIG);
    expect(read).toEqual(cfg);
  });

  it("writes pretty-printed JSON with trailing newline", () => {
    writeConfig({ semantic: { provider: "openai" } }, TEST_CONFIG);
    const raw = readFileSync(TEST_CONFIG, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "semantic"');
  });
});

describe("getConfigValue", () => {
  it("returns undefined for unset keys without throwing", () => {
    expect(getConfigValue({}, "semantic.provider")).toBeUndefined();
  });

  it("returns the semantic section when asked for 'semantic'", () => {
    const cfg: BarrieretestConfig = { semantic: { provider: "nebius" } };
    expect(getConfigValue(cfg, "semantic")).toEqual({ provider: "nebius" });
  });

  it("returns the stored value for a supported key", () => {
    const cfg: BarrieretestConfig = {
      semantic: { checks: ["aria-mismatch"], timeout: 42 },
    };
    expect(getConfigValue(cfg, "semantic.checks")).toEqual(["aria-mismatch"]);
    expect(getConfigValue(cfg, "semantic.timeout")).toBe(42);
  });

  it("throws on unknown keys", () => {
    expect(() => getConfigValue({}, "nonsense.key")).toThrow(/Unknown config key/);
  });
});

describe("setConfigValue", () => {
  it("sets a provider", () => {
    const cfg = setConfigValue({}, "semantic.provider", "nebius");
    expect(cfg.semantic?.provider).toBe("nebius");
  });

  it("rejects invalid providers", () => {
    expect(() => setConfigValue({}, "semantic.provider", "llama")).toThrow(
      /Invalid provider 'llama'/
    );
  });

  it("parses comma-separated checks into an array", () => {
    const cfg = setConfigValue(
      {},
      "semantic.checks",
      " aria-mismatch , page-title ,alt-text-quality "
    );
    expect(cfg.semantic?.checks).toEqual(["aria-mismatch", "page-title", "alt-text-quality"]);
  });

  it("rejects an empty checks list", () => {
    expect(() => setConfigValue({}, "semantic.checks", " , ,")).toThrow(
      /semantic\.checks cannot be empty/
    );
  });

  it("parses timeout as a positive integer", () => {
    const cfg = setConfigValue({}, "semantic.timeout", "90000");
    expect(cfg.semantic?.timeout).toBe(90_000);
  });

  it("rejects non-positive or non-numeric timeout", () => {
    expect(() => setConfigValue({}, "semantic.timeout", "0")).toThrow(/must be a positive/);
    expect(() => setConfigValue({}, "semantic.timeout", "-1")).toThrow(/must be a positive/);
    expect(() => setConfigValue({}, "semantic.timeout", "abc")).toThrow(/must be a positive/);
  });

  it("stores model as-is", () => {
    const cfg = setConfigValue({}, "semantic.model", "gpt-4o");
    expect(cfg.semantic?.model).toBe("gpt-4o");
  });

  it("rejects empty model", () => {
    expect(() => setConfigValue({}, "semantic.model", "   ")).toThrow(
      /semantic\.model cannot be empty/
    );
  });

  it("rejects unknown keys", () => {
    expect(() => setConfigValue({}, "semantic.whatever", "x")).toThrow(/Unknown config key/);
  });

  it("preserves other existing values", () => {
    const cfg: BarrieretestConfig = {
      semantic: { provider: "nebius", model: "mini" },
    };
    const next = setConfigValue(cfg, "semantic.timeout", "60000");
    expect(next.semantic?.provider).toBe("nebius");
    expect(next.semantic?.model).toBe("mini");
    expect(next.semantic?.timeout).toBe(60_000);
  });
});

describe("setConfigValue (baseUrl and tiers)", () => {
  it("stores a base URL", () => {
    const cfg = setConfigValue({}, "semantic.baseUrl", "https://api.eu.mistral.ai/v1");
    expect(cfg.semantic?.baseUrl).toBe("https://api.eu.mistral.ai/v1");
  });

  it("rejects a base URL that is not an http(s) URL", () => {
    expect(() => setConfigValue({}, "semantic.baseUrl", "not a url")).toThrow(
      /must be an http\(s\) URL/
    );
    expect(() => setConfigValue({}, "semantic.baseUrl", "ftp://example.com")).toThrow(
      /must be an http\(s\) URL/
    );
  });

  it("sets a tier provider, model, and base URL", () => {
    let cfg = setConfigValue({}, "semantic.tiers.small.provider", "mistral");
    cfg = setConfigValue(cfg, "semantic.tiers.small.model", "mistral-small-2603");
    cfg = setConfigValue(cfg, "semantic.tiers.large.model", "mistral-large-4");
    cfg = setConfigValue(cfg, "semantic.tiers.large.baseUrl", "https://api.eu.mistral.ai/v1");

    expect(cfg.semantic?.tiers).toEqual({
      small: { provider: "mistral", model: "mistral-small-2603" },
      large: { model: "mistral-large-4", baseUrl: "https://api.eu.mistral.ai/v1" },
    });
  });

  it("rejects an invalid tier provider and an empty tier model", () => {
    expect(() => setConfigValue({}, "semantic.tiers.small.provider", "llama")).toThrow(
      /Invalid provider 'llama' for semantic\.tiers\.small\.provider/
    );
    expect(() => setConfigValue({}, "semantic.tiers.large.model", "  ")).toThrow(
      /semantic\.tiers\.large\.model cannot be empty/
    );
  });

  it("sets a reasoning effort on the default provider and on a tier", () => {
    let cfg = setConfigValue({}, "semantic.reasoningEffort", "high");
    cfg = setConfigValue(cfg, "semantic.tiers.large.reasoningEffort", " none ");

    expect(cfg.semantic?.reasoningEffort).toBe("high");
    expect(cfg.semantic?.tiers?.large).toEqual({ reasoningEffort: "none" });
    expect(getConfigValue(cfg, "semantic.reasoningEffort")).toBe("high");
    expect(getConfigValue(cfg, "semantic.tiers.large.reasoningEffort")).toBe("none");

    const cleared = unsetConfigValue(
      unsetConfigValue(cfg, "semantic.tiers.large.reasoningEffort"),
      "semantic.reasoningEffort"
    );
    expect(cleared.semantic).toBeUndefined();
  });

  it("rejects an empty reasoning effort", () => {
    expect(() => setConfigValue({}, "semantic.reasoningEffort", "  ")).toThrow(
      /semantic\.reasoningEffort cannot be empty/
    );
    expect(() => setConfigValue({}, "semantic.tiers.small.reasoningEffort", "")).toThrow(
      /semantic\.tiers\.small\.reasoningEffort cannot be empty/
    );
  });

  it("accepts every provider name, including the new ones", () => {
    for (const name of SEMANTIC_PROVIDERS) {
      expect(setConfigValue({}, "semantic.provider", name).semantic?.provider).toBe(name);
    }
  });

  it("preserves the other tier when setting one", () => {
    const cfg = setConfigValue(
      { semantic: { tiers: { large: { model: "mistral-large-4" } } } },
      "semantic.tiers.small.model",
      "mistral-small-2603"
    );
    expect(cfg.semantic?.tiers?.large?.model).toBe("mistral-large-4");
    expect(cfg.semantic?.tiers?.small?.model).toBe("mistral-small-2603");
  });
});

describe("getConfigValue (tiers)", () => {
  it("reads a three-level key", () => {
    const cfg: BarrieretestConfig = {
      semantic: { tiers: { small: { model: "mistral-small-2603" } } },
    };
    expect(getConfigValue(cfg, "semantic.tiers.small.model")).toBe("mistral-small-2603");
    expect(getConfigValue(cfg, "semantic.tiers.small.provider")).toBeUndefined();
    expect(getConfigValue(cfg, "semantic.tiers.large.model")).toBeUndefined();
  });

  it("still returns the whole semantic object, tiers included", () => {
    const cfg: BarrieretestConfig = {
      semantic: { provider: "mistral", tiers: { small: { model: "mistral-small-2603" } } },
    };
    expect(getConfigValue(cfg, "semantic")).toEqual({
      provider: "mistral",
      tiers: { small: { model: "mistral-small-2603" } },
    });
  });
});

describe("unsetConfigValue", () => {
  it("removes a single key", () => {
    const cfg: BarrieretestConfig = {
      semantic: { provider: "nebius", model: "mini" },
    };
    const next = unsetConfigValue(cfg, "semantic.model");
    expect(next.semantic?.provider).toBe("nebius");
    expect(next.semantic?.model).toBeUndefined();
  });

  it("removes the semantic section if now empty", () => {
    const cfg: BarrieretestConfig = { semantic: { provider: "nebius" } };
    const next = unsetConfigValue(cfg, "semantic.provider");
    expect(next.semantic).toBeUndefined();
  });

  it("rejects unknown keys", () => {
    expect(() => unsetConfigValue({}, "nonsense.key")).toThrow(/Unknown config key/);
  });

  it("is a no-op when key was never set", () => {
    const cfg: BarrieretestConfig = {};
    expect(unsetConfigValue(cfg, "semantic.model")).toEqual({});
  });

  it("removes a tier leaf but keeps the rest of the tier", () => {
    const cfg: BarrieretestConfig = {
      semantic: { tiers: { small: { provider: "mistral", model: "mistral-small-2603" } } },
    };
    const next = unsetConfigValue(cfg, "semantic.tiers.small.model");
    expect(next.semantic?.tiers?.small).toEqual({ provider: "mistral" });
  });

  it("removes an emptied tier and then the tiers object", () => {
    const cfg: BarrieretestConfig = {
      semantic: { provider: "mistral", tiers: { small: { model: "mistral-small-2603" } } },
    };
    const next = unsetConfigValue(cfg, "semantic.tiers.small.model");
    expect(next.semantic?.tiers).toBeUndefined();
    expect(next.semantic?.provider).toBe("mistral");
  });

  it("removes the semantic section when the last tier leaf goes", () => {
    const cfg: BarrieretestConfig = {
      semantic: { tiers: { large: { model: "mistral-large-4" } } },
    };
    expect(unsetConfigValue(cfg, "semantic.tiers.large.model").semantic).toBeUndefined();
  });

  it("is a no-op for a tier that was never set", () => {
    const cfg: BarrieretestConfig = { semantic: { provider: "mistral" } };
    expect(unsetConfigValue(cfg, "semantic.tiers.small.model")).toEqual(cfg);
  });
});

describe("SUPPORTED_CONFIG_KEYS", () => {
  it("covers the documented semantic keys", () => {
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.provider");
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.model");
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.checks");
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.timeout");
  });

  it("covers the base URL, the reasoning effort, and both tiers", () => {
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.baseUrl");
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.reasoningEffort");
    for (const tier of ["small", "large"]) {
      for (const leaf of ["provider", "model", "baseUrl", "reasoningEffort"]) {
        expect(SUPPORTED_CONFIG_KEYS as readonly string[]).toContain(
          `semantic.tiers.${tier}.${leaf}`
        );
      }
    }
  });

  it("does not expose customChecks via config get/set (owned by `check` subcommand)", () => {
    expect(SUPPORTED_CONFIG_KEYS as readonly string[]).not.toContain("semantic.customChecks");
  });
});

// ---------------------------------------------------------------------------
// Project-local config discovery + merge
// ---------------------------------------------------------------------------

describe("findProjectConfigPath", () => {
  it("returns the file path when .barrieretest.json exists in cwd", () => {
    const filePath = join(TEST_DIR, PROJECT_CONFIG_FILENAME);
    writeFileSync(filePath, "{}");
    expect(findProjectConfigPath(TEST_DIR)).toBe(filePath);
  });

  it("walks up to find a project config in an ancestor directory", () => {
    const nested = join(TEST_DIR, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const filePath = join(TEST_DIR, PROJECT_CONFIG_FILENAME);
    writeFileSync(filePath, "{}");
    expect(findProjectConfigPath(nested)).toBe(filePath);
  });

  it("stops walking at a .git repo root and returns undefined when no config", () => {
    const repoRoot = join(TEST_DIR, "repo");
    const inside = join(repoRoot, "src");
    mkdirSync(inside, { recursive: true });
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    // Put a stray config ABOVE the repo — the walk must not escape to it.
    writeFileSync(join(TEST_DIR, PROJECT_CONFIG_FILENAME), "{}");
    expect(findProjectConfigPath(inside)).toBeUndefined();
  });

  it("returns undefined when no project config exists and walk hits filesystem root", () => {
    const dir = join(TEST_DIR, "empty", "nested");
    mkdirSync(dir, { recursive: true });
    expect(findProjectConfigPath(dir)).toBeUndefined();
  });
});

describe("findRepoRoot", () => {
  it("returns the nearest ancestor containing .git", () => {
    const repoRoot = join(TEST_DIR, "repo");
    const nested = join(repoRoot, "packages", "web");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    expect(findRepoRoot(nested)).toBe(repoRoot);
  });

  it("returns undefined when no .git is found on the way up", () => {
    const dir = join(TEST_DIR, "no-repo", "nested");
    mkdirSync(dir, { recursive: true });
    expect(findRepoRoot(dir)).toBeUndefined();
  });
});

describe("resolveProjectConfigWritePath", () => {
  it("targets the repo root when no config exists yet", () => {
    const repoRoot = join(TEST_DIR, "repo");
    const nested = join(repoRoot, "packages", "web");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    expect(resolveProjectConfigWritePath(nested)).toBe(join(repoRoot, PROJECT_CONFIG_FILENAME));
  });

  it("reuses an existing project config when one is found", () => {
    const repoRoot = join(TEST_DIR, "repo");
    const nested = join(repoRoot, "packages", "web");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const existing = join(repoRoot, PROJECT_CONFIG_FILENAME);
    writeFileSync(existing, "{}");
    expect(resolveProjectConfigWritePath(nested)).toBe(existing);
  });

  it("falls back to cwd when no repo and no existing config", () => {
    const dir = join(TEST_DIR, "loose");
    mkdirSync(dir, { recursive: true });
    expect(resolveProjectConfigWritePath(dir)).toBe(join(dir, PROJECT_CONFIG_FILENAME));
  });
});

describe("mergeConfigs", () => {
  const globalPath = "/tmp/global.json";
  const projectPath = "/tmp/project.json";

  it("project scalars win when set", () => {
    const result = mergeConfigs({
      global: { semantic: { provider: "nebius", model: "gpt-oss", timeout: 60_000 } },
      project: { semantic: { provider: "anthropic", timeout: 30_000 } },
      globalPath,
      projectPath,
    });
    expect(result.merged.semantic?.provider).toBe("anthropic");
    expect(result.merged.semantic?.model).toBe("gpt-oss");
    expect(result.merged.semantic?.timeout).toBe(30_000);
  });

  it("falls back to global scalars when project is empty", () => {
    const result = mergeConfigs({
      global: { semantic: { provider: "nebius", model: "gpt-oss" } },
      project: {},
      globalPath,
    });
    expect(result.merged.semantic?.provider).toBe("nebius");
    expect(result.merged.semantic?.model).toBe("gpt-oss");
  });

  it("project checks win over global checks when set", () => {
    const result = mergeConfigs({
      global: { semantic: { checks: ["aria-mismatch"] } },
      project: { semantic: { checks: ["page-title"] } },
      globalPath,
    });
    expect(result.merged.semantic?.checks).toEqual(["page-title"]);
  });

  it("concatenates customChecks and reports overridden IDs", () => {
    const result = mergeConfigs({
      global: {
        semantic: {
          customChecks: [
            { id: "a", title: "A", description: "d", prompt: "pa" },
            { id: "b", title: "B", description: "d", prompt: "pb" },
          ],
        },
      },
      project: {
        semantic: {
          customChecks: [
            { id: "b", title: "B prime", description: "d", prompt: "pb2" },
            { id: "c", title: "C", description: "d", prompt: "pc" },
          ],
        },
      },
      globalPath,
      projectPath,
    });
    const ids = result.merged.semantic?.customChecks?.map((c) => c.id);
    expect(ids).toEqual(["a", "b", "c"]);
    const b = result.merged.semantic?.customChecks?.find((c) => c.id === "b");
    expect(b?.title).toBe("B prime");
    expect(result.overriddenCustomCheckIds).toEqual(["b"]);
  });

  it("project baseUrl wins over global", () => {
    const result = mergeConfigs({
      global: { semantic: { baseUrl: "https://api.mistral.ai/v1" } },
      project: { semantic: { baseUrl: "https://api.eu.mistral.ai/v1" } },
      globalPath,
      projectPath,
    });
    expect(result.merged.semantic?.baseUrl).toBe("https://api.eu.mistral.ai/v1");
  });

  it("project reasoningEffort wins over global, as scalar and as tier leaf", () => {
    const result = mergeConfigs({
      global: {
        semantic: { reasoningEffort: "none", tiers: { large: { reasoningEffort: "none" } } },
      },
      project: {
        semantic: { reasoningEffort: "high", tiers: { large: { model: "mistral-large-4" } } },
      },
      globalPath,
      projectPath,
    });
    expect(result.merged.semantic?.reasoningEffort).toBe("high");
    expect(result.merged.semantic?.tiers?.large).toEqual({
      model: "mistral-large-4",
      reasoningEffort: "none",
    });
  });

  it("merges tiers leaf by leaf, project over global", () => {
    const result = mergeConfigs({
      global: {
        semantic: {
          tiers: {
            small: { provider: "mistral", model: "mistral-small-2603" },
            large: { model: "mistral-large-4" },
          },
        },
      },
      project: { semantic: { tiers: { small: { model: "ministral-8b" } } } },
      globalPath,
      projectPath,
    });
    expect(result.merged.semantic?.tiers).toEqual({
      small: { provider: "mistral", model: "ministral-8b" },
      large: { model: "mistral-large-4" },
    });
  });

  it("keeps a project-only tier when global has none", () => {
    const result = mergeConfigs({
      global: { semantic: { provider: "mistral" } },
      project: { semantic: { tiers: { small: { model: "mistral-small-2603" } } } },
      globalPath,
      projectPath,
    });
    expect(result.merged.semantic?.tiers).toEqual({ small: { model: "mistral-small-2603" } });
  });

  it("omits tiers when neither side sets one", () => {
    const result = mergeConfigs({
      global: { semantic: { provider: "mistral" } },
      project: {},
      globalPath,
    });
    expect(result.merged.semantic?.tiers).toBeUndefined();
  });

  it("returns an empty semantic block when neither side sets anything", () => {
    const result = mergeConfigs({ global: {}, project: {}, globalPath });
    expect(result.merged).toEqual({});
    expect(result.overriddenCustomCheckIds).toEqual([]);
  });
});

describe("loadMergedConfig", () => {
  it("merges global + project files from disk", () => {
    const globalPath = join(TEST_DIR, "global-config.json");
    writeFileSync(
      globalPath,
      JSON.stringify({ semantic: { provider: "nebius", timeout: 60_000 } })
    );
    const projectPath = join(TEST_DIR, PROJECT_CONFIG_FILENAME);
    writeFileSync(projectPath, JSON.stringify({ semantic: { timeout: 30_000 } }));

    const result = loadMergedConfig(TEST_DIR, globalPath);
    expect(result.merged.semantic?.provider).toBe("nebius");
    expect(result.merged.semantic?.timeout).toBe(30_000);
    expect(result.projectPath).toBe(projectPath);
    expect(result.globalPath).toBe(globalPath);
  });

  it("works when only a global file exists", () => {
    const globalPath = join(TEST_DIR, "global-only.json");
    writeFileSync(globalPath, JSON.stringify({ semantic: { provider: "openai" } }));
    const result = loadMergedConfig(TEST_DIR, globalPath);
    expect(result.merged.semantic?.provider).toBe("openai");
    expect(result.projectPath).toBeUndefined();
  });
});
