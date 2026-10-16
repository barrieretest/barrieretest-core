/**
 * The rendering pass.
 *
 * For each condition in order: apply it, let the layout settle, run the one
 * measurement `page.evaluate` that gathers the union of what the checks
 * active under that condition need — plus, for the checks that ask for it,
 * one axe run restricted to their rules, inside the same step and on the
 * same budget — capture the page, and revert: apply and revert paired in
 * `try/finally`, so a condition that fails costs its own findings and one
 * warning, never a page the later steps cannot use.
 *
 * Conditions whose emulation the page cannot do are skipped with a reason
 * instead of failing. Checks never touch the browser: they are pure
 * functions of the measurement, run after the loop.
 *
 * Two things keep the page honest. A condition that runs out of budget is
 * cancelled cooperatively and waited for, so abandoned work cannot change the
 * page while the next condition is measured; and a revert that fails is
 * retried once, after which the pass stops rather than report later
 * conditions as results from a page it could not put back. Abandoned work
 * that outlives its grace period is not disowned: the pass reports the page
 * as unsafe and restores it once more when that work finally settles.
 *
 * Every step of that restoration is bounded from Node as well, including the
 * final scroll to the top: a browser that stops answering must cost the pass
 * its remaining conditions and the page's established state, never the
 * audit's return. A step that does not answer in time counts as failed and
 * is never raced by a second restore call while it is still outstanding —
 * the page stays the pass's own until it settles.
 *
 * `audit()` is the only caller.
 */

import {
  captureSizeFrom,
  type CaptureSize,
  readImageSize,
  screenshotMetaFrom,
} from "../annotate/index.js";
import type { BrowserPage } from "../browser.js";
import type {
  Issue,
  RenderingCapture,
  RenderingConditionId,
  RenderingMeta,
  RenderingOptions,
} from "../types.js";
import { renderingAxeBaseline, runConditionAxe } from "./axe.js";
import { createRenderingCapabilities, type RenderingCapabilities } from "./capabilities.js";
import { resolveRenderingChecks } from "./checks/index.js";
import { requiredCapabilities, resolveConditions } from "./conditions.js";
import { renderingIssues } from "./issues.js";
import {
  isRenderingMeasurement,
  measureRendering,
  nextMeasurementIdentity,
  unionCollect,
} from "./measure.js";
import {
  applyTextSpacing,
  removeTextSpacing,
  SETTLE_NETWORK_CAP_MS,
  SETTLE_TRANSITION_CAP_MS,
  settleCondition,
} from "./page.js";
import type {
  CrossConditionCheck,
  PerConditionCheck,
  RenderingCheck,
  RenderingCondition,
  RenderingFinding,
  RenderingMeasurement,
} from "./types.js";

/** Per-condition time budget covering apply, settle, measure and capture. */
export const DEFAULT_CONDITION_TIMEOUT_MS = 8_000;

/**
 * Bound for one step of the restoration path — one emulation, the override
 * removal, the final scroll, the adapter release. Independent of the
 * condition budget, which is already spent by the time they run, and small
 * enough that the whole cleanup stays a handful of seconds on a browser that
 * has stopped answering.
 */
export const CLEANUP_TIMEOUT_MS = 2_000;

/**
 * Bound for a cleanup settle: `settleCondition` waits up to its network and
 * transition caps in sequence, plus frames and round trips, so the plain
 * cleanup bound would mark a responsive page unsafe.
 */
export const SETTLE_CLEANUP_TIMEOUT_MS =
  SETTLE_NETWORK_CAP_MS + SETTLE_TRANSITION_CAP_MS + CLEANUP_TIMEOUT_MS;

/** Quality of the condition captures; the baseline screenshot stays PNG. */
const CAPTURE_QUALITY = 85;

export interface RenderingRunOptions extends RenderingOptions {
  /** Audit timeout; the measurement uses the smaller of it and its own bound. */
  timeout?: number;
  /**
   * What the engine pass reported. A mode-specific check reports what the
   * mode broke, not the page's own failures a second time, and this is what
   * it compares against; without it every baseline failure would look like
   * one the mode introduced.
   */
  baselineIssues?: readonly Issue[];
  onProgress?: (data: { percent: number; message: string }) => void | Promise<void>;
  /** Progress percentage reported for every condition. */
  progressPercent?: number;
}

export interface RenderingRunResult {
  issues: Issue[];
  /** One per condition that ran; empty when `captures` is false. */
  captures: RenderingCapture[];
  meta: RenderingMeta;
}

function isPerCondition(check: RenderingCheck): check is PerConditionCheck {
  return check.kind === "per-condition";
}

function isCrossCondition(check: RenderingCheck): check is CrossConditionCheck {
  return check.kind === "cross-condition";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tells a Node-side race apart from an error the work itself raised. */
class ConditionTimeoutError extends Error {}

/** Race `work` against the condition's budget; the loser keeps running. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, text: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConditionTimeoutError(text)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Cooperative cancellation for the Node-side work of one condition.
 *
 * Losing the race only stops the waiting, not the work: without this the
 * abandoned apply/measure chain resumes at its next step and changes the
 * viewport or injects a stylesheet into a page the runner is already
 * reverting, or has already handed to the next condition. Every step of the
 * chain therefore asks the token before it mutates anything, and the runner
 * waits for the chain to stop before it touches the page again — the
 * Node-side counterpart of the in-page cancel flag in `src/lazy-content.ts`.
 */
class ConditionToken {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  /** Called before every mutation and between every awaited step. */
  check(): void {
    if (this.cancelled) {
      throw new Error("the condition was abandoned when its budget ran out");
    }
  }
}

/**
 * How long the runner waits for an abandoned condition to stop between two of
 * its own steps before it gives up on the page's state.
 */
export const CANCEL_SETTLE_MS = 2_000;

/**
 * Bounded wait for abandoned work. True when it has stopped, so nothing of it
 * can mutate the page any more; false when it may still be mid-step.
 */
async function hasStopped(work: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What one bounded cleanup step came back with. */
interface CleanupOutcome {
  /** What could not be done, in the words a warning can carry. */
  problem?: string;
  /**
   * The work when it did not answer within its bound. It still holds the
   * page, so nothing may restore it again until this settles.
   */
  outstanding?: Promise<unknown>;
}

/**
 * Run one step of the restoration path under its own bound. A step that
 * fails or does not answer in time is a step that did not happen: the page is
 * no longer the state the pass claims, and a step that may still be in flight
 * keeps the page until it settles.
 */
async function cleanupStep(
  what: string,
  start: () => Promise<unknown>,
  timeoutMs: number
): Promise<CleanupOutcome> {
  let work: Promise<unknown>;
  try {
    work = start();
  } catch (error) {
    // A throw before the first await never reached the page.
    return { problem: `${what} (${message(error)})` };
  }
  // Once the race is lost nothing awaits it any more, and a rejection
  // without a handler would be an unhandled one.
  work.catch(() => {});

  try {
    await withTimeout(work, timeoutMs, `no answer within ${timeoutMs}ms`);
    return {};
  } catch (error) {
    return {
      problem: `${what} (${message(error)})`,
      ...(error instanceof ConditionTimeoutError ? { outstanding: work } : {}),
    };
  }
}

/** One promise that settles once all of them have, however they settle. */
function allSettled(work: Promise<unknown>[]): Promise<unknown> {
  return Promise.all(
    work.map((item) =>
      item.then(
        () => undefined,
        () => undefined
      )
    )
  );
}

/** Everything one condition produced. */
interface ConditionRun {
  measurement: RenderingMeasurement;
  screenshot: Uint8Array;
  capture?: CaptureSize;
  meta: RenderingCapture["meta"];
}

export async function runRenderingChecks(
  page: BrowserPage,
  options: RenderingRunOptions = {}
): Promise<RenderingRunResult> {
  const started = Date.now();
  const conditions = resolveConditions(options.conditions);
  const checks = resolveRenderingChecks(options.checks);
  const keepCaptures = options.captures !== false;
  const conditionTimeout = options.conditionTimeout ?? DEFAULT_CONDITION_TIMEOUT_MS;
  const progressPercent = options.progressPercent ?? 72;

  const perConditionChecks = checks.filter(isPerCondition);
  const requestedIds = new Set(conditions.map((condition) => condition.id));
  // A cross-condition check needs both of its conditions in the run.
  const crossChecks = checks
    .filter(isCrossCondition)
    .filter(
      (check) => requestedIds.has(check.reportsUnder) && requestedIds.has(check.comparesWith)
    );

  /** The checks whose measurement needs are collected under this condition. */
  const collectorsFor = (condition: RenderingCondition): RenderingCheck[] => [
    ...perConditionChecks.filter((check) => check.appliesTo(condition)),
    ...crossChecks.filter(
      (check) => check.reportsUnder === condition.id || check.comparesWith === condition.id
    ),
  ];

  const baseline = renderingAxeBaseline(options.baselineIssues ?? []);
  const capabilities = await createRenderingCapabilities(page);
  const runs = new Map<RenderingConditionId, ConditionRun>();
  const captures: RenderingCapture[] = [];
  const captureIndexes = new Map<RenderingConditionId, number>();
  const conditionsRun: RenderingConditionId[] = [];
  const conditionsSkipped: { condition: RenderingConditionId; reason: string }[] = [];

  /** Conditions whose revert could not be established, in run order. */
  const restorationFailed: RenderingConditionId[] = [];
  /**
   * Conditions where a cap dropped something eligible — the element walk, a
   * collected group, the axe run or a check's own finding cap — so their
   * results are partial.
   */
  const truncated: RenderingConditionId[] = [];
  const markTruncated = (condition: RenderingConditionId): void => {
    if (!truncated.includes(condition)) truncated.push(condition);
  };
  /** Set once the page's state is no longer established; the loop then stops. */
  let stopped = false;
  /**
   * Work the pass gave up waiting for — an abandoned apply, or a restoration
   * step that did not answer — and still owns, so nothing may restore the
   * page again until it settles.
   */
  let pending: Promise<unknown> | null = null;
  /** Set unless the page's original state is confirmed re-established. */
  let pageUnsafe = false;

  const skip = (condition: RenderingConditionId, reason: string): void => {
    conditionsSkipped.push({ condition, reason });
    console.warn(`Rendering condition ${condition} skipped: ${reason}`);
  };

  try {
    for (const [index, condition] of conditions.entries()) {
      const missing = requiredCapabilities(condition).filter(
        (name) => !capabilities.supports[name]
      );
      if (missing.length > 0) {
        skip(condition.id, `the browser page cannot emulate ${missing.join(", ")}`);
        continue;
      }

      try {
        await options.onProgress?.({
          percent: progressPercent,
          message: `Rendering condition ${condition.id}`,
        });
      } catch {
        /* ignore progress callback errors */
      }

      const collect = unionCollect(collectorsFor(condition).map((check) => check.collect));
      const token = new ConditionToken();
      const work = applyAndMeasure(page, capabilities, condition, collect, {
        timeout: options.timeout,
        token,
        baseline,
      });
      // Once the race is lost nothing awaits it any more, and a rejection
      // without a handler would be an unhandled one.
      work.catch(() => {});
      /** True while an abandoned apply could still mutate the page. */
      let running = false;

      try {
        const run = await withTimeout(
          work,
          conditionTimeout,
          `the condition timed out after ${conditionTimeout}ms`
        );
        runs.set(condition.id, run);
        conditionsRun.push(condition.id);
        if (
          run.measurement.truncated ||
          run.measurement.paintedTruncated === true ||
          run.measurement.ancestorsTruncated === true ||
          run.measurement.motion?.truncated === true ||
          run.measurement.linksTruncated === true ||
          run.measurement.statesTruncated === true ||
          run.measurement.axe?.truncated
        ) {
          markTruncated(condition.id);
        }
        if (keepCaptures) {
          captureIndexes.set(condition.id, captures.length);
          captures.push({
            condition: condition.id,
            screenshot: run.screenshot,
            meta: run.meta,
          });
        }
      } catch (error) {
        if (error instanceof ConditionTimeoutError) {
          // The chain stops at its next step; until it has, the page is
          // still its own.
          token.cancel();
          running = !(await hasStopped(work, CANCEL_SETTLE_MS));
        }
        skip(condition.id, message(error));
      } finally {
        // Apply and revert stay paired — unless an abandoned apply may still
        // be mid-step, in which case reverting would race it: what is left
        // is the restore after the loop, and one more once that work has
        // settled.
        if (running) {
          stopped = true;
          restorationFailed.push(condition.id);
          // Giving up on the waiting is not giving up on the work: it still
          // holds the page, so the pass keeps it and restores once more when
          // it settles.
          pending = work;
          console.warn(
            `Rendering condition ${condition.id} could not be confirmed to have stopped within ${CANCEL_SETTLE_MS}ms; no further condition is run.`
          );
        } else {
          const reverted = await revertWithRetry(page, capabilities, condition, CLEANUP_TIMEOUT_MS);
          if (reverted.problems.length > 0) {
            // The condition's own run and capture stay — they were measured
            // under the state they report — but nothing after it may be
            // presented as an independent result on the original page.
            stopped = true;
            restorationFailed.push(condition.id);
            // A step that may still be in flight keeps the page: the last
            // restore waits for it instead of racing it.
            if (reverted.outstanding.length > 0) pending = allSettled(reverted.outstanding);
          }
        }
      }

      if (stopped) {
        // What was asked for and will not run, so a caller reading the meta
        // alone sees the whole requested set accounted for. One warning for
        // the stop was logged above; these are its consequence.
        for (const remaining of conditions.slice(index + 1)) {
          conditionsSkipped.push({
            condition: remaining.id,
            reason: `the pass stopped after it could not establish the page's state following ${condition.id}`,
          });
        }
        break;
      }
    }
  } finally {
    if (stopped && !pending) {
      // Last attempt at the original state, so the semantic pass and the
      // annotation step get as close to it as the page still allows. Only
      // when nothing of the pass is outstanding: a competing restore would
      // race work that still holds the page.
      const result = await revert(page, capabilities, null, CLEANUP_TIMEOUT_MS);
      if (result.problems.length > 0) {
        // Not the state the pass promised, so nothing may measure the page
        // as if it were.
        pageUnsafe = true;
        console.warn(`Rendering pass could not restore the page: ${result.problems.join(", ")}`);
      } else {
        console.warn("Rendering pass restored the page after it stopped early.");
      }
      if (result.outstanding.length > 0) pending = allSettled(result.outstanding);
    }

    if (pending) {
      // Not a restoration to report as done: the outstanding work can still
      // change the page after this.
      pageUnsafe = true;
      console.warn(
        `Rendering pass cannot establish the page's state while abandoned work from ${restorationFailed.join(", ")} is outstanding; the page is restored again once that work settles.`
      );
      // The adapter — and its CDP session — stay alive for that last
      // restore; it is what disposes of them.
      restoreWhenSettled(page, capabilities, pending, CLEANUP_TIMEOUT_MS);
    } else {
      const released = await cleanupStep(
        "the adapter release",
        () => capabilities.dispose(),
        CLEANUP_TIMEOUT_MS
      );
      if (released.problem) {
        console.warn(`Rendering pass could not release its browser adapter: ${released.problem}`);
      }
      // The semantic pass and the annotation step measure from the top.
      const settled = await cleanupStep(
        "the scroll to the top",
        () => settleCondition(page),
        SETTLE_CLEANUP_TIMEOUT_MS
      );
      if (settled.problem) {
        console.warn(
          `Rendering pass could not settle the page after the last condition: ${settled.problem}`
        );
      }
      // A scroll that has not answered can still move the page under a
      // measurement taken after the pass returned; one that failed leaves
      // the page wherever the last condition put it. Either way the later
      // page-dependent passes must not trust it.
      if (settled.outstanding || settled.problem) pageUnsafe = true;
    }
  }

  // ---- Pure evaluation, once every condition has been reverted ----

  const findings = new Map<RenderingConditionId, RenderingFinding[]>();
  const checksRun = new Set<string>();

  const collectFindings = (condition: RenderingConditionId, produced: RenderingFinding[]): void => {
    const existing = findings.get(condition);
    if (existing) existing.push(...produced);
    else findings.set(condition, [...produced]);
  };

  for (const condition of conditions) {
    const run = runs.get(condition.id);
    if (!run) continue;

    for (const check of perConditionChecks) {
      if (!check.appliesTo(condition)) continue;
      try {
        collectFindings(
          condition.id,
          check.evaluate({
            condition,
            measurement: run.measurement,
            onTruncated: () => markTruncated(condition.id),
          })
        );
        checksRun.add(check.id);
      } catch (error) {
        console.warn(`Rendering check ${check.id} failed under ${condition.id}: ${message(error)}`);
      }
    }
  }

  for (const check of crossChecks) {
    const target = runs.get(check.reportsUnder);
    const reference = runs.get(check.comparesWith);
    const condition = conditions.find((candidate) => candidate.id === check.reportsUnder);
    if (!target || !reference || !condition) continue;

    try {
      collectFindings(
        check.reportsUnder,
        check.evaluate({
          condition,
          measurement: target.measurement,
          reference: reference.measurement,
          onTruncated: () => markTruncated(check.reportsUnder),
        })
      );
      checksRun.add(check.id);
    } catch (error) {
      console.warn(
        `Rendering check ${check.id} failed under ${check.reportsUnder}: ${message(error)}`
      );
    }
  }

  if (truncated.length > 0) {
    console.warn(
      `Rendering measurement hit a collection cap under ${truncated.join(", ")}; those conditions report on what was measured.`
    );
  }

  const issues: Issue[] = [];
  for (const condition of conditionsRun) {
    const produced = findings.get(condition);
    if (!produced || produced.length === 0) continue;
    issues.push(
      ...renderingIssues(produced, {
        condition,
        captureIndex: captureIndexes.get(condition) ?? -1,
        capture: runs.get(condition)?.capture,
      })
    );
  }

  return {
    issues,
    captures,
    meta: {
      conditionsRun,
      conditionsSkipped,
      checksRun: [...checksRun],
      durationMs: Date.now() - started,
      ...(restorationFailed.length > 0 ? { restorationFailed } : {}),
      ...(pageUnsafe ? { pageUnsafe: true } : {}),
      ...(truncated.length > 0 ? { truncatedConditions: truncated } : {}),
    },
  };
}

/**
 * Apply the condition, let it settle, measure it and capture it. Everything
 * that can fail for one condition lives here, so the caller's `finally` is
 * the only revert path.
 */
async function applyAndMeasure(
  page: BrowserPage,
  capabilities: RenderingCapabilities,
  condition: RenderingCondition,
  collect: ReturnType<typeof unionCollect>,
  context: { timeout?: number; token: ConditionToken; baseline: ReadonlySet<string> }
): Promise<ConditionRun> {
  const { timeout, token, baseline } = context;
  // Before every step, not only before the mutating ones: a chain the runner
  // has given up on must not reach the page again at all, and a result
  // measured after that is stale anyway.
  if (condition.viewport) {
    token.check();
    await capabilities.setViewport(condition.viewport);
  }
  if (condition.media) {
    token.check();
    await capabilities.emulateMedia(condition.media);
  }
  if (condition.visionDeficiency) {
    token.check();
    await capabilities.emulateVisionDeficiency(condition.visionDeficiency);
  }
  if (condition.textSpacing) {
    token.check();
    await applyTextSpacing(page);
  }

  token.check();
  await settleCondition(page);

  token.check();
  const measurement = await measureRendering(page, collect, { timeout });
  if (!isRenderingMeasurement(measurement)) {
    throw new Error("the measurement returned unexpected data");
  }

  // The second half of the measurement step: axe's own verdict under this
  // condition, for the checks that need one. It spends the condition's
  // budget, so a slow run costs this condition and nothing after it.
  if (collect.axeRules && collect.axeRules.length > 0) {
    token.check();
    measurement.axe = await runConditionAxe(page, {
      rules: collect.axeRules,
      indexOffset: nextMeasurementIdentity(measurement),
      baseline,
      // The axe run spans three browser steps of its own and keeps no clock:
      // the condition's budget bounds it, and the token stops it, so a run
      // the pass gave up waiting for is outstanding work like any other.
      token,
    });
  }

  token.check();
  const screenshot = await page.screenshot({
    type: "jpeg",
    quality: CAPTURE_QUALITY,
    fullPage: true,
  });

  token.check();

  const size = readImageSize(screenshot);
  if (!size) {
    // Without the image size there is no capture space to place rects in,
    // and the capture geometry would be a guess.
    throw new Error("the capture is not a PNG or JPEG whose size could be read");
  }

  return {
    measurement,
    screenshot,
    capture: captureSizeFrom(size, measurement.devicePixelRatio),
    meta: screenshotMetaFrom(size, measurement),
  };
}

/** What one restoration attempt left behind. */
interface RevertResult {
  /** What could not be undone, in the words the warnings carry. */
  problems: string[];
  /** Steps that did not answer in time; the page is still theirs. */
  outstanding: Promise<unknown>[];
}

/**
 * Undo what the condition changed — or, with no condition, everything the
 * pass can change. Each step is independent, so one that fails does not leave
 * the others undone; emulations go back to "no override" and the viewport to
 * what the page had before the pass.
 *
 * Every step is bounded from Node, so a browser that has stopped answering
 * cannot hold the pass. Returns what could not be undone, so the caller can
 * retry and, failing that, stop: a revert that silently failed would present
 * the next condition's measurements as if they came from the original page.
 * A step that is still outstanding comes back too, because a second restore
 * call would race it.
 */
async function revert(
  page: BrowserPage,
  capabilities: RenderingCapabilities,
  condition: RenderingCondition | null,
  timeoutMs: number
): Promise<RevertResult> {
  const problems: string[] = [];
  const outstanding: Promise<unknown>[] = [];

  const step = async (what: string, work: () => Promise<void>): Promise<void> => {
    const outcome = await cleanupStep(what, work, timeoutMs);
    if (outcome.problem) problems.push(outcome.problem);
    if (outcome.outstanding) outstanding.push(outcome.outstanding);
  };

  if (!condition || condition.textSpacing) {
    await step("the text-spacing override", () => removeTextSpacing(page));
  }
  if ((!condition || condition.visionDeficiency) && capabilities.supports.visionDeficiency) {
    await step("the vision-deficiency emulation", () =>
      capabilities.emulateVisionDeficiency("none")
    );
  }
  if ((!condition || condition.media) && capabilities.supports.media) {
    await step("the media emulation", () => capabilities.emulateMedia({}));
  }
  if ((!condition || condition.viewport) && capabilities.supports.viewport) {
    await step("the original viewport", () => capabilities.restoreViewport());
  }

  return { problems, outstanding };
}

/**
 * Keep ownership of work the pass gave up waiting for: when it finally
 * settles, put the page back once more and release the adapter. Best effort
 * by nature — the page may be closed by then — so every failure becomes the
 * one warning this logs, and nothing is thrown at a caller that has long
 * since returned.
 */
function restoreWhenSettled(
  page: BrowserPage,
  capabilities: RenderingCapabilities,
  pending: Promise<unknown>,
  timeoutMs: number
): void {
  const restore = async (): Promise<void> => {
    try {
      const { problems } = await revert(page, capabilities, null, timeoutMs);
      const settled = await cleanupStep(
        "the scroll to the top",
        () => settleCondition(page),
        Math.max(timeoutMs, SETTLE_CLEANUP_TIMEOUT_MS)
      );
      const failures = [...problems, ...(settled.problem ? [settled.problem] : [])];
      console.warn(
        failures.length > 0
          ? `Rendering pass could not restore the page after the abandoned work settled: ${failures.join(", ")}`
          : "Rendering pass restored the page after the abandoned work settled."
      );
    } catch (error) {
      console.warn(
        `Rendering pass could not restore the page after the abandoned work settled: ${message(error)}`
      );
    } finally {
      // Bounded like every other step: a page that never answers must not
      // leave a never-settling promise behind.
      await cleanupStep("the adapter release", () => capabilities.dispose(), timeoutMs);
    }
  };

  void pending.then(restore, restore);
}

/**
 * Revert the condition, once more if the first attempt failed. The result is
 * empty of problems when the page is back; anything else ends the pass.
 *
 * A first attempt with an outstanding step is not retried: a second call to
 * the same emulation while the first may still be in flight would race it,
 * and which of the two lands last is exactly what the pass cannot know.
 */
async function revertWithRetry(
  page: BrowserPage,
  capabilities: RenderingCapabilities,
  condition: RenderingCondition,
  timeoutMs: number
): Promise<RevertResult> {
  const first = await revert(page, capabilities, condition, timeoutMs);
  if (first.problems.length === 0) return first;

  if (first.outstanding.length > 0) {
    console.warn(
      `Rendering condition ${condition.id} could not be reverted (${first.problems.join(", ")}) and that work is still outstanding, so it is not attempted again; no further condition is run.`
    );
    return first;
  }

  const retry = await revert(page, capabilities, condition, timeoutMs);
  if (retry.problems.length === 0) {
    console.warn(
      `Rendering condition ${condition.id} needed a second attempt to revert: ${first.problems.join(", ")}`
    );
    return retry;
  }

  console.warn(
    `Rendering condition ${condition.id} could not be reverted (${retry.problems.join(", ")}); no further condition is run.`
  );
  return retry;
}
