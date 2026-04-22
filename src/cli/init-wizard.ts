/**
 * `barrieretest init` — interactive onboarding for the semantic audit.
 *
 * Walks the user through provider, model, checks, and timeout, writes the
 * result to `~/.barrieretest/config.json`, and prints the one-line command
 * to kick off a real run. Pure helpers at the bottom are the testable
 * surface; the `runInit` function is the TUI driver and is only exercised
 * through manual smoke runs.
 */

import { BUILT_IN_CHECKS, BUILT_IN_CHECK_IDS } from "../semantic/checks/index.js";
import type { CliResult } from "./index.js";
import {
  type BarrieretestConfig,
  getConfigPath,
  readConfig,
  SEMANTIC_PROVIDERS,
  type SemanticProviderName,
  writeConfig,
} from "./config.js";
import {
  confirm,
  intro,
  isInteractive,
  multiselect,
  note,
  outro,
  select,
  text,
  warn,
} from "./prompt.js";
import { SEMANTIC_ENV_VAR_BY_PROVIDER } from "./semantic-options.js";

/** Suggested default model per provider. Users can override at any time. */
export const DEFAULT_MODELS: Record<SemanticProviderName, string> = {
  nebius: "openai/gpt-oss-120b",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
};

const DEFAULT_TIMEOUT_MS = 120_000;

export interface WizardAnswers {
  provider: SemanticProviderName;
  model?: string;
  checks?: string[];
  timeout: number;
}

export interface RunInitDeps {
  configPath?: string;
  env: Record<string, string | undefined>;
}

export async function runInit(deps: RunInitDeps): Promise<CliResult> {
  if (!isInteractive()) {
    return {
      success: false,
      error:
        "`barrieretest init` requires an interactive terminal. " +
        "In non-TTY environments, use `barrieretest config set <key> <value>` instead.",
      exitCode: 1,
    };
  }

  const configPath = deps.configPath ?? getConfigPath();
  const existing = readConfig(configPath);

  intro("barrieretest · semantic audit setup");

  if (hasExistingSemanticConfig(existing)) {
    note("An existing semantic config was found at:");
    note(`  ${configPath}`);
    const proceed = await confirm({
      message: "Overwrite it?",
      default: false,
    });
    if (!proceed) {
      return {
        success: true,
        message: "Cancelled — existing config preserved.",
      };
    }
  }

  const defaultProvider = pickDefaultProvider(existing, deps.env);
  const provider = await select<SemanticProviderName>({
    message: "Which AI provider?",
    options: [
      { value: "nebius", label: "Nebius", hint: "gpt-oss-120b, cost-effective" },
      { value: "openai", label: "OpenAI", hint: "GPT-4o vision" },
      { value: "anthropic", label: "Anthropic", hint: "Claude with vision" },
    ],
    initialIndex: SEMANTIC_PROVIDERS.indexOf(defaultProvider),
  });

  const envVar = SEMANTIC_ENV_VAR_BY_PROVIDER[provider];
  const hasEnvVar = Boolean(deps.env[envVar]);
  if (hasEnvVar) {
    note(`${envVar} detected — ready to authenticate.`);
  } else {
    warn(`${envVar} is not set in this shell.`);
    note("Add it before running a semantic audit:");
    note(`  export ${envVar}=...`);
  }

  const suggestedModel = existing.semantic?.model ?? DEFAULT_MODELS[provider];
  const useDefaultModel = await confirm({
    message: `Use model ${suggestedModel}?`,
    default: true,
  });
  const model = useDefaultModel
    ? suggestedModel
    : await text({
        message: "Model identifier:",
        default: suggestedModel,
        validate: (v) => (v.trim() ? null : "Model cannot be empty."),
      });

  const initialCheckValues = existing.semantic?.checks ?? [...BUILT_IN_CHECK_IDS];
  const chosenChecks = await multiselect<string>({
    message: "Which semantic checks should run?",
    options: BUILT_IN_CHECKS.map((check) => ({
      value: check.id,
      label: check.id,
      hint: check.title,
    })),
    initialValues: initialCheckValues,
    required: true,
  });

  const timeoutInput = await text({
    message: "AI call timeout (ms):",
    default: String(existing.semantic?.timeout ?? DEFAULT_TIMEOUT_MS),
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? null : "Must be a positive integer.";
    },
  });
  const timeout = Number.parseInt(timeoutInput, 10);

  const answers: WizardAnswers = {
    provider,
    model,
    checks: chosenChecks.length === BUILT_IN_CHECK_IDS.length ? undefined : chosenChecks,
    timeout,
  };

  const next = buildConfigFromAnswers(existing, answers);

  note("");
  note(`Will write to ${configPath}:`);
  note(indentBlock(JSON.stringify(next, null, 2), "  "));

  const save = await confirm({ message: "Save?", default: true });
  if (!save) {
    return { success: true, message: "Cancelled — nothing was written." };
  }

  writeConfig(next, configPath);

  outro("Configuration saved.");
  note("Run a semantic audit with:");
  note("  barrieretest https://example.com --semantic");
  if (!hasEnvVar) {
    note("");
    note(`Remember to export ${envVar} first.`);
  }

  return { success: true };
}

export function hasExistingSemanticConfig(config: BarrieretestConfig): boolean {
  return Boolean(config.semantic && Object.keys(config.semantic).length > 0);
}

/**
 * Pick the provider we'll highlight as the default in the select prompt.
 *
 * Priority: existing config > sole env-var match > lexical default (nebius).
 * Multiple env-var matches mean we can't guess, so we just fall back to the
 * lexical default and let the user pick.
 */
export function pickDefaultProvider(
  existing: BarrieretestConfig,
  env: Record<string, string | undefined>
): SemanticProviderName {
  if (existing.semantic?.provider) {
    return existing.semantic.provider;
  }

  const fromEnv = SEMANTIC_PROVIDERS.filter((p) => !!env[SEMANTIC_ENV_VAR_BY_PROVIDER[p]]);
  if (fromEnv.length === 1) {
    return fromEnv[0];
  }

  return "nebius";
}

/**
 * Merge wizard answers into the existing config, preserving any unrelated
 * fields (future-proofing for when the config grows beyond `semantic`).
 */
export function buildConfigFromAnswers(
  existing: BarrieretestConfig,
  answers: WizardAnswers
): BarrieretestConfig {
  return {
    ...existing,
    semantic: {
      provider: answers.provider,
      ...(answers.model ? { model: answers.model } : {}),
      ...(answers.checks && answers.checks.length > 0 ? { checks: answers.checks } : {}),
      timeout: answers.timeout,
    },
  };
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
