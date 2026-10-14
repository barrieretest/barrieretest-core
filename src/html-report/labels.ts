/**
 * Labels the report writes itself, per locale. Texts that came from the
 * engine, the model or the audited page are never translated here — only the
 * frame around them.
 */

import type { IssueSeverity, SeverityLevel } from "../types.js";

export type HtmlReportLocale = "en" | "de";

export const HTML_REPORT_LOCALES: readonly HtmlReportLocale[] = ["en", "de"];

export interface ReportLabels {
  /** `<title>` of the report document. */
  documentTitle: (page: string) => string;
  reportTitle: string;
  auditedPage: string;
  pageTitle: string;
  auditedAt: string;
  untitled: string;
  score: string;
  /**
   * The score's interpretation in the report's own language, per
   * `severityLevel`. Only locales that need their own copy carry it; English
   * uses the `scoreInterpretation` the result already has.
   */
  scoreInterpretation?: Record<SeverityLevel, { title: string; description: string }>;
  severityCounts: string;
  rules: {
    caption: string;
    rule: string;
    severity: string;
    occurrences: string;
  };
  severity: Record<IssueSeverity, string>;
  semanticAudit: string;
  tier: Record<"small" | "large", string>;
  screenshotHeading: string;
  imageAlt: (page: string, markCount: number) => string;
  findingsHeading: string;
  summary: (onScreenshot: number, pageLevel: number, notLocated: number) => string;
  noIssues: string;
  marker: (mark: number) => string;
  markerLink: (mark: number, issueCount: number) => string;
  showMarker: (mark: number) => string;
  ambiguous: string;
  pageLevelHeading: string;
  notLocatedHeading: string;
  allIssuesHeading: string;
  field: {
    rule: string;
    source: string;
    element: string;
    position: string;
    confidence: string;
    failure: string;
    code: string;
    suggestion: string;
    reference: string;
  };
  sourceEngine: string;
  sourceAi: (checkType: string) => string;
  percent: (value: number) => string;
  position: Record<"hidden" | "unresolved" | "none", string>;
  footer: string;
}

const EN: ReportLabels = {
  documentTitle: (page) => `Accessibility report – ${page}`,
  reportTitle: "Accessibility report",
  auditedPage: "Audited page",
  pageTitle: "Page title",
  auditedAt: "Audited",
  untitled: "(no title)",
  score: "Score",
  severityCounts: "Issues by severity",
  rules: {
    caption: "Findings by rule",
    rule: "Rule",
    severity: "Severity",
    occurrences: "Count",
  },
  severity: {
    critical: "Critical",
    serious: "Serious",
    moderate: "Moderate",
    minor: "Minor",
  },
  semanticAudit: "Semantic AI",
  tier: { small: "small model", large: "large model" },
  screenshotHeading: "Page screenshot",
  imageAlt: (page, markCount) =>
    markCount === 1
      ? `Screenshot of ${page} with 1 marked element.`
      : `Screenshot of ${page} with ${markCount} marked elements.`,
  findingsHeading: "Findings",
  summary: (onScreenshot, pageLevel, notLocated) =>
    `${onScreenshot} on the screenshot · ${pageLevel} page-level · ${notLocated} not located`,
  noIssues: "No accessibility issues were found.",
  marker: (mark) => `Marker ${mark}`,
  markerLink: (mark, issueCount) =>
    issueCount === 1 ? `Marker ${mark}, 1 issue` : `Marker ${mark}, ${issueCount} issues`,
  showMarker: (mark) => `Show marker ${mark}`,
  ambiguous: "This selector matched several elements; the marker shows the first one.",
  pageLevelHeading: "Page-level issues",
  notLocatedHeading: "Not located on the screenshot",
  allIssuesHeading: "All issues",
  field: {
    rule: "Rule",
    source: "Source",
    element: "Element",
    position: "Position",
    confidence: "Confidence",
    failure: "Why it fails",
    code: "Code",
    suggestion: "Suggestion",
    reference: "Reference",
  },
  sourceEngine: "Rule engine",
  sourceAi: (checkType) => `AI check (${checkType})`,
  percent: (value) => `${value}%`,
  position: {
    hidden: "Matched, but not visibly rendered in the capture",
    unresolved: "The selector could not be resolved on the page",
    none: "No position data",
  },
  footer: "Generated with barrieretest",
};

const DE: ReportLabels = {
  documentTitle: (page) => `Bericht zur Barrierefreiheit – ${page}`,
  reportTitle: "Bericht zur Barrierefreiheit",
  auditedPage: "Geprüfte Seite",
  pageTitle: "Seitentitel",
  auditedAt: "Geprüft am",
  untitled: "(kein Titel)",
  score: "Bewertung",
  scoreInterpretation: {
    excellent: {
      title: "Hervorragend",
      description:
        "Keine oder nur sehr wenige automatisch erkennbare Barrieren gefunden. Automatisierte Tests decken nur etwa 30–40 % aller WCAG-Kriterien ab.",
    },
    good: {
      title: "Gut",
      description:
        "Einige geringfügige Mängel gefunden. Sie sollten behoben werden, um die Barrierefreiheit weiter zu verbessern.",
    },
    "needs-improvement": {
      title: "Verbesserungsbedarf",
      description:
        "Mehrere Mängel gefunden, die die Barrierefreiheit beeinträchtigen. Eine professionelle Prüfung wird empfohlen.",
    },
    critical: {
      title: "Kritisch",
      description:
        "Viele Mängel gefunden, die die Nutzbarkeit für Menschen mit Behinderungen stark einschränken. Dringender Handlungsbedarf!",
    },
    severe: {
      title: "Gravierend",
      description:
        "Schwerwiegende Mängel gefunden. Die Website ist für viele Menschen mit Behinderungen nicht nutzbar. Sofortiger Handlungsbedarf!",
    },
  },
  severityCounts: "Befunde nach Schweregrad",
  rules: {
    caption: "Befunde nach Regel",
    rule: "Regel",
    severity: "Schweregrad",
    occurrences: "Anzahl",
  },
  severity: {
    critical: "Kritisch",
    serious: "Schwerwiegend",
    moderate: "Mittel",
    minor: "Gering",
  },
  semanticAudit: "Semantische KI-Prüfung",
  tier: { small: "kleines Modell", large: "großes Modell" },
  screenshotHeading: "Seitenansicht",
  imageAlt: (page, markCount) =>
    markCount === 1
      ? `Bildschirmfoto von ${page} mit 1 markierten Element.`
      : `Bildschirmfoto von ${page} mit ${markCount} markierten Elementen.`,
  findingsHeading: "Befunde",
  summary: (onScreenshot, pageLevel, notLocated) =>
    `${onScreenshot} in der Seitenansicht · ${pageLevel} seitenweit · ${notLocated} nicht verortet`,
  noIssues: "Es wurden keine Barrieren gefunden.",
  marker: (mark) => `Marker ${mark}`,
  markerLink: (mark, issueCount) =>
    issueCount === 1 ? `Marker ${mark}, 1 Befund` : `Marker ${mark}, ${issueCount} Befunde`,
  showMarker: (mark) => `Marker ${mark} anzeigen`,
  ambiguous: "Dieser Selektor traf mehrere Elemente; der Marker zeigt das erste.",
  pageLevelHeading: "Seitenweite Befunde",
  notLocatedHeading: "Nicht in der Seitenansicht verortet",
  allIssuesHeading: "Alle Befunde",
  field: {
    rule: "Regel",
    source: "Quelle",
    element: "Element",
    position: "Position",
    confidence: "Konfidenz",
    failure: "Warum es fehlschlägt",
    code: "Code",
    suggestion: "Vorschlag",
    reference: "Referenz",
  },
  sourceEngine: "Regelprüfung",
  sourceAi: (checkType) => `KI-Prüfung (${checkType})`,
  percent: (value) => `${value} %`,
  position: {
    hidden: "Getroffen, aber in der Aufnahme nicht sichtbar dargestellt",
    unresolved: "Der Selektor konnte auf der Seite nicht aufgelöst werden",
    none: "Keine Positionsdaten",
  },
  footer: "Erstellt mit barrieretest",
};

export const REPORT_LABELS: Record<HtmlReportLocale, ReportLabels> = { en: EN, de: DE };
