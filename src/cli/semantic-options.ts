/**
 * Resolves CLI flags + user config + environment variables into the
 * `SemanticOptions` shape that `audit()` expects.
 *
 * Resolution order for each field: CLI flag > config default > env inference.
 * API keys are only read from env — never from config or CLI.
 */

import { BUILT_IN_CHECK_IDS, userCheckConfigToSemanticCheck } from "../semantic/checks/index.js";
import type {
  SemanticCheck,
  SemanticModelTier,
  SemanticOptions,
  SemanticProviderConfig,
} from "../semantic/types.js";
import { SEMANTIC_MODEL_TIERS } from "../semantic/types.js";
import type { AuditEngine } from "../types.js";
import type { BarrieretestConfig, SemanticProviderName, SemanticTierConfig } from "./config.js";
import {
  parseBaseUrlValue,
  parseModelValue,
  parseReasoningEffortValue,
  SEMANTIC_PROVIDERS,
} from "./config.js";

export const SEMANTIC_ENV_VAR_BY_PROVIDER: Record<SemanticProviderName, string> = {
  mistral: "MISTRAL_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
  nebius: "NEBIUS_API_KEY",
};

/** Base URL fallback for the one provider that cannot default it. */
export const SEMANTIC_BASE_URL_ENV_VAR = "OPENAI_COMPATIBLE_BASE_URL";

export interface SemanticResolutionInput {
  /** Explicit `--semantic` flag. */
  semantic?: boolean;
  /** `--semantic-provider <name>` override. */
  semanticProvider?: string;
  /** `--semantic-model <id>` override. */
  semanticModel?: string;
  /** `--semantic-base-url <url>` override. */
  semanticBaseUrl?: string;
  /** `--semantic-small-provider <name>` override. */
  semanticSmallProvider?: string;
  /** `--semantic-small-model <id>` override. */
  semanticSmallModel?: string;
  /** `--semantic-large-provider <name>` override. */
  semanticLargeProvider?: string;
  /** `--semantic-large-model <id>` override. */
  semanticLargeModel?: string;
  /** `--semantic-checks a,b,c` parsed list. */
  semanticChecks?: string[];
  /** `--semantic-timeout <ms>` override. */
  semanticTimeout?: number;
  /** Selected audit engine — required for the pa11y combo check. */
  engine?: AuditEngine;
  /** User config (defaults; never holds secrets). */
  config: BarrieretestConfig;
  /** Process environment (pass `process.env` directly). */
  env: Record<string, string | undefined>;
  /** Known check IDs; defaults to built-ins. Override for tests. */
  knownCheckIds?: readonly string[];
}

/**
 * True when any semantic-related CLI flag is present. Used to decide whether
 * semantic mode should be activated, since `--semantic-*` flags implicitly
 * enable semantic without requiring a separate `--semantic` flag.
 *
 * Presence, not truthiness: an empty flag value is an explicit request with
 * an invalid value, and must reach the validators rather than turn semantic
 * mode off.
 */
export function semanticRequested(input: SemanticResolutionInput): boolean {
  return (
    input.semantic === true ||
    input.semanticProvider !== undefined ||
    input.semanticModel !== undefined ||
    input.semanticBaseUrl !== undefined ||
    input.semanticSmallProvider !== undefined ||
    input.semanticSmallModel !== undefined ||
    input.semanticLargeProvider !== undefined ||
    input.semanticLargeModel !== undefined ||
    input.semanticChecks !== undefined ||
    input.semanticTimeout !== undefined
  );
}

/**
 * Turn CLI + config + env into a ready-to-pass `SemanticOptions`, or
 * `undefined` when semantic mode was not requested.
 *
 * Throws a user-facing `Error` when the request is ambiguous or impossible
 * (missing API key, missing base URL, invalid provider, `pa11y + semantic`,
 * unknown check IDs).
 */
export function resolveSemanticOptions(
  input: SemanticResolutionInput
): SemanticOptions | undefined {
  if (!semanticRequested(input)) {
    return undefined;
  }

  if (input.engine === "pa11y") {
    throw new Error(
      "--semantic is not supported with --engine pa11y in this release. " +
        "Use the default axe engine or drop --semantic."
    );
  }

  const configSemantic = input.config.semantic ?? {};

  const customChecks: SemanticCheck[] = (configSemantic.customChecks ?? []).map(
    userCheckConfigToSemanticCheck
  );

  const baseKnownIds = input.knownCheckIds ?? BUILT_IN_CHECK_IDS;
  const knownCheckIds = [...baseKnownIds, ...customChecks.map((c) => c.id)];

  const provider = resolveProvider(input, configSemantic.provider);
  const apiKey = requireApiKey(provider, input.env);

  if (input.semanticChecks !== undefined && input.semanticChecks.length === 0) {
    throw new Error("--semantic-checks cannot be empty");
  }

  const checks = input.semanticChecks ?? configSemantic.checks;
  if (checks && checks.length > 0) {
    const unknown = checks.filter((id) => !knownCheckIds.includes(id));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown semantic check id(s): ${unknown.join(", ")}. ` +
          `Known: ${knownCheckIds.join(", ")}`
      );
    }
  }

  const timeout = input.semanticTimeout ?? configSemantic.timeout;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error(`Invalid semantic timeout '${timeout}': must be a positive integer`);
  }

  const model =
    checkedModel(input.semanticModel, "--semantic-model") ??
    checkedModel(configSemantic.model, "semantic.model");
  const explicitBaseUrl =
    checkedBaseUrl(input.semanticBaseUrl, "--semantic-base-url") ??
    checkedBaseUrl(configSemantic.baseUrl, "semantic.baseUrl");
  const baseUrl = resolveBaseUrl(provider, explicitBaseUrl, input);
  const reasoningEffort = checkedReasoningEffort(
    configSemantic.reasoningEffort,
    "semantic.reasoningEffort"
  );

  requireEndpoint({ provider, model, baseUrl });

  const defaultProviderConfig: SemanticProviderConfig = {
    name: provider,
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };

  const tiers = resolveTiers(input, configSemantic.tiers, defaultProviderConfig);

  const options: SemanticOptions = {
    provider: defaultProviderConfig,
    ...(tiers ? { tiers } : {}),
    ...(checks && checks.length > 0 ? { checks } : {}),
    ...(customChecks.length > 0 ? { customChecks } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };

  return options;
}

function resolveProvider(
  input: SemanticResolutionInput,
  configProvider: SemanticProviderName | undefined
): SemanticProviderName {
  if (input.semanticProvider !== undefined) {
    return assertProvider(input.semanticProvider, "--semantic-provider");
  }
  if (configProvider !== undefined) {
    return assertProvider(configProvider, "semantic.provider");
  }

  const present = SEMANTIC_PROVIDERS.filter(
    (name) => !!input.env[SEMANTIC_ENV_VAR_BY_PROVIDER[name]]
  );

  if (present.length === 1) {
    return present[0];
  }

  if (present.length === 0) {
    throw new Error(
      "No semantic provider selected and no provider API key found in env. " +
        `Set one of: ${Object.values(SEMANTIC_ENV_VAR_BY_PROVIDER).join(", ")}, ` +
        "pass --semantic-provider, or run " +
        "'barrieretest config set semantic.provider <name>'."
    );
  }

  const keys = present.map((p) => SEMANTIC_ENV_VAR_BY_PROVIDER[p]).join(", ");
  throw new Error(
    `Multiple semantic provider API keys found in env (${keys}). ` +
      "Pick one with --semantic-provider or 'barrieretest config set semantic.provider <name>'."
  );
}

function assertProvider(name: string, source: string): SemanticProviderName {
  if (typeof name !== "string") {
    throw new Error(`Invalid ${source}: must be a string`);
  }
  if (!(SEMANTIC_PROVIDERS as readonly string[]).includes(name)) {
    throw new Error(
      `Invalid semantic provider '${name}' for ${source}. ` +
        `Must be one of: ${SEMANTIC_PROVIDERS.join(", ")}`
    );
  }
  return name as SemanticProviderName;
}

/**
 * Hand-edited config and CLI flags bypass the validation `config set` does,
 * so every model and base URL is checked here with the same rules. `source`
 * names the value to the user: a config key, a flag, or an env var.
 */
function checkedModel(value: string | undefined, source: string): string | undefined {
  return value === undefined ? undefined : parseModelValue(source, value);
}

function checkedBaseUrl(value: string | undefined, source: string): string | undefined {
  return value === undefined ? undefined : parseBaseUrlValue(source, value);
}

function checkedReasoningEffort(value: string | undefined, source: string): string | undefined {
  return value === undefined ? undefined : parseReasoningEffortValue(source, value);
}

function requireApiKey(
  provider: SemanticProviderName,
  env: Record<string, string | undefined>
): string {
  const envVar = SEMANTIC_ENV_VAR_BY_PROVIDER[provider];
  const apiKey = env[envVar];
  if (!apiKey) {
    throw new Error(
      `Semantic provider '${provider}' selected but ${envVar} is not set in the environment.`
    );
  }
  return apiKey;
}

/**
 * `openai-compatible` has no endpoint to default to, so the env var is the
 * last resort before the loud failure in `requireEndpoint`.
 */
function resolveBaseUrl(
  provider: SemanticProviderName,
  explicit: string | undefined,
  input: SemanticResolutionInput
): string | undefined {
  if (explicit) return explicit;
  if (provider === "openai-compatible") {
    const fromEnv = input.env[SEMANTIC_BASE_URL_ENV_VAR];
    return fromEnv ? checkedBaseUrl(fromEnv, SEMANTIC_BASE_URL_ENV_VAR) : undefined;
  }
  return undefined;
}

/**
 * A generic OpenAI-compatible endpoint needs both an address and a model
 * name — neither can be guessed, so say which input is missing.
 */
function requireEndpoint(args: {
  provider: SemanticProviderName;
  model: string | undefined;
  baseUrl: string | undefined;
  tier?: SemanticModelTier;
}): void {
  const { provider, model, baseUrl, tier } = args;
  if (provider !== "openai-compatible") return;

  const where = tier ? `for the ${tier} tier ` : "";
  const flagSuffix = tier ? `--semantic-${tier}-` : "--semantic-";
  const configPrefix = tier ? `semantic.tiers.${tier}` : "semantic";

  if (!baseUrl) {
    // `--semantic-base-url` only feeds the default provider, so a tier that
    // reaches this has its own provider and needs its own address.
    const how = tier
      ? `Set ${configPrefix}.baseUrl or export ${SEMANTIC_BASE_URL_ENV_VAR}.`
      : `Pass --semantic-base-url, set ${configPrefix}.baseUrl, or export ${SEMANTIC_BASE_URL_ENV_VAR}.`;
    throw new Error(`Semantic provider 'openai-compatible' ${where}requires a base URL. ${how}`);
  }
  if (!model) {
    throw new Error(
      `Semantic provider 'openai-compatible' ${where}requires a model. ` +
        `Pass ${flagSuffix}model or set ${configPrefix}.model.`
    );
  }
}

/**
 * Complete the per-tier overrides into full provider configs. Only tiers the
 * user actually addressed get an entry; the rest fall back to the default
 * provider inside the runner.
 *
 * A tier that stays on the default provider inherits its model and base URL;
 * a tier that switches provider starts from that provider's own defaults,
 * since a model id is not portable between providers.
 */
function resolveTiers(
  input: SemanticResolutionInput,
  configTiers: { small?: SemanticTierConfig; large?: SemanticTierConfig } | undefined,
  defaults: SemanticProviderConfig
): Partial<Record<SemanticModelTier, SemanticProviderConfig>> | undefined {
  const resolved: Partial<Record<SemanticModelTier, SemanticProviderConfig>> = {};

  for (const tier of SEMANTIC_MODEL_TIERS) {
    const providerFlag =
      tier === "small" ? input.semanticSmallProvider : input.semanticLargeProvider;
    const modelFlag = tier === "small" ? input.semanticSmallModel : input.semanticLargeModel;
    const tierConfig = configTiers?.[tier];
    const hasConfig = Boolean(tierConfig && Object.keys(tierConfig).length > 0);

    if (providerFlag === undefined && modelFlag === undefined && !hasConfig) continue;

    let provider = defaults.name;
    if (providerFlag !== undefined) {
      provider = assertProvider(providerFlag, `--semantic-${tier}-provider`);
    } else if (tierConfig?.provider !== undefined) {
      provider = assertProvider(tierConfig.provider, `semantic.tiers.${tier}.provider`);
    }
    const inheritsDefaults = provider === defaults.name;

    const model =
      checkedModel(modelFlag, `--semantic-${tier}-model`) ??
      checkedModel(tierConfig?.model, `semantic.tiers.${tier}.model`) ??
      (inheritsDefaults ? defaults.model : undefined);
    const configuredBaseUrl =
      checkedBaseUrl(tierConfig?.baseUrl, `semantic.tiers.${tier}.baseUrl`) ??
      (inheritsDefaults ? defaults.baseUrl : undefined);
    const baseUrl = resolveBaseUrl(provider, configuredBaseUrl, input);
    const reasoningEffort =
      checkedReasoningEffort(
        tierConfig?.reasoningEffort,
        `semantic.tiers.${tier}.reasoningEffort`
      ) ?? (inheritsDefaults ? defaults.reasoningEffort : undefined);

    requireEndpoint({ provider, model, baseUrl, tier });

    resolved[tier] = {
      name: provider,
      apiKey: requireApiKey(provider, input.env),
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
