import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BarrieretestConfig,
  getConfigPath,
  getConfigValue,
  readConfig,
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
});

describe("SUPPORTED_CONFIG_KEYS", () => {
  it("covers the documented semantic keys", () => {
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.provider");
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.model");
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.checks");
    expect(SUPPORTED_CONFIG_KEYS).toContain("semantic.timeout");
  });
});
