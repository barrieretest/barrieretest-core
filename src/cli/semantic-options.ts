/**
 * Resolves CLI flags + user config + environment variables into the
 * `SemanticOptions` shape that `audit()` expects.
 *
 * Resolution order for each field: CLI flag > config default > env inference.
 * API keys are only read from env — never from config or CLI.
 */

import { BUILT_IN_CHECK_IDS } from "../semantic/checks/index.js";
import type { SemanticOptions } from "../semantic/types.js";
import type { AuditEngine } from "../types.js";
import type { BarrieretestConfig, SemanticProviderName } from "./config.js";
import { SEMANTIC_PROVIDERS } from "./config.js";

export const SEMANTIC_ENV_VAR_BY_PROVIDER: Record<SemanticProviderName, string> = {
  nebius: "NEBIUS_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export interface SemanticResolutionInput {
  /** Explicit `--semantic` flag. */
  semantic?: boolean;
  /** `--semantic-provider <name>` override. */
  semanticProvider?: string;
  /** `--semantic-model <id>` override. */
  semanticModel?: string;
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
 */
export function semanticRequested(input: SemanticResolutionInput): boolean {
  return Boolean(
    input.semantic ||
      input.semanticProvider ||
      input.semanticModel ||
      (input.semanticChecks && input.semanticChecks.length > 0) ||
      input.semanticTimeout !== undefined
  );
}

/**
 * Turn CLI + config + env into a ready-to-pass `SemanticOptions`, or
 * `undefined` when semantic mode was not requested.
 *
 * Throws a user-facing `Error` when the request is ambiguous or impossible
 * (missing API key, invalid provider, `pa11y + semantic`, unknown check IDs).
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

  const knownCheckIds = input.knownCheckIds ?? BUILT_IN_CHECK_IDS;
  const configSemantic = input.config.semantic ?? {};

  const provider = resolveProvider(input, configSemantic.provider);
  const apiKey = requireApiKey(provider, input.env);

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

  const model = input.semanticModel ?? configSemantic.model;

  const options: SemanticOptions = {
    provider: {
      name: provider,
      apiKey,
      ...(model ? { model } : {}),
    },
    ...(checks && checks.length > 0 ? { checks } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };

  return options;
}

function resolveProvider(
  input: SemanticResolutionInput,
  configProvider: SemanticProviderName | undefined
): SemanticProviderName {
  const explicit = input.semanticProvider ?? configProvider;

  if (explicit) {
    if (!(SEMANTIC_PROVIDERS as readonly string[]).includes(explicit)) {
      throw new Error(
        `Invalid semantic provider '${explicit}'. Must be one of: ${SEMANTIC_PROVIDERS.join(", ")}`
      );
    }
    return explicit as SemanticProviderName;
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
