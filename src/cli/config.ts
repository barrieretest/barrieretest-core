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
import type { AIProviderName } from "../ai/types.js";
import type { SemanticModelTier, UserCheckConfig } from "../semantic/types.js";
import { SEMANTIC_MODEL_TIERS } from "../semantic/types.js";

export type SemanticProviderName = AIProviderName;

export const SEMANTIC_PROVIDERS: readonly SemanticProviderName[] = [
  "mistral",
  "openai",
  "anthropic",
  "openai-compatible",
  "nebius",
];

/**
 * Per-tier overrides. An omitted field inherits from the `semantic` defaults
 * — `resolveSemanticOptions` does that completion.
 */
export interface SemanticTierConfig {
  provider?: SemanticProviderName;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: string;
}

export interface SemanticConfig {
  provider?: SemanticProviderName;
  model?: string;
  /** Required for `openai-compatible`; an endpoint override for the others. */
  baseUrl?: string;
  /** Passed verbatim to the provider; documented values `"none"` and `"high"`. */
  reasoningEffort?: string;
  tiers?: {
    small?: SemanticTierConfig;
    large?: SemanticTierConfig;
  };
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
  "semantic.baseUrl",
  "semantic.reasoningEffort",
  "semantic.checks",
  "semantic.timeout",
  "semantic.tiers.small.provider",
  "semantic.tiers.small.model",
  "semantic.tiers.small.baseUrl",
  "semantic.tiers.small.reasoningEffort",
  "semantic.tiers.large.provider",
  "semantic.tiers.large.model",
  "semantic.tiers.large.baseUrl",
  "semantic.tiers.large.reasoningEffort",
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
  assertTiersShape(parsed, configPath);

  return parsed as BarrieretestConfig;
}

function assertCustomChecksShape(parsed: unknown, configPath: string): void {
  const semantic = semanticSection(parsed);
  if (!semantic) return;
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

function assertTiersShape(parsed: unknown, configPath: string): void {
  const semantic = semanticSection(parsed);
  if (!semantic) return;
  const tiers = (semantic as { tiers?: unknown }).tiers;
  if (tiers === undefined) return;
  if (!isPlainObject(tiers)) {
    throw new Error(
      `Invalid config at ${configPath}: semantic.tiers must be an object with optional 'small' and 'large' keys.`
    );
  }
  for (const tier of SEMANTIC_MODEL_TIERS) {
    const entry = (tiers as Record<string, unknown>)[tier];
    if (entry === undefined) continue;
    if (!isPlainObject(entry)) {
      throw new Error(`Invalid config at ${configPath}: semantic.tiers.${tier} must be an object.`);
    }
  }
}

function semanticSection(parsed: unknown): object | undefined {
  const semantic = (parsed as { semantic?: unknown }).semantic;
  return isPlainObject(semantic) ? semantic : undefined;
}

function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const tierPath = parseTierKey(key);
  if (tierPath) {
    return config.semantic?.tiers?.[tierPath.tier]?.[tierPath.leaf];
  }

  const subkey = key.split(".")[1] as keyof SemanticConfig;
  return config.semantic?.[subkey];
}

export function setConfigValue(
  config: BarrieretestConfig,
  key: string,
  rawValue: string
): BarrieretestConfig {
  assertSupportedKey(key);

  const next: BarrieretestConfig = { ...config, semantic: { ...(config.semantic ?? {}) } };
  const semantic = next.semantic as SemanticConfig;

  const tierPath = parseTierKey(key);
  if (tierPath) {
    const { tier, leaf } = tierPath;
    const tiers = { ...(semantic.tiers ?? {}) };
    const tierConfig: SemanticTierConfig = { ...(tiers[tier] ?? {}) };
    if (leaf === "provider") {
      tierConfig.provider = parseProviderValue(key, rawValue);
    } else if (leaf === "model") {
      tierConfig.model = parseModelValue(key, rawValue);
    } else if (leaf === "baseUrl") {
      tierConfig.baseUrl = parseBaseUrlValue(key, rawValue);
    } else {
      tierConfig.reasoningEffort = parseReasoningEffortValue(key, rawValue);
    }
    tiers[tier] = tierConfig;
    semantic.tiers = tiers;
    return next;
  }

  const subkey = key.split(".")[1] as keyof SemanticConfig;

  switch (subkey) {
    case "provider":
      semantic.provider = parseProviderValue(key, rawValue);
      break;

    case "model":
      semantic.model = parseModelValue(key, rawValue);
      break;

    case "baseUrl":
      semantic.baseUrl = parseBaseUrlValue(key, rawValue);
      break;

    case "reasoningEffort":
      semantic.reasoningEffort = parseReasoningEffortValue(key, rawValue);
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

  const semantic: SemanticConfig = { ...config.semantic };

  const tierPath = parseTierKey(key);
  if (tierPath) {
    const { tier, leaf } = tierPath;
    const existingTier = semantic.tiers?.[tier];
    if (!existingTier) return config;

    const tierConfig: SemanticTierConfig = { ...existingTier };
    delete tierConfig[leaf];

    const tiers = { ...semantic.tiers };
    if (Object.keys(tierConfig).length === 0) {
      delete tiers[tier];
    } else {
      tiers[tier] = tierConfig;
    }

    if (Object.keys(tiers).length === 0) {
      delete semantic.tiers;
    } else {
      semantic.tiers = tiers;
    }
  } else {
    const subkey = key.split(".")[1] as keyof SemanticConfig;
    delete semantic[subkey];
  }

  const next: BarrieretestConfig = { ...config };
  if (Object.keys(semantic).length === 0) {
    delete next.semantic;
  } else {
    next.semantic = semantic;
  }
  return next;
}

/** Leaf fields a `semantic.tiers.<tier>.<leaf>` key can address. */
type TierLeaf = keyof SemanticTierConfig;

/**
 * Split a three-level `semantic.tiers.<tier>.<leaf>` key. Returns undefined
 * for the two-level keys, which the callers handle directly — one small
 * helper beats a generic deep-path accessor for a known key list.
 */
function parseTierKey(key: string): { tier: SemanticModelTier; leaf: TierLeaf } | undefined {
  const parts = key.split(".");
  if (parts.length !== 4 || parts[0] !== "semantic" || parts[1] !== "tiers") {
    return undefined;
  }
  return { tier: parts[2] as SemanticModelTier, leaf: parts[3] as TierLeaf };
}

function parseProviderValue(key: string, rawValue: string): SemanticProviderName {
  if (!(SEMANTIC_PROVIDERS as readonly string[]).includes(rawValue)) {
    throw new Error(
      `Invalid provider '${rawValue}' for ${key}. Must be one of: ${SEMANTIC_PROVIDERS.join(", ")}`
    );
  }
  return rawValue as SemanticProviderName;
}

/**
 * Shared with `resolveSemanticOptions`, which applies the same rules to
 * hand-edited config and CLI flags. `key` is whatever names the value to the
 * user: a config key, a flag, or an env var.
 *
 * A hand-edited config can hold any JSON type here, so the string check is a
 * runtime one despite the signature.
 */
export function parseModelValue(key: string, rawValue: string): string {
  assertStringValue(key, rawValue);
  if (!rawValue.trim()) {
    throw new Error(`${key} cannot be empty`);
  }
  return rawValue;
}

/**
 * Accepted values differ per vendor (Mistral takes "none" and "high", OpenAI
 * has its own ladder), so only the shape is checked here and the value is
 * passed through. See `parseModelValue` for the `key` convention.
 */
export function parseReasoningEffortValue(key: string, rawValue: string): string {
  assertStringValue(key, rawValue);
  const value = rawValue.trim();
  if (!value) {
    throw new Error(`${key} cannot be empty`);
  }
  return value;
}

/** See `parseModelValue` for the `key` convention. */
export function parseBaseUrlValue(key: string, rawValue: string): string {
  assertStringValue(key, rawValue);
  const value = rawValue.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${key} '${rawValue}': must be an http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${key} '${rawValue}': must be an http(s) URL`);
  }
  return value;
}

function assertStringValue(key: string, rawValue: unknown): asserts rawValue is string {
  if (typeof rawValue !== "string") {
    throw new Error(`Invalid ${key}: must be a string`);
  }
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
 * `tiers.<tier>.<leaf>`: project wins per leaf, so a project can retarget one
 * tier's model without restating the provider.
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
  const baseUrl = ps.baseUrl ?? gs.baseUrl;
  if (baseUrl !== undefined) mergedSemantic.baseUrl = baseUrl;
  const reasoningEffort = ps.reasoningEffort ?? gs.reasoningEffort;
  if (reasoningEffort !== undefined) mergedSemantic.reasoningEffort = reasoningEffort;
  const tiers = mergeTiers(gs.tiers, ps.tiers);
  if (tiers !== undefined) mergedSemantic.tiers = tiers;
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

/**
 * Merge the per-tier overrides leaf by leaf so a project config can retarget
 * a single field. A tier that ends up empty is dropped entirely.
 */
function mergeTiers(
  global: SemanticConfig["tiers"],
  project: SemanticConfig["tiers"]
): SemanticConfig["tiers"] | undefined {
  if (!global && !project) return undefined;

  const merged: NonNullable<SemanticConfig["tiers"]> = {};
  for (const tier of SEMANTIC_MODEL_TIERS) {
    const g = global?.[tier] ?? {};
    const p = project?.[tier] ?? {};
    const tierConfig: SemanticTierConfig = {};
    const provider = p.provider ?? g.provider;
    if (provider !== undefined) tierConfig.provider = provider;
    const model = p.model ?? g.model;
    if (model !== undefined) tierConfig.model = model;
    const baseUrl = p.baseUrl ?? g.baseUrl;
    if (baseUrl !== undefined) tierConfig.baseUrl = baseUrl;
    const reasoningEffort = p.reasoningEffort ?? g.reasoningEffort;
    if (reasoningEffort !== undefined) tierConfig.reasoningEffort = reasoningEffort;
    if (Object.keys(tierConfig).length > 0) merged[tier] = tierConfig;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}
