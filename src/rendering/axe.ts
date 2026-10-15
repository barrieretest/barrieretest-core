/**
 * The axe run of one rendering condition.
 *
 * Two checks need axe's own verdict under a condition rather than geometry:
 * `target-size` at the mobile viewport, and `color-contrast` and
 * `link-in-text-block` under a colour mode. Axe is already on the page from
 * the engine pass, so this re-injects it only when it is gone, restricts the
 * run to the rules the condition's checks asked for, and resolves every node
 * to a rect in the capture's space — the checks themselves never touch the
 * browser.
 *
 * The run is one step of the condition's measurement, and it owns no clock
 * of its own: the runner's condition budget bounds it, and the runner's
 * cancellation token — asked before the presence check, before the
 * injection and before the run — is what stops it. A browser operation this
 * started therefore keeps the condition's promise pending until it settles,
 * which is what makes the runner treat an axe run it gave up waiting for as
 * work that still holds the page.
 */

import type { MeasuredRect } from "../annotate/index.js";
import type { BrowserPage } from "../browser.js";
import { flattenTarget, resolveAxeSource, toIssueSeverity } from "../engines/axe.js";
import type { Issue } from "../types.js";
import type {
  ConditionCancellation,
  RenderingAxeNode,
  RenderingAxeResult,
  RenderingAxeRun,
} from "./types.js";

/** Never carry more nodes than this per rule and outcome. */
const MAX_NODES = 50;

/** Bound for the markup each node carries, as in the measurement. */
const HTML_LIMIT = 200;

/** What one node looked like in the browser, before Node names and keys it. */
export interface RawAxeNode {
  target: (string | string[])[];
  html: string;
  impact: string | null;
  failureSummary?: string;
  rect?: MeasuredRect;
  anchored?: boolean;
  textFillMismatch?: boolean;
}

/** One rule's results as the in-page run reported them. */
export interface RawAxeResult {
  id: string;
  outcome: "violation" | "incomplete";
  description: string;
  help: string;
  helpUrl: string;
  impact: string | null;
  nodes: RawAxeNode[];
  /** Whether the rule had more nodes a check could report than fit the cap. */
  truncated?: boolean;
}

interface AxeEvaluateArgs {
  rules: string[];
  maxNodes: number;
  htmlLimit: number;
  /**
   * What the engine pass already reported, as `baselineKey` spells it. The
   * cap is spent on the nodes a check can report, so these are dropped
   * before it applies and not after.
   */
  baselineKeys: string[];
}

/**
 * The key the engine pass and a condition's axe run are compared by: the
 * rule and the element, nothing else. A contrast failure the page already
 * has is not something the mode introduced.
 */
export function baselineKey(ruleId: string, selector: string | null): string {
  return `${ruleId}|${selector ?? ""}`;
}

/** The engine pass's findings, as the lookup a mode-specific check needs. */
export function renderingAxeBaseline(issues: readonly Issue[]): Set<string> {
  const keys = new Set<string>();
  for (const issue of issues) {
    // Only the engine's own rules: a rendering finding is not a baseline.
    if (issue.rendering) continue;
    keys.add(baselineKey(issue.id, issue.selector));
  }
  return keys;
}

function isRawResultList(value: unknown): value is RawAxeResult[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const result = entry as Record<string, unknown>;
      return typeof result.id === "string" && Array.isArray(result.nodes);
    })
  );
}

/**
 * Run the rules under the condition the page is in right now. Rejects on a
 * browser error, like `measureRendering`, and when the runner has abandoned
 * the condition; the caller turns either into a skipped condition.
 */
export async function runConditionAxe(
  page: BrowserPage,
  options: {
    rules: string[];
    /** First identity a node may take, continuing the measurement's numbering. */
    indexOffset: number;
    /** What the engine pass already reported, from `renderingAxeBaseline`. */
    baseline?: ReadonlySet<string>;
    /**
     * The runner's cancellation token. Asked before every browser step, so a
     * condition the runner has given up on injects nothing and runs nothing.
     */
    token?: ConditionCancellation;
  }
): Promise<RenderingAxeRun> {
  const { token } = options;

  token?.check();
  const present = await page.evaluate(
    () => typeof (globalThis as { axe?: unknown }).axe !== "undefined"
  );

  token?.check();
  if (!present) {
    // The engine pass puts axe on the page; only a page it never ran on, or
    // one that navigated since, needs it again.
    const axeModule = await import("axe-core");
    const source = resolveAxeSource(axeModule);
    token?.check();
    await page.evaluate((code: string) => {
      const script = document.createElement("script");
      script.id = "__barrieretest-axe-core__";
      script.textContent = code;
      (document.head ?? document.documentElement).appendChild(script);
    }, source);
    token?.check();
  }

  const args: AxeEvaluateArgs = {
    rules: options.rules,
    maxNodes: MAX_NODES,
    htmlLimit: HTML_LIMIT,
    baselineKeys: [...(options.baseline ?? [])],
  };

  const raw = await page.evaluate(async (input: AxeEvaluateArgs): Promise<RawAxeResult[]> => {
    // NOTE: this runs in the browser via page.evaluate — it cannot
    // reference Node-scope constants or helpers.
    type AxeNode = {
      target: (string | string[])[];
      html: string;
      impact: string | null;
      failureSummary?: string;
    };
    type AxeRuleResult = {
      id: string;
      impact: string | null;
      description: string;
      help: string;
      helpUrl: string;
      nodes: AxeNode[];
    };
    type AxeRunResults = { violations: AxeRuleResult[]; incomplete: AxeRuleResult[] };

    const runtime = globalThis as {
      axe?: {
        run: (
          context: Document,
          options: { runOnly: { type: "rule"; values: string[] } }
        ) => Promise<AxeRunResults>;
      };
    };
    if (!runtime.axe) throw new Error("axe-core is not on the page.");

    // `runOnly` by rule id runs exactly these rules, disabled by default
    // or not — which is what `target-size` is.
    const results = await runtime.axe.run(document, {
      runOnly: { type: "rule", values: input.rules },
    });

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const baseline = new Set(input.baselineKeys);

    /** The selector spelling of `flattenTarget`, so the keys compare. */
    const flatten = (target: (string | string[])[]): string => {
      if (!target || target.length === 0) return "";
      return target
        .map((segment) => (Array.isArray(segment) ? segment.join(" > ") : segment))
        .join(" > ");
    };

    /** The element of a node, when its target names one in this document. */
    const elementOf = (target: (string | string[])[]): Element | null => {
      // A target with more than one step crosses a frame, and a nested
      // array pierces a shadow root; neither can be resolved from here,
      // and a finding without a rect is still a finding.
      if (target.length !== 1 || typeof target[0] !== "string") return null;
      try {
        return document.querySelector(target[0]);
      } catch {
        return null;
      }
    };

    /**
     * Whether axe measured a text colour the browser does not paint:
     * `color` and `-webkit-text-fill-color` disagree, and the element is
     * subject to forced-colour adjustment, which replaces `color` and
     * paints with it while leaving the fill colour at the author's value.
     * An element that opted out (`forced-color-adjust: none`, inherited or
     * its own) keeps both of its author-set values, so a mismatch there is
     * the author's own and axe's numbers are about the painted colour.
     */
    const textFillMismatch = (element: Element): boolean => {
      const style = getComputedStyle(element);
      if (style.getPropertyValue("forced-color-adjust") === "none") return false;
      const fill = style.getPropertyValue("-webkit-text-fill-color");
      return fill !== "" && fill !== style.color;
    };

    const anchoredOf = (element: Element): boolean => {
      let node: Element | null = element;
      while (node) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") return true;
        node = node.parentElement;
      }
      return false;
    };

    const nodeOf = (node: AxeNode): RawAxeNode => {
      const element = elementOf(node.target);
      const box = element?.getBoundingClientRect();
      return {
        target: node.target,
        html: (node.html ?? "").slice(0, input.htmlLimit),
        impact: node.impact ?? null,
        ...(node.failureSummary ? { failureSummary: node.failureSummary } : {}),
        ...(element && box
          ? {
              rect: {
                x: box.left + scrollX,
                y: box.top + scrollY,
                width: box.width,
                height: box.height,
              },
              anchored: anchoredOf(element),
              ...(textFillMismatch(element) ? { textFillMismatch: true } : {}),
            }
          : {}),
      };
    };

    const collect = (list: AxeRuleResult[], outcome: "violation" | "incomplete"): RawAxeResult[] =>
      list.map((result) => {
        const nodes: RawAxeNode[] = [];
        let eligible = 0;
        for (const node of result.nodes) {
          // The engine pass already reported this rule on this element, so
          // no check can report it: dropping it here is what keeps the cap
          // for the nodes the condition itself introduced.
          if (baseline.has(`${result.id}|${flatten(node.target)}`)) continue;
          eligible++;
          if (nodes.length >= input.maxNodes) continue;
          nodes.push(nodeOf(node));
        }
        return {
          id: result.id,
          outcome,
          description: result.description,
          help: result.help,
          helpUrl: result.helpUrl,
          impact: result.impact ?? null,
          nodes,
          ...(eligible > nodes.length ? { truncated: true } : {}),
        };
      });

    return [
      ...collect(results.violations, "violation"),
      ...collect(results.incomplete, "incomplete"),
    ];
  }, args);

  if (!isRawResultList(raw)) {
    throw new Error("the condition's axe run returned unexpected data");
  }

  return assembleAxeRun(raw, options);
}

/**
 * Name, key and number the raw results: the selector is flattened the way
 * the engine pass flattens it, so the baseline lookup compares like with
 * like, and one element keeps one identity across the rules of this run, so
 * two findings about it share a mark.
 */
export function assembleAxeRun(
  raw: RawAxeResult[],
  options: { rules: string[]; indexOffset: number; baseline?: ReadonlySet<string> }
): RenderingAxeRun {
  let nextIndex = options.indexOffset;
  const identities = new Map<string, number>();

  const results: RenderingAxeResult[] = raw.map((result) => ({
    id: result.id,
    outcome: result.outcome,
    description: result.description,
    help: result.help,
    helpUrl: result.helpUrl,
    impact: toIssueSeverity(result.impact),
    ...(result.truncated ? { truncated: true } : {}),
    nodes: result.nodes.map((node): RenderingAxeNode => {
      const selector = flattenTarget(node.target) ?? "";
      // One element, one identity, so two rules about it share a mark. A
      // node without a target names no element and gets its own.
      let index = selector === "" ? undefined : identities.get(selector);
      if (index === undefined) {
        index = nextIndex++;
        if (selector !== "") identities.set(selector, index);
      }
      return {
        selector,
        html: node.html,
        ...(node.failureSummary ? { failureSummary: node.failureSummary } : {}),
        impact: toIssueSeverity(node.impact ?? result.impact),
        index,
        ...(node.rect ? { rect: node.rect } : {}),
        ...(node.anchored ? { anchored: true } : {}),
        ...(node.textFillMismatch ? { textFillMismatch: true } : {}),
        inBaseline: options.baseline?.has(baselineKey(result.id, selector)) === true,
      };
    }),
  }));

  return {
    rules: [...options.rules],
    results,
    ...(results.some((result) => result.truncated) ? { truncated: true } : {}),
  };
}
