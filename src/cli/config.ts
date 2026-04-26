/**
 * User-level CLI config file for `barrieretest`.
 *
 * Stores non-secret defaults at `~/.barrieretest/config.json`. API keys live
 * only in environment variables — see `resolveSemanticOptions` for the
 * env-var lookup rules. Writing secrets here is intentionally not supported.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import type { UserCheckConfig } from "../semantic/types.js";

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
  /**
   * User-authored semantic checks. Not exposed via `config get/set/unset`
   * — the `barrieretest check` subcommand owns edits to this array.
   */
  customChecks?: UserCheckConfig[];
}

export interface BarrieretestConfig {
  semantic?: SemanticConfig;
}

/** Filename for project-local config, discovered by walking up from cwd. */
export const PROJECT_CONFIG_FILENAME = ".barrieretest.json";

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

  let parsed: unknown;
  try {
    const content = readFileSync(configPath, "utf8");
    parsed = JSON.parse(content);
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  // Defensively validate structural assumptions the rest of the CLI
  // relies on — bad shapes here come from hand-edited JSON, so we want
  // a message that names the field and the file.
  assertCustomChecksShape(parsed, configPath);

  return parsed as BarrieretestConfig;
}

function assertCustomChecksShape(parsed: unknown, configPath: string): void {
  const semantic = (parsed as { semantic?: unknown }).semantic;
  if (!semantic || typeof semantic !== "object" || Array.isArray(semantic)) return;
  const raw = (semantic as { customChecks?: unknown }).customChecks;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid config at ${configPath}: semantic.customChecks must be an array of check objects.`
    );
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Invalid config at ${configPath}: semantic.customChecks[${i}] must be an object.`
      );
    }
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

/**
 * Walk up from `cwd` looking for a project-local `.barrieretest.json`.
 * Stops at the first match, at a `.git` directory (repo root), or at the
 * filesystem root. Returns `undefined` when no file is found.
 */
export function findProjectConfigPath(cwd: string): string | undefined {
  let dir = cwd;
  const { root } = parsePath(dir);
  while (true) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return undefined;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Walk up from `cwd` looking for a repo root (nearest ancestor containing
 * `.git`). Returns `undefined` when no repo root is found — callers fall
 * back to `cwd` in that case.
 */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = cwd;
  const { root } = parsePath(dir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Where a new project-local config should be written for `cwd`. If an
 * existing config is discovered, we reuse it. Otherwise the repo root
 * (`.git` boundary) wins; if even that's missing, we fall back to cwd.
 */
export function resolveProjectConfigWritePath(cwd: string): string {
  return findProjectConfigPath(cwd) ?? join(findRepoRoot(cwd) ?? cwd, PROJECT_CONFIG_FILENAME);
}

export function readProjectConfig(configPath: string): BarrieretestConfig {
  return readConfig(configPath);
}

export function writeProjectConfig(config: BarrieretestConfig, configPath: string): void {
  writeConfig(config, configPath);
}

export interface MergedConfig {
  merged: BarrieretestConfig;
  globalPath: string;
  projectPath?: string;
  /** IDs of custom checks whose global definition was overridden by the project config. */
  overriddenCustomCheckIds: string[];
}

/**
 * Load global + project config and merge them with the CLI's precedence
 * rules. Global lives at `~/.barrieretest/config.json`, project at the
 * nearest `.barrieretest.json` walking up from `cwd`.
 *
 * Scalars: project wins when set.
 * `checks` (selected subset): project wins when set.
 * `customChecks`: concatenated; project entries override global entries
 * with the same id. Caller decides what to do about
 * `overriddenCustomCheckIds` (e.g. warn on stderr).
 */
export function loadMergedConfig(cwd: string, globalPathOverride?: string): MergedConfig {
  const globalPath = globalPathOverride ?? getConfigPath();
  const global = readConfig(globalPath);
  const projectPath = findProjectConfigPath(cwd);
  const project = projectPath ? readProjectConfig(projectPath) : {};
  return mergeConfigs({ global, project, globalPath, projectPath });
}

/**
 * Pure merger, exposed for tests.
 */
export function mergeConfigs(args: {
  global: BarrieretestConfig;
  project: BarrieretestConfig;
  globalPath: string;
  projectPath?: string;
}): MergedConfig {
  const { global, project, globalPath, projectPath } = args;
  const gs = global.semantic ?? {};
  const ps = project.semantic ?? {};

  const globalChecks = gs.customChecks ?? [];
  const projectChecks = ps.customChecks ?? [];
  const byId = new Map<string, UserCheckConfig>();
  const overridden: string[] = [];
  for (const c of globalChecks) byId.set(c.id, c);
  for (const c of projectChecks) {
    if (byId.has(c.id)) overridden.push(c.id);
    byId.set(c.id, c);
  }

  const mergedSemantic: SemanticConfig = {};
  const provider = ps.provider ?? gs.provider;
  if (provider !== undefined) mergedSemantic.provider = provider;
  const model = ps.model ?? gs.model;
  if (model !== undefined) mergedSemantic.model = model;
  const timeout = ps.timeout ?? gs.timeout;
  if (timeout !== undefined) mergedSemantic.timeout = timeout;
  const checks = ps.checks ?? gs.checks;
  if (checks !== undefined) mergedSemantic.checks = checks;
  if (byId.size > 0) mergedSemantic.customChecks = Array.from(byId.values());

  const merged: BarrieretestConfig =
    Object.keys(mergedSemantic).length > 0 ? { semantic: mergedSemantic } : {};

  return {
    merged,
    globalPath,
    ...(projectPath ? { projectPath } : {}),
    overriddenCustomCheckIds: overridden,
  };
}
