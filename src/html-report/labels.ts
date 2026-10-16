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
  summary: (
    onScreenshot: number,
    pageLevel: number,
    notLocated: number,
    underConditions: number
  ) => string;
  /**
   * The rendering conditions in plain words, keyed by condition part id. A
   * composite is named by joining the parts; an id that is not in here — a
   * result from a newer version — is shown as it is.
   */
  condition: Record<string, { title: string; note: string }>;
  /** Accessible name of one capture's scrollable panel. */
  capturePanel: (condition: string) => string;
  captureImageAlt: (page: string, condition: string, markCount: number) => string;
  captureNoFindings: string;
  captureNotLocated: string;
  /** Shown when the audit found nothing at all. */
  noIssues: string;
  /**
   * Shown in the main view when everything the audit found is a finding
   * under a rendering condition, which the capture sections below hold. The
   * clean-result sentence would contradict the counts above it.
   */
  onlyUnderConditions: string;
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
  summary: (onScreenshot, pageLevel, notLocated, underConditions) =>
    `${onScreenshot} on the screenshot · ${pageLevel} page-level · ${notLocated} not located` +
    (underConditions > 0 ? ` · ${underConditions} under rendering conditions` : ""),
  condition: {
    "viewport:320": {
      title: "At 320 px width",
      note: "Shows the page at 320 CSS px, which is what 1280 px at 400% zoom comes to (WCAG 1.4.10 Reflow).",
    },
    "viewport:360": {
      title: "At 360 px width",
      note: "Shows the page at the width of a common phone, 360 by 800 CSS px.",
    },
    "viewport:768": {
      title: "At 768 px width",
      note: "Shows the page at the width of a tablet, 768 by 1024 CSS px.",
    },
    "viewport:1280": {
      title: "At 1280 px width",
      note: "Shows the page at the desktop width the audit itself uses, as the baseline the narrower widths are compared with.",
    },
    "cvd:protanopia": {
      title: "Protanopia (red-green colour blindness)",
      note: "Simulates vision without working red cone cells: reds turn dark and olive, and red and green move together.",
    },
    "cvd:deuteranopia": {
      title: "Deuteranopia (red-green colour blindness)",
      note: "Simulates vision without working green cone cells, the most common colour-vision deficiency: red and green are hard to tell apart.",
    },
    "cvd:tritanopia": {
      title: "Tritanopia (blue-yellow colour blindness)",
      note: "Simulates vision without working blue cone cells: blue and yellow move together.",
    },
    "cvd:achromatopsia": {
      title: "Achromatopsia (no colour vision)",
      note: "Simulates vision without any colour: everything is left with its brightness alone.",
    },
    "cvd:reduced-contrast": {
      title: "Reduced contrast",
      note: "Simulates reduced contrast sensitivity, as it comes with cataracts or ageing eyes.",
    },
    "cvd:blurred-vision": {
      title: "Blurred vision",
      note: "Simulates blurred vision, as it comes with uncorrected refractive errors.",
    },
    "media:dark": {
      title: "Dark mode",
      note: "Shows the page as a reader who has asked their system for a dark colour scheme sees it (`prefers-color-scheme: dark`).",
    },
    "media:forced-colors": {
      title: "Forced colours (high contrast)",
      note: "Shows the page with the system's own palette replacing the author's colours, as in Windows High Contrast mode.",
    },
    "media:more-contrast": {
      title: "Increased contrast",
      note: "Shows the page as a reader who has asked their system for more contrast sees it (`prefers-contrast: more`).",
    },
    "media:reduced-motion": {
      title: "Reduced motion",
      note: "Shows the page as a reader who has asked their system to reduce motion sees it (`prefers-reduced-motion: reduce`).",
    },
    "text-spacing": {
      title: "Text spacing per WCAG 1.4.12",
      note: "Shows the page with the text spacing WCAG 1.4.12 asks it to survive: line height 1.5, letter spacing 0.12em, word spacing 0.16em and paragraph spacing twice the font size.",
    },
  },
  capturePanel: (condition) => `Capture: ${condition}`,
  captureImageAlt: (page, condition, markCount) =>
    markCount === 1
      ? `Screenshot of ${page} under "${condition}" with 1 marked element.`
      : `Screenshot of ${page} under "${condition}" with ${markCount} marked elements.`,
  captureNoFindings: "No findings under this condition.",
  captureNotLocated: "Not located in this capture",
  noIssues: "No accessibility issues were found.",
  onlyUnderConditions:
    "Nothing was found on the page as it is normally rendered. Every finding appears under one of the rendering conditions below.",
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
  summary: (onScreenshot, pageLevel, notLocated, underConditions) =>
    `${onScreenshot} in der Seitenansicht · ${pageLevel} seitenweit · ${notLocated} nicht verortet` +
    (underConditions > 0 ? ` · ${underConditions} unter Darstellungsbedingungen` : ""),
  condition: {
    "viewport:320": {
      title: "Bei 320 px Breite",
      note: "Zeigt die Seite bei 320 CSS-Pixeln Breite – das entspricht 1280 px bei 400 % Zoom (WCAG 1.4.10 Reflow).",
    },
    "viewport:360": {
      title: "Bei 360 px Breite",
      note: "Zeigt die Seite in der Breite eines üblichen Smartphones, 360 mal 800 CSS-Pixel.",
    },
    "viewport:768": {
      title: "Bei 768 px Breite",
      note: "Zeigt die Seite in der Breite eines Tablets, 768 mal 1024 CSS-Pixel.",
    },
    "viewport:1280": {
      title: "Bei 1280 px Breite",
      note: "Zeigt die Seite in der Desktop-Breite der Prüfung selbst – die Ausgangsgröße, mit der die schmaleren Breiten verglichen werden.",
    },
    "cvd:protanopia": {
      title: "Protanopie (Rot-Grün-Sehschwäche)",
      note: "Simuliert das Sehen ohne funktionierende Rot-Zapfen: Rottöne werden dunkel und oliv, Rot und Grün rücken zusammen.",
    },
    "cvd:deuteranopia": {
      title: "Deuteranopie (Rot-Grün-Sehschwäche)",
      note: "Simuliert das Sehen ohne funktionierende Grün-Zapfen, die häufigste Farbsehschwäche: Rot und Grün sind kaum zu unterscheiden.",
    },
    "cvd:tritanopia": {
      title: "Tritanopie (Blau-Gelb-Sehschwäche)",
      note: "Simuliert das Sehen ohne funktionierende Blau-Zapfen: Blau und Gelb rücken zusammen.",
    },
    "cvd:achromatopsia": {
      title: "Achromatopsie (vollständige Farbenblindheit)",
      note: "Simuliert das Sehen ohne jede Farbwahrnehmung: Es bleibt allein die Helligkeit.",
    },
    "cvd:reduced-contrast": {
      title: "Verringerte Kontrastwahrnehmung",
      note: "Simuliert eine verringerte Kontrastwahrnehmung, wie sie mit Grauem Star oder im Alter auftritt.",
    },
    "cvd:blurred-vision": {
      title: "Verschwommenes Sehen",
      note: "Simuliert verschwommenes Sehen, wie es bei unkorrigierten Fehlsichtigkeiten auftritt.",
    },
    "media:dark": {
      title: "Dunkelmodus",
      note: "Zeigt die Seite so, wie sie Lesende sehen, die am System ein dunkles Farbschema eingestellt haben (`prefers-color-scheme: dark`).",
    },
    "media:forced-colors": {
      title: "Erzwungene Farben (hoher Kontrast)",
      note: "Zeigt die Seite mit der Systempalette anstelle der Farben der Website, wie im Windows-Modus für hohen Kontrast.",
    },
    "media:more-contrast": {
      title: "Erhöhter Kontrast",
      note: "Zeigt die Seite so, wie sie Lesende sehen, die am System mehr Kontrast eingestellt haben (`prefers-contrast: more`).",
    },
    "media:reduced-motion": {
      title: "Reduzierte Bewegung",
      note: "Zeigt die Seite so, wie sie Lesende sehen, die am System weniger Bewegung eingestellt haben (`prefers-reduced-motion: reduce`).",
    },
    "text-spacing": {
      title: "Textabstände nach WCAG 1.4.12",
      note: "Zeigt die Seite mit den Textabständen, die sie nach WCAG 1.4.12 aushalten muss: Zeilenhöhe 1,5, Buchstabenabstand 0,12em, Wortabstand 0,16em und Absatzabstand doppelte Schriftgröße.",
    },
  },
  capturePanel: (condition) => `Aufnahme: ${condition}`,
  captureImageAlt: (page, condition, markCount) =>
    markCount === 1
      ? `Bildschirmfoto von ${page} unter „${condition}“ mit 1 markierten Element.`
      : `Bildschirmfoto von ${page} unter „${condition}“ mit ${markCount} markierten Elementen.`,
  captureNoFindings: "Keine Befunde unter dieser Bedingung.",
  captureNotLocated: "Nicht in dieser Aufnahme verortet",
  noIssues: "Es wurden keine Barrieren gefunden.",
  onlyUnderConditions:
    "In der normalen Darstellung der Seite wurde nichts gefunden. Alle Befunde treten unter den Darstellungsbedingungen weiter unten auf.",
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
