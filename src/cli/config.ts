/**
 * User-level CLI config file for `barrieretest`.
 *
 * Stores non-secret defaults at `~/.barrieretest/config.json`. API keys live
 * only in environment variables — see `resolveSemanticOptions` for the
 * env-var lookup rules. Writing secrets here is intentionally not supported.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SemanticProviderName = "nebius" | "openai" | "anthropic";

export const SEMANTIC_PROVIDERS: readonly SemanticProviderName[] = [
  "nebius",
  "openai",
  "anthropic",
];

export interface SemanticConfig {
  provider?: SemanticProviderName;
  model?: string;
  checks?: string[];
  timeout?: number;
}

export interface BarrieretestConfig {
  semantic?: SemanticConfig;
}

export const SUPPORTED_CONFIG_KEYS = [
  "semantic.provider",
  "semantic.model",
  "semantic.checks",
  "semantic.timeout",
] as const;

export type SupportedConfigKey = (typeof SUPPORTED_CONFIG_KEYS)[number];

export function isSupportedConfigKey(key: string): key is SupportedConfigKey {
  return (SUPPORTED_CONFIG_KEYS as readonly string[]).includes(key);
}

export function getConfigPath(): string {
  return join(homedir(), ".barrieretest", "config.json");
}

export function readConfig(configPath: string = getConfigPath()): BarrieretestConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as BarrieretestConfig;
  } catch {
    return {};
  }
}

export function writeConfig(
  config: BarrieretestConfig,
  configPath: string = getConfigPath()
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function getConfigValue(config: BarrieretestConfig, key: string): unknown {
  if (key === "semantic") {
    return config.semantic;
  }
  assertSupportedKey(key);
  const subkey = key.split(".")[1] as keyof SemanticConfig;
  return config.semantic?.[subkey];
}

export function setConfigValue(
  config: BarrieretestConfig,
  key: string,
  rawValue: string
): BarrieretestConfig {
  assertSupportedKey(key);
  const subkey = key.split(".")[1] as keyof SemanticConfig;

  const next: BarrieretestConfig = { ...config, semantic: { ...(config.semantic ?? {}) } };
  const semantic = next.semantic as SemanticConfig;

  switch (subkey) {
    case "provider":
      if (!(SEMANTIC_PROVIDERS as readonly string[]).includes(rawValue)) {
        throw new Error(
          `Invalid provider '${rawValue}'. Must be one of: ${SEMANTIC_PROVIDERS.join(", ")}`
        );
      }
      semantic.provider = rawValue as SemanticProviderName;
      break;

    case "model":
      if (!rawValue.trim()) {
        throw new Error("semantic.model cannot be empty");
      }
      semantic.model = rawValue;
      break;

    case "checks": {
      const parsed = rawValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parsed.length === 0) {
        throw new Error("semantic.checks cannot be empty");
      }
      semantic.checks = parsed;
      break;
    }

    case "timeout": {
      const n = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid semantic.timeout '${rawValue}': must be a positive integer`);
      }
      semantic.timeout = n;
      break;
    }
  }

  return next;
}

export function unsetConfigValue(config: BarrieretestConfig, key: string): BarrieretestConfig {
  assertSupportedKey(key);
  if (!config.semantic) return config;

  const subkey = key.split(".")[1] as keyof SemanticConfig;
  const semantic: SemanticConfig = { ...config.semantic };
  delete semantic[subkey];

  const next: BarrieretestConfig = { ...config };
  if (Object.keys(semantic).length === 0) {
    delete next.semantic;
  } else {
    next.semantic = semantic;
  }
  return next;
}

function assertSupportedKey(key: string): asserts key is SupportedConfigKey {
  if (!isSupportedConfigKey(key)) {
    throw new Error(`Unknown config key '${key}'. Known keys: ${SUPPORTED_CONFIG_KEYS.join(", ")}`);
  }
}
