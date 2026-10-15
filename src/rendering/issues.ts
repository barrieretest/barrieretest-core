/**
 * Rendering findings become ordinary issues.
 *
 * The only thing special about them is where their annotation lives: in the
 * coordinate space of their condition's capture, not of the page screenshot.
 * The rounding, the clipping and the reading-order mark numbering are the
 * ones `src/annotate/` uses, so a consumer draws both the same way.
 */

import {
  type CaptureSize,
  clipRect,
  type MarkCandidate,
  markNumbersInReadingOrder,
} from "../annotate/index.js";
import type { AnnotationRect, Issue, IssueAnnotation, RenderingConditionId } from "../types.js";
import type { RenderingFinding } from "./types.js";

export interface RenderingIssueContext {
  condition: RenderingConditionId;
  /** Index into the captures array; -1 when captures were not kept. */
  captureIndex: number;
  /** CSS px size of the capture; omitted when its size could not be read. */
  capture?: CaptureSize;
}

/**
 * Turn one condition's findings into issues, numbering the marks of that
 * capture from 1 in its own reading order.
 */
export function renderingIssues(
  findings: RenderingFinding[],
  context: RenderingIssueContext
): Issue[] {
  const rects = new Map<number, AnnotationRect>();
  const candidates: MarkCandidate[] = [];

  if (context.capture) {
    for (const finding of findings) {
      if (finding.pageLevel || !finding.rect || finding.elementIndex === undefined) continue;
      const rect = clipRect(finding.rect, context.capture);
      if (!rect) continue;
      // Findings carry their element's own rect, so the first one is the
      // canonical one; keeping it is what makes the mark the numbering
      // placed and the rect the annotation draws the same rectangle.
      if (!rects.has(finding.elementIndex)) rects.set(finding.elementIndex, rect);
      candidates.push({ elementIndex: finding.elementIndex, rect });
    }
  }

  const marks = markNumbersInReadingOrder(candidates);

  return findings.map((finding) => {
    const annotation: IssueAnnotation = {
      selector: finding.selector,
      state: "unresolved",
    };

    if (finding.anchored) annotation.anchored = true;

    if (finding.pageLevel) {
      annotation.state = "page";
    } else {
      const rect = finding.elementIndex === undefined ? undefined : rects.get(finding.elementIndex);
      const mark = finding.elementIndex === undefined ? undefined : marks.get(finding.elementIndex);
      if (rect && mark !== undefined) {
        annotation.state = "resolved";
        annotation.rect = rect;
        annotation.mark = mark;
      }
    }

    return {
      id: `render:${finding.checkId}`,
      impact: finding.impact,
      description: finding.description,
      help: finding.help,
      helpUrl: finding.helpUrl,
      failureSummary: finding.failureSummary,
      selector: finding.selector,
      nodes: finding.html ? [{ html: finding.html }] : [],
      rendering: {
        checkId: finding.checkId,
        condition: context.condition,
        captureIndex: context.captureIndex,
        evidence: finding.evidence,
      },
      annotation,
    };
  });
}
