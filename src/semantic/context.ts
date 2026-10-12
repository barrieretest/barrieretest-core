/**
 * HTML context extraction for semantic audits.
 *
 * Pulls page metadata + a curated set of element snippets out of a live
 * browser page so the LLM has structured input it can reason over without
 * being handed the entire DOM.
 *
 * Form fields and images are emitted as one compact line each, with the
 * accessible name already resolved in the browser (`element.labels`, ARIA,
 * enclosing link text). A truncated raw-HTML snippet hid exactly the
 * attributes a reviewer needs — a `<label for>` lives outside the element,
 * and a data-URI `src` eats the whole snippet before `alt` appears — which
 * produced "missing label" and "missing alt" findings for elements that had
 * both. ARIA and landmark elements still come through as raw snippets.
 *
 * Ported from `backend/src/core/ai-audit.ts:extractHTMLContext`.
 */

import type { BrowserPage } from "../browser.js";
import type { SemanticContextLimits, SemanticContextSection } from "./types.js";

export interface ExtractedContext {
  pageTitle: string;
  langAttr: string;
  headSnippet: string;
  bodySnippet: string;
  ariaElements: string[];
  formElements: string[];
  images: string[];
  landmarks: string[];
}

export const DEFAULT_CONTEXT_LIMITS: Required<SemanticContextLimits> = {
  headSnippetChars: 1000,
  bodySnippetChars: 5000,
  maxAriaElements: 50,
  maxFormElements: 50,
  maxImages: 40,
  maxLandmarks: 50,
};

interface ResolvedLimits {
  headSnippetChars: number;
  bodySnippetChars: number;
  maxAriaElements: number;
  maxFormElements: number;
  maxImages: number;
  maxLandmarks: number;
}

function resolveLimits(limits?: SemanticContextLimits): ResolvedLimits {
  return {
    ...DEFAULT_CONTEXT_LIMITS,
    ...(limits ?? {}),
  };
}

/**
 * Extract structured HTML context from a live page.
 *
 * Only the categories named in `sections` are populated; others come back
 * as empty strings/arrays. This keeps prompt size proportional to what the
 * selected checks actually need.
 */
export async function extractHtmlContext(
  page: BrowserPage,
  sections: SemanticContextSection[],
  limits?: SemanticContextLimits
): Promise<ExtractedContext> {
  const resolved = resolveLimits(limits);
  const sectionSet = new Set(sections);

  const args = {
    needsHead: sectionSet.has("head"),
    needsBody: sectionSet.has("body"),
    needsAria: sectionSet.has("aria"),
    needsForms: sectionSet.has("forms"),
    needsImages: sectionSet.has("images"),
    needsLandmarks: sectionSet.has("landmarks"),
    headSnippetChars: resolved.headSnippetChars,
    bodySnippetChars: resolved.bodySnippetChars,
    maxAriaElements: resolved.maxAriaElements,
    maxFormElements: resolved.maxFormElements,
    maxImages: resolved.maxImages,
    maxLandmarks: resolved.maxLandmarks,
  };

  return page.evaluate((opts) => {
    const doc = document;
    const pageTitle = doc.title;
    const langAttr = doc.documentElement.lang || "not specified";

    /**
     * Per-element caps. Structural parts are never truncated, free text is:
     * `alt` survives up to 1000 characters, a longer one is cut with an
     * ellipsis. A long description is legitimate and the judgement is about
     * its wording, so it reaches the model whole.
     */
    const SNIPPET_CHARS = 300;
    const LINE_CHARS = 300;
    const ALT_CHARS = 1000;
    const NAME_CHARS = 120;
    const SHORT_TEXT_CHARS = 80;
    /** `id`/`name` attributes, which sit in the never-truncated head. */
    const ID_CHARS = 60;

    /** Collapse whitespace and cap a free-text value. */
    const compact = (value: string | null | undefined, max: number): string => {
      const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
      return collapsed.length > max ? `${collapsed.substring(0, max)}…` : collapsed;
    };

    /**
     * Raw-markup snippet with `class` and `style` dropped, so the attributes
     * a reviewer needs (role, aria-*) survive the character cap.
     */
    const snippetOf = (el: Element): string =>
      el.outerHTML
        .substring(0, SNIPPET_CHARS * 4)
        .replace(/\s+(?:class|style)="[^"]*"/gi, "")
        .substring(0, SNIPPET_CHARS);

    /**
     * Append free-text parts to a structural head until `budget` is
     * reached, truncating the part that does not fit. The head always
     * survives in full. A caller that appends a structural tail of its own
     * passes a budget reduced by that tail.
     */
    const joinCapped = (head: string, parts: string[], budget = LINE_CHARS): string => {
      let line = head;
      for (const part of parts) {
        const candidate = `${line} | ${part}`;
        if (candidate.length <= budget) {
          line = candidate;
          continue;
        }
        const room = budget - line.length - 3;
        if (room > 1) {
          line = `${line} | ${part.substring(0, room - 1)}…`;
        }
        break;
      }
      return line;
    };

    /** Attribute as a free-text part, or "" when the attribute is absent/blank. */
    const attrPart = (el: Element, name: string, label: string, max: number): string => {
      const value = compact(el.getAttribute(name), max);
      return value ? `${label}: "${value}"` : "";
    };

    /** Text of the elements referenced by aria-labelledby. */
    const labelledByText = (el: Element): string => {
      const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      if (ids.length === 0) return "";
      const texts = ids.map((id) => doc.getElementById(id)?.textContent ?? "");
      return compact(texts.join(" "), NAME_CHARS);
    };

    const headSnippet = opts.needsHead
      ? doc.head.innerHTML.substring(0, opts.headSnippetChars)
      : "";

    const bodySnippet = opts.needsBody
      ? doc.body.innerHTML.substring(0, opts.bodySnippetChars)
      : "";

    const ariaElements: string[] = [];
    if (opts.needsAria) {
      doc.querySelectorAll("[aria-label], [aria-labelledby], [aria-describedby]").forEach((el) => {
        ariaElements.push(snippetOf(el));
      });
    }

    const formElements: string[] = [];
    if (opts.needsForms) {
      /**
       * Hidden from assistive technology, and therefore not part of a name
       * computed from an element's contents. An `aria-hidden` icon glyph or
       * a `display: none` label inside a button named the button after text
       * no screen reader announces.
       */
      const hiddenFromName = (el: Element): boolean => {
        if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return true;
        const style = getComputedStyle(el);
        return style.display === "none" || style.visibility === "hidden";
      };

      /** Text of an element's contents, skipping the subtrees that are hidden. */
      const visibleText = (root: Element): string => {
        let text = "";
        root.childNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent ?? "";
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const child = node as Element;
          if (hiddenFromName(child)) return;
          text += visibleText(child);
        });
        return text;
      };

      /** First descendant matching `selector` that no element below `root` hides. */
      const visibleDescendant = (root: Element, selector: string): Element | null => {
        for (const candidate of Array.from(root.querySelectorAll(selector))) {
          let node: Element | null = candidate;
          while (node && node !== root && !hiddenFromName(node)) {
            node = node.parentElement;
          }
          if (node === root) return candidate;
        }
        return null;
      };

      /** First non-empty <label>, which covers both `for=` and a wrapper. */
      const labelOf = (el: Element): { text: string; attachment: string } | null => {
        for (const label of Array.from((el as HTMLInputElement).labels ?? [])) {
          const text = compact(label.textContent, NAME_CHARS);
          if (!text) continue;
          const forAttr = label.getAttribute("for");
          return { text, attachment: forAttr ? `for=${forAttr}` : "wrapping" };
        }
        return null;
      };

      /**
       * Accessible name of a form control and where it came from. The field
       * is the computed accessible name, so ARIA wins: `aria-labelledby`,
       * then `aria-label`, then the native label. A control named by
       * anything other than a `<label>` — an icon button wrapping an
       * `<img alt>`, an `input[type=image]`, a bare `type=submit` with its
       * native "Submit" — was reported as `label: (none)` and judged as
       * unlabelled.
       */
      const resolveFieldName = (
        el: Element,
        tag: string,
        type: string,
        label: { text: string; attachment: string } | null
      ): { name: string; via: string } | null => {
        const labelledBy = labelledByText(el);
        if (labelledBy) return { name: labelledBy, via: "aria-labelledby" };

        const ariaLabel = compact(el.getAttribute("aria-label"), NAME_CHARS);
        if (ariaLabel) return { name: ariaLabel, via: "aria-label" };

        if (label) return { name: label.text, via: "label" };

        if (tag === "input" && type === "image") {
          const alt = compact(el.getAttribute("alt"), NAME_CHARS);
          if (alt) return { name: alt, via: "alt" };
        }

        if (tag === "button") {
          const text = compact(visibleText(el), NAME_CHARS);
          if (text) return { name: text, via: "text" };
          const imageAlt = compact(
            visibleDescendant(el, "img[alt]")?.getAttribute("alt"),
            NAME_CHARS
          );
          if (imageAlt) return { name: imageAlt, via: "alt" };
          const inner = compact(
            visibleDescendant(el, "[aria-label]")?.getAttribute("aria-label"),
            NAME_CHARS
          );
          if (inner) return { name: inner, via: "aria-label" };
        }

        const title = compact(el.getAttribute("title"), NAME_CHARS);
        if (title) return { name: title, via: "title" };

        // A push button is named by its own value, or by the native default
        // the browser supplies when there is none.
        if (tag === "input") {
          const value = compact(el.getAttribute("value"), NAME_CHARS);
          if (value && /^(?:submit|button|reset)$/.test(type)) {
            return { name: value, via: "value" };
          }
          if (type === "submit") return { name: "Submit", via: "default" };
          if (type === "reset") return { name: "Reset", via: "default" };
        }

        return null;
      };

      doc.querySelectorAll("input, select, textarea, button").forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const type =
          tag === "input" || tag === "button" ? (el as HTMLInputElement).type || "text" : "";
        if (tag === "input" && type === "hidden") return;

        const label = labelOf(el);
        const resolved = resolveFieldName(el, tag, type, label);

        // The name is part of the structural head, which survives in full:
        // a line cap that dropped it would read as "this field has no
        // accessible name" for a field that has one. Absence of a name is
        // stated explicitly for the same reason.
        const structure = [
          `<${tag}>`,
          type ? `type=${type}` : "",
          el.id ? `id=${compact(el.id, ID_CHARS)}` : "",
          el.getAttribute("name") ? `name=${compact(el.getAttribute("name"), ID_CHARS)}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const head = resolved
          ? `${structure} | name: "${resolved.name}" (via ${resolved.via})`
          : `${structure} | label: (none)`;

        // Every name source except the one that won, so a contradiction
        // between two of them stays visible without repeating the name.
        const via = resolved?.via;
        const labelledBy = labelledByText(el);
        const buttonText = tag === "button" ? compact(visibleText(el), SHORT_TEXT_CHARS) : "";
        const buttonValue =
          tag === "input" && /^(?:submit|button|reset)$/.test(type)
            ? compact(el.getAttribute("value"), SHORT_TEXT_CHARS)
            : "";
        const parts = [
          attrPart(el, "placeholder", "placeholder", SHORT_TEXT_CHARS),
          label && via !== "label" ? `label: "${label.text}" (${label.attachment})` : "",
          via === "aria-label" ? "" : attrPart(el, "aria-label", "aria-label", NAME_CHARS),
          labelledBy && via !== "aria-labelledby" ? `aria-labelledby: "${labelledBy}"` : "",
          via === "title" ? "" : attrPart(el, "title", "title", SHORT_TEXT_CHARS),
          buttonText && via !== "text" ? `text: "${buttonText}"` : "",
          buttonValue && via !== "value" ? `value: "${buttonValue}"` : "",
        ].filter(Boolean);

        formElements.push(joinCapped(head, parts));
      });
    }

    const images: string[] = [];
    let hiddenFromAssistiveTech = 0;
    let notRenderedAtViewport = 0;
    if (opts.needsImages) {
      /** Last non-empty path segment of a URL path, or "". */
      const lastSegment = (path: string): string => path.split("/").filter(Boolean).pop() ?? "";

      /** A malformed percent escape must not abort the whole extraction. */
      const safeDecode = (value: string): string => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };

      /** Value escaped for a CSS attribute selector’s double-quoted string. */
      const quoted = (value: string): string => value.replace(/[\\"]/g, "\\$&");

      /** True when `selector` addresses this element and nothing else. */
      const matchesOnly = (selector: string, el: Element): boolean => {
        try {
          const found = doc.querySelectorAll(selector);
          return found.length === 1 && found[0] === el;
        } catch {
          return false;
        }
      };

      /**
       * Position of the element among its same-tag siblings, which is what
       * `:nth-of-type` counts.
       */
      const positionSegment = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (!parent) return tag;
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
        return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})` : tag;
      };

      /**
       * Unique selector built from the element’s position, walking up until
       * the path addresses exactly one element. The nearest ancestor with an
       * id anchors the path when one exists, so the selector stays short and
       * survives changes further up the tree.
       */
      const structuralSelector = (el: Element): string => {
        const segments: string[] = [];
        let node: Element | null = el;
        while (node) {
          segments.unshift(positionSegment(node));
          const parent: Element | null = node.parentElement;
          if (parent?.id) {
            const anchored = `#${CSS.escape(parent.id)} > ${segments.join(" > ")}`;
            if (matchesOnly(anchored, el)) return anchored;
          }
          const candidate = segments.join(" > ");
          if (matchesOnly(candidate, el)) return candidate;
          node = parent;
        }
        return segments.join(" > ");
      };

      /**
       * How the image is addressed when its own attributes suffice: an id, or
       * its `src` — the last path segment for a normal URL, the MIME type for
       * a data URL, and the wrapped file name for a proxy such as
       * `/_next/image?url=…`, whose own last segment is just "image".
       */
      const attributeSelectorOf = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        if (el.id) return `${tag}#${CSS.escape(el.id)}`;
        if (tag !== "img") {
          const role = el.getAttribute("role");
          return role ? `${tag}[role="${quoted(role)}"]` : tag;
        }
        const src = el.getAttribute("src") ?? "";
        if (!src) return "img";
        if (/^data:/i.test(src)) {
          const comma = src.indexOf(",");
          const header = src.substring(5, comma === -1 ? src.length : comma);
          return `img[src^="data:${quoted(header.split(";")[0] || "unknown")}"]`;
        }
        const hashless = src.split("#")[0];
        const queryStart = hashless.indexOf("?");
        const path = queryStart === -1 ? hashless : hashless.substring(0, queryStart);
        if (queryStart !== -1) {
          const params = new URLSearchParams(hashless.substring(queryStart + 1));
          const wrapped = params.get("url") ?? params.get("src") ?? params.get("image");
          const basename = wrapped ? lastSegment(safeDecode(wrapped).split(/[?#]/)[0]) : "";
          return `img[src*="${quoted(basename || path)}"]`;
        }
        const segment = lastSegment(path);
        return `img[src${segment ? "$" : "*"}="${quoted(segment || path)}"]`;
      };

      /**
       * Where the image is, as a selector the model reports verbatim as
       * `location`, and which is verified against the live document before it
       * is handed over. An attribute selector can address nothing (a `src`
       * with a fragment does not end in its file name) or several elements
       * (images sharing a data URL, two files with the same base name), and
       * such a `location` sent a reader to the wrong element or to none.
       */
      const selectorOf = (el: Element): string => {
        const candidate = attributeSelectorOf(el);
        return matchesOnly(candidate, el) ? candidate : structuralSelector(el);
      };

      /** Text of an enclosing link or button, which can carry the name instead. */
      const hostPart = (el: Element): string => {
        const host = el.closest("a, button");
        if (!host) return "";
        const text = compact(host.textContent, SHORT_TEXT_CHARS);
        const kind = host.tagName.toLowerCase() === "a" ? "link" : "button";
        return text ? `inside ${kind} with text "${text}"` : "";
      };

      /**
       * `Image N: alt text = … | accessible name = … | … | selector = … | WxH`.
       * The alt comes first and labelled, and the `src` only ever appears
       * inside the selector: shown as a bare `src=…` head, the small model
       * read the shortened file name as the image's alt text. Alt, name and
       * selector are structural — the first two are what the check judges,
       * the last what it must report — so only the middle free-text parts
       * give way to the cap.
       */
      const imageLine = (
        altValue: string,
        namePart: string,
        middle: string[],
        selector: string,
        size: string
      ): string => {
        const tail = [`selector = ${selector}`, size]
          .filter(Boolean)
          .map((part) => ` | ${part}`)
          .join("");
        const head = `Image ${images.length + 1}: alt text = ${altValue}${
          namePart ? ` | ${namePart}` : ""
        }`;
        return joinCapped(head, middle, Math.max(head.length, LINE_CHARS - tail.length)) + tail;
      };

      /**
       * Accessible name of an `<img>` and where it came from, in the order
       * the name computation resolves it: ARIA before `alt`, `title` last.
       * An `alt=""` next to an `aria-label` reached the model as `(empty)`
       * alone and read as an unnamed image.
       */
      const imageName = (el: Element, altText: string): { name: string; via: string } | null => {
        const labelledBy = labelledByText(el);
        if (labelledBy) return { name: labelledBy, via: "aria-labelledby" };
        const ariaLabel = compact(el.getAttribute("aria-label"), ALT_CHARS);
        if (ariaLabel) return { name: ariaLabel, via: "aria-label" };
        if (altText) return { name: altText, via: "alt" };
        const title = compact(el.getAttribute("title"), ALT_CHARS);
        if (title) return { name: title, via: "title" };
        return null;
      };

      const seen = new Set<Element>();
      doc.querySelectorAll('img, svg[role="img"], [role="img"]').forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);

        // An image the viewport does not render — a `<picture>` variant the
        // media query drops, an icon in a closed menu — cannot be checked
        // against the screenshot, and the variants of one photo read as
        // several images sharing an alt text.
        const style = getComputedStyle(el);
        if (
          el.getClientRects().length === 0 ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          notRenderedAtViewport += 1;
          return;
        }

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const ariaHidden = el.getAttribute("aria-hidden");
        const rolePart = role ? `role=${role}` : "";
        const hiddenPart = ariaHidden ? `aria-hidden=${ariaHidden}` : "";

        // `aria-hidden` on the element or on any ancestor, and a
        // presentational role, remove the graphic from the accessibility
        // tree, so it has no accessible name to judge however its `alt` or
        // `<title>` reads. Listing it only invited findings against that
        // declaration, including "redundant alt" for a hidden image. The test
        // runs before the branch by graphic type, so it also covers an
        // `svg[role="img"]` and an icon inside an aria-hidden wrapper.
        const normalizedRole = (role ?? "").toLowerCase();
        if (
          normalizedRole === "presentation" ||
          normalizedRole === "none" ||
          el.closest('[aria-hidden="true"]') !== null
        ) {
          hiddenFromAssistiveTech += 1;
          return;
        }

        if (tag !== "img") {
          // Non-<img> graphics are named by ARIA or an <svg><title>, not by
          // `alt`. Their name is reported as `alt text` all the same, so
          // the model judges every image name the same way. A graphic that
          // declares itself an image and has no name is the missing-name
          // case the check exists for, so it is listed, not dropped.
          const name =
            compact(el.getAttribute("aria-label"), ALT_CHARS) ||
            labelledByText(el) ||
            compact(el.querySelector("title")?.textContent, ALT_CHARS);
          images.push(
            imageLine(
              name ? `"${name}"` : "(missing)",
              "",
              [rolePart, hiddenPart, hostPart(el)].filter(Boolean),
              selectorOf(el),
              ""
            )
          );
          return;
        }

        const img = el as HTMLImageElement;

        const altAttr = img.getAttribute("alt");
        const altText = compact(altAttr, ALT_CHARS);

        const altValue = altAttr === null ? "(missing)" : altText ? `"${altText}"` : "(empty)";

        // Only when it adds something the alt does not already say.
        const resolvedName = imageName(img, altText);
        const namePart =
          resolvedName && resolvedName.name !== altText
            ? `accessible name = "${resolvedName.name}" (via ${resolvedName.via})`
            : "";

        // Declared dimensions first: they describe the rendered image, while
        // `naturalWidth` reports 150x150 for any SVG without an intrinsic size.
        const width = Number(img.getAttribute("width")) || img.naturalWidth || 0;
        const height = Number(img.getAttribute("height")) || img.naturalHeight || 0;
        const sizePart = width && height ? `${width}x${height}` : "";

        images.push(
          imageLine(
            altValue,
            namePart,
            [rolePart, hiddenPart, hostPart(img)].filter(Boolean),
            selectorOf(img),
            sizePart
          )
        );
      });
    }

    const landmarks: string[] = [];
    if (opts.needsLandmarks) {
      doc.querySelectorAll("main, nav, aside, header, footer, [role]").forEach((el) => {
        landmarks.push(snippetOf(el));
      });
    }

    // The caps apply to the listed elements; the closing notes state how
    // many were left out, so the model cannot read the list as complete.
    const listedFormElements = formElements.slice(0, opts.maxFormElements);
    if (formElements.length > listedFormElements.length) {
      listedFormElements.push(
        `(${formElements.length - listedFormElements.length} more form elements not listed)`
      );
    }

    const listedImages = images.slice(0, opts.maxImages);
    if (images.length > listedImages.length) {
      listedImages.push(`(${images.length - listedImages.length} more images not listed)`);
    }
    if (hiddenFromAssistiveTech > 0) {
      listedImages.push(
        `(${hiddenFromAssistiveTech} images hidden from assistive technology via aria-hidden or role=presentation are not listed)`
      );
    }
    if (notRenderedAtViewport > 0) {
      listedImages.push(
        `(${notRenderedAtViewport} images not rendered at this viewport are not listed)`
      );
    }

    return {
      pageTitle,
      langAttr,
      headSnippet,
      bodySnippet,
      ariaElements: ariaElements.slice(0, opts.maxAriaElements),
      formElements: listedFormElements,
      images: listedImages,
      landmarks: landmarks.slice(0, opts.maxLandmarks),
    };
  }, args);
}

/**
 * Format an `ExtractedContext` as a structured plain-text block suitable for
 * inclusion in an LLM prompt. Sections that weren't extracted are omitted.
 *
 * `sections` narrows the output to the categories named, which is how one
 * extraction for the union of all checks is handed to a single tier: a tier
 * that only judges images found its images again in the body snippet, the
 * ARIA list and the landmark snippets, and reported them from there. The
 * title and lang lines are page facts and always included.
 */
export function formatExtractedContext(
  context: ExtractedContext,
  sections?: SemanticContextSection[]
): string {
  const includes = (section: SemanticContextSection): boolean =>
    sections === undefined || sections.includes(section);

  const parts: string[] = [
    `Page Title: ${context.pageTitle}`,
    `Lang Attribute: ${context.langAttr}`,
  ];

  if (includes("head") && context.headSnippet) {
    parts.push("", "=== HEAD (snippet) ===", context.headSnippet);
  }
  if (includes("body") && context.bodySnippet) {
    parts.push("", "=== BODY (snippet) ===", context.bodySnippet);
  }
  if (includes("aria") && context.ariaElements.length > 0) {
    parts.push("", "=== ARIA ELEMENTS ===", context.ariaElements.join("\n"));
  }
  if (includes("forms") && context.formElements.length > 0) {
    parts.push("", "=== FORM ELEMENTS ===", context.formElements.join("\n"));
  }
  if (includes("images") && context.images.length > 0) {
    parts.push("", "=== IMAGES ===", context.images.join("\n"));
  }
  if (includes("landmarks") && context.landmarks.length > 0) {
    parts.push("", "=== LANDMARKS ===", context.landmarks.join("\n"));
  }

  return parts.join("\n");
}
