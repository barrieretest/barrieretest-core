/**
 * `barrieretest check` — manage user-authored semantic AI checks.
 *
 * Four subcommands:
 *   - add     interactive wizard (or flag-driven for CI)
 *   - list    show built-ins + global/project user checks
 *   - remove  delete a user check from global or project scope
 *   - test    dry-run a single check against a URL
 *
 * Global checks live in `~/.barrieretest/config.json`, project-local
 * checks in `<repo>/.barrieretest.json`. Built-in IDs cannot be
 * overridden — `userCheckConfigToSemanticCheck` enforces that and
 * `validateIdForScope` guards the happy path in the wizard.
 */

import { audit } from "../audit.js";
import {
  BUILT_IN_CHECKS,
  BUILT_IN_CHECK_IDS,
  userCheckConfigToSemanticCheck,
} from "../semantic/checks/index.js";
import {
  SEMANTIC_CONTEXT_SECTIONS,
  type SemanticContextSection,
  type UserCheckConfig,
} from "../semantic/types.js";
import type { AuditOptions } from "../types.js";
import {
  findProjectConfigPath,
  getConfigPath,
  PROJECT_CONFIG_FILENAME,
  readConfig,
  resolveProjectConfigWritePath,
  writeConfig,
  type BarrieretestConfig,
} from "./config.js";
import type { CliResult, ParsedArgs } from "./index.js";
import { isInteractive, select } from "./prompt.js";
import { resolveSemanticOptions } from "./semantic-options.js";

export interface RunCheckDeps {
  env: Record<string, string | undefined>;
  configPath?: string;
  cwd: string;
}

export async function runCheck(args: ParsedArgs, deps: RunCheckDeps): Promise<CliResult> {
  const sub = args.checkSubcommand;
  if (!sub) {
    return {
      success: false,
      error: "Usage: barrieretest check <add|list|remove|test> [options]",
      exitCode: 1,
    };
  }

  try {
    switch (sub) {
      case "add":
        return await runCheckAdd(args, deps);
      case "list":
        return runCheckList(deps);
      case "remove":
        return await runCheckRemove(args, deps);
      case "test":
        return await runCheckTest(args, deps);
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function runCheckAdd(args: ParsedArgs, deps: RunCheckDeps): Promise<CliResult> {
  const { globalPath, projectPath, projectPathResolved, globalCfg, projectCfg } = loadScopes(deps);

  // Non-interactive (CI) path: all required fields provided via flags.
  if (hasAllRequiredAddFlags(args)) {
    const scope = args.checkScope ?? "global";
    const candidate: UserCheckConfig = {
      id: String(args.checkId).trim(),
      title: String(args.checkTitle).trim(),
      description: String(args.checkDescription).trim(),
      prompt: String(args.checkPrompt).trim(),
      ...(args.checkNeedsScreenshot !== undefined
        ? { needsScreenshot: args.checkNeedsScreenshot }
        : {}),
      ...(args.checkContext ? { context: parseContextFlag(args.checkContext) } : {}),
    };
    return writeCheck({
      candidate,
      scope,
      globalPath,
      projectPath:
        scope === "project"
          ? (projectPath ?? resolveProjectConfigWritePath(deps.cwd))
          : projectPath,
      globalCfg,
      projectCfg,
      existingGlobalIds: listUserIds(globalCfg),
      existingProjectIds: listUserIds(projectCfg),
    });
  }

  if (!isInteractive()) {
    return {
      success: false,
      error:
        "`barrieretest check add` needs a TTY, or all of --id, --title, --description, --prompt, --scope.",
      exitCode: 1,
    };
  }

  const { runCheckAddWizard } = await import("./check-wizard.js");
  const { check, scope } = await runCheckAddWizard({
    globalIds: listUserIds(globalCfg),
    projectIds: listUserIds(projectCfg),
    projectDiscovered: projectPathResolved,
  });

  return writeCheck({
    candidate: check,
    scope,
    globalPath,
    projectPath:
      scope === "project" ? (projectPath ?? resolveProjectConfigWritePath(deps.cwd)) : projectPath,
    globalCfg,
    projectCfg,
    existingGlobalIds: listUserIds(globalCfg),
    existingProjectIds: listUserIds(projectCfg),
  });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function runCheckList(deps: RunCheckDeps): CliResult {
  const { projectPath, globalCfg, projectCfg } = loadScopes(deps);

  const lines: string[] = [];
  lines.push("Built-in checks:");
  for (const c of BUILT_IN_CHECKS) {
    lines.push(`  [built-in] ${c.id}  ${c.title}`);
  }

  const globalChecks = globalCfg.semantic?.customChecks ?? [];
  const projectChecks = projectCfg.semantic?.customChecks ?? [];
  const projectIdSet = new Set(projectChecks.map((c) => c.id));

  if (globalChecks.length > 0) {
    lines.push("");
    lines.push("Global checks (~/.barrieretest/config.json):");
    for (const c of globalChecks) {
      const overridden = projectIdSet.has(c.id) ? "  (overridden by project)" : "";
      lines.push(`  [global]   ${c.id}  ${c.title}${overridden}`);
    }
  }

  if (projectChecks.length > 0) {
    lines.push("");
    lines.push(`Project checks (${projectPath ?? PROJECT_CONFIG_FILENAME}):`);
    for (const c of projectChecks) {
      lines.push(`  [project]  ${c.id}  ${c.title}`);
    }
  }

  if (globalChecks.length === 0 && projectChecks.length === 0) {
    lines.push("");
    lines.push("No user checks defined. Run `barrieretest check add` to create one.");
  }

  return { success: true, message: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function runCheckRemove(args: ParsedArgs, deps: RunCheckDeps): Promise<CliResult> {
  const id = args.checkId;
  if (!id) {
    return {
      success: false,
      error: "Usage: barrieretest check remove <id> [--scope global|project]",
      exitCode: 1,
    };
  }

  const { globalPath, projectPath, globalCfg, projectCfg } = loadScopes(deps);
  const inGlobal = listUserIds(globalCfg).includes(id);
  const inProject = listUserIds(projectCfg).includes(id);

  if (!inGlobal && !inProject) {
    return {
      success: false,
      error: `No user check with id '${id}' found in global or project config.`,
      exitCode: 1,
    };
  }

  let scope = args.checkScope;
  if (!scope) {
    if (inGlobal && inProject) {
      if (!isInteractive()) {
        return {
          success: false,
          error: `'${id}' exists in both scopes. Pass --scope global or --scope project.`,
          exitCode: 1,
        };
      }
      scope = await select<"global" | "project">({
        message: `Remove '${id}' from which scope?`,
        options: [
          { value: "project", label: "Project" },
          { value: "global", label: "Global" },
        ],
      });
    } else {
      scope = inProject ? "project" : "global";
    }
  }

  if (scope === "global") {
    if (!inGlobal) {
      return { success: false, error: `'${id}' is not in global config.`, exitCode: 1 };
    }
    const next = withoutCheck(globalCfg, id);
    writeConfig(next, globalPath);
    return { success: true, message: `Removed '${id}' from global config.` };
  }

  if (!projectPath) {
    return {
      success: false,
      error: "No project config found; nothing to remove from project scope.",
      exitCode: 1,
    };
  }
  if (!inProject) {
    return { success: false, error: `'${id}' is not in project config.`, exitCode: 1 };
  }
  const next = withoutCheck(projectCfg, id);
  writeConfig(next, projectPath);
  return { success: true, message: `Removed '${id}' from ${projectPath}.` };
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

async function runCheckTest(args: ParsedArgs, deps: RunCheckDeps): Promise<CliResult> {
  const id = args.checkId;
  const url = args.checkUrl;
  if (!id || !url) {
    return {
      success: false,
      error: "Usage: barrieretest check test <id> --url <url>",
      exitCode: 1,
    };
  }

  const { globalCfg, projectCfg } = loadScopes(deps);
  const merged = mergeCustomChecks(globalCfg, projectCfg);
  const allIds = new Set<string>([...BUILT_IN_CHECK_IDS, ...merged.map((c) => c.id)]);
  if (!allIds.has(id)) {
    return {
      success: false,
      error: `Unknown check id '${id}'. Run 'barrieretest check list' to see available checks.`,
      exitCode: 1,
    };
  }

  const configForResolve: BarrieretestConfig = {
    semantic: {
      ...(globalCfg.semantic ?? {}),
      ...(projectCfg.semantic ?? {}),
      customChecks: merged,
    },
  };

  const semanticOptions = resolveSemanticOptions({
    semantic: true,
    semanticChecks: [id],
    config: configForResolve,
    env: deps.env,
  });

  const opts: AuditOptions = {
    headless: true,
    semantic: semanticOptions,
  };

  const result = await audit(url, opts);
  const findings = result.issues.filter((i) => i.id === `semantic:${id}`);

  const lines: string[] = [];
  lines.push(`Check '${id}' against ${url}`);
  lines.push(
    `Provider: ${result.semanticMeta?.provider ?? "-"}${
      result.semanticMeta?.model ? ` (${result.semanticMeta.model})` : ""
    }`
  );
  lines.push(`Findings: ${findings.length}`);
  for (const f of findings) {
    lines.push(`  - [${f.impact}] ${f.description}`);
    if (f.selector) lines.push(`    Element: ${f.selector}`);
  }
  return { success: true, message: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface LoadedScopes {
  globalPath: string;
  projectPath: string | undefined;
  /** True when a project config file was actually found on disk. */
  projectPathResolved: boolean;
  globalCfg: BarrieretestConfig;
  projectCfg: BarrieretestConfig;
}

function loadScopes(deps: RunCheckDeps): LoadedScopes {
  const globalPath = deps.configPath ?? getConfigPath();
  const globalCfg = readConfig(globalPath);
  const projectPath = findProjectConfigPath(deps.cwd);
  const projectCfg = projectPath ? readConfig(projectPath) : {};
  return {
    globalPath,
    projectPath,
    projectPathResolved: Boolean(projectPath),
    globalCfg,
    projectCfg,
  };
}

function listUserIds(cfg: BarrieretestConfig): string[] {
  return (cfg.semantic?.customChecks ?? []).map((c) => c.id);
}

function mergeCustomChecks(
  global: BarrieretestConfig,
  project: BarrieretestConfig
): UserCheckConfig[] {
  const byId = new Map<string, UserCheckConfig>();
  for (const c of global.semantic?.customChecks ?? []) byId.set(c.id, c);
  for (const c of project.semantic?.customChecks ?? []) byId.set(c.id, c);
  return Array.from(byId.values());
}

function hasAllRequiredAddFlags(args: ParsedArgs): boolean {
  return Boolean(
    args.checkId && args.checkTitle && args.checkDescription && args.checkPrompt && args.checkScope
  );
}

function parseContextFlag(raw: string[]): SemanticContextSection[] {
  const allowed = new Set<string>(SEMANTIC_CONTEXT_SECTIONS);
  const bad = raw.filter((s) => !allowed.has(s));
  if (bad.length > 0) {
    throw new Error(
      `Unknown context section(s): ${bad.join(", ")}. Allowed: ${SEMANTIC_CONTEXT_SECTIONS.join(", ")}`
    );
  }
  return Array.from(new Set(raw)) as SemanticContextSection[];
}

interface WriteCheckArgs {
  candidate: UserCheckConfig;
  scope: "global" | "project";
  globalPath: string;
  projectPath: string | undefined;
  globalCfg: BarrieretestConfig;
  projectCfg: BarrieretestConfig;
  existingGlobalIds: string[];
  existingProjectIds: string[];
}

function writeCheck(args: WriteCheckArgs): CliResult {
  // Run the runtime validator to surface shape errors (e.g. bad id) exactly
  // once, with the same message the audit path would throw later.
  userCheckConfigToSemanticCheck(args.candidate);

  const existingInScope =
    args.scope === "project" ? args.existingProjectIds : args.existingGlobalIds;
  if (existingInScope.includes(args.candidate.id)) {
    throw new Error(`Check id '${args.candidate.id}' already exists in ${args.scope} scope.`);
  }

  if (args.scope === "global") {
    const next = withAddedCheck(args.globalCfg, args.candidate);
    writeConfig(next, args.globalPath);
    return {
      success: true,
      message: `Saved '${args.candidate.id}' to ${args.globalPath}.`,
    };
  }

  if (!args.projectPath) {
    throw new Error("Project path missing for project-scope write.");
  }
  const next = withAddedCheck(args.projectCfg, args.candidate);
  writeConfig(next, args.projectPath);
  return {
    success: true,
    message: `Saved '${args.candidate.id}' to ${args.projectPath}.`,
  };
}

function withAddedCheck(cfg: BarrieretestConfig, check: UserCheckConfig): BarrieretestConfig {
  const existing = cfg.semantic?.customChecks ?? [];
  return {
    ...cfg,
    semantic: {
      ...(cfg.semantic ?? {}),
      customChecks: [...existing, check],
    },
  };
}

function withoutCheck(cfg: BarrieretestConfig, id: string): BarrieretestConfig {
  const existing = cfg.semantic?.customChecks ?? [];
  const filtered = existing.filter((c) => c.id !== id);
  const semantic = { ...(cfg.semantic ?? {}) };
  if (filtered.length > 0) {
    semantic.customChecks = filtered;
  } else {
    delete semantic.customChecks;
  }
  const next: BarrieretestConfig = { ...cfg };
  if (Object.keys(semantic).length === 0) {
    delete next.semantic;
  } else {
    next.semantic = semantic;
  }
  return next;
}
