/**
 * Escaping for the HTML report.
 *
 * Every string that reaches the report originates in the audited page, an
 * engine or a model, so all of it goes through `escapeHtml` — there is no
 * second escaping path and no raw interpolation of result data anywhere in
 * the renderer.
 */

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape for text and for quoted attribute context alike. Quotes are escaped
 * too, so one function covers both and no caller has to pick.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

/**
 * The href to render for a URL that came from the audited page or a model, or
 * `null` when it must not become a link. Only absolute `http:` and `https:`
 * URLs qualify; `javascript:`, `data:` and relative values are shown as text.
 */
export function safeLinkHref(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

/** Shorten a snippet to `maxLength` characters, with a visible ellipsis. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}
