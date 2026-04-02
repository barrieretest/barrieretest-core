/**
 * Cookie consent banner detection and dismissal.
 *
 * Tries to dismiss cookie/consent banners before accessibility audits so they
 * don't interfere with test results or obscure page content in screenshots.
 *
 * Two strategies are applied in order:
 *   1. Well-known Consent Management Platform (CMP) selectors
 *   2. Text-based button matching (multilingual: EN + DE)
 *
 * The entire process is non-blocking — failures are logged and swallowed.
 */

import type { Page } from "puppeteer";

/** Max time the entire dismissal attempt may take before we bail out. */
const DISMISS_TIMEOUT_MS = 5_000;

/** Pause after a successful click so the banner animation/removal settles. */
const POST_DISMISS_WAIT_MS = 1_000;

// ---------------------------------------------------------------------------
// Strategy 1 — Known CMP selectors (most reliable, one evaluate round-trip)
// ---------------------------------------------------------------------------

const KNOWN_CMP_SELECTORS = [
  // OneTrust
  "#onetrust-accept-btn-handler",
  // Cookiebot
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  // CookieYes
  ".cky-btn-accept",
  // Klaro
  ".cm-btn-accept-all",
  ".cm-btn-accept",
  // TrustArc
  ".truste-consent-button",
  "#truste-consent-button",
  // Osano
  ".osano-cm-accept-all",
  // Quantcast / TCF
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  // WordPress GDPR Cookie Consent
  ".cli-btn-accept_all",
  // Complianz
  ".cmplz-accept",
  // Cookie Notice (WordPress)
  "#cookie-notice .cn-set-cookie",
  "#cookie-notice .cn-accept-cookie",
  // Borlabs Cookie
  "#BorlabsCookieBoxSaveButton",
  // Moove GDPR
  ".moove-gdpr-modal-allow-all",
  // Iubenda
  ".iubenda-cs-accept-btn",
  // Didomi
  "#didomi-notice-agree-button",
  // Axeptio
  '[data-consent="accept-all"]',
  // Sourcepoint
  'button[title="Accept All"]',
  'button[title="Accept all"]',
  // Usercentrics
  '[data-testid="uc-accept-all-button"]',
  // Google Consent
  'button[aria-label="Accept all"]',
  'button[aria-label="Alle akzeptieren"]',
  // Termly
  ".t-accept-all",
  // CookieFirst
  '[data-cookiefirst-action="accept"]',
  // Civic Cookie Control
  "#ccc-notify-accept",
  "#ccc-close",
  // Generic patterns commonly used by custom implementations
  "#cookie-accept",
  "#cookies-accept",
  ".cookie-accept",
  ".cookies-accept",
  "#accept-cookies",
  ".accept-cookies",
  '[data-action="accept-cookies"]',
  '[data-action="accept"]',
];

// ---------------------------------------------------------------------------
// Strategy 2 — Text-based button matching (EN + DE)
// ---------------------------------------------------------------------------

const ACCEPT_BUTTON_TEXTS = [
  // English
  "accept all",
  "accept cookies",
  "accept all cookies",
  "allow all",
  "allow all cookies",
  "allow cookies",
  "i agree",
  "agree to all",
  "i accept",
  "got it",
  "that's ok",
  // German (AT / DE market)
  "alle akzeptieren",
  "alle cookies akzeptieren",
  "cookies akzeptieren",
  "alles akzeptieren",
  "allen zustimmen",
  "einverstanden",
  "alle zulassen",
  "ich stimme zu",
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Find a visible element matching one of the known CMP selectors and click it
 * via Puppeteer (proper mouse-event dispatch).
 */
async function tryKnownCMPSelectors(page: Page): Promise<boolean> {
  // Single evaluate call: find the first visible matching selector.
  const matchedSelector: string | null = await page.evaluate((selectors: string[]) => {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return selector;
          }
        }
      } catch {
        // Invalid selector — skip.
      }
    }
    return null;
  }, KNOWN_CMP_SELECTORS);

  if (matchedSelector) {
    await page.click(matchedSelector);
    return true;
  }

  return false;
}

/**
 * Scan all interactive elements for common accept-cookie text patterns and
 * click the first visible match from within the page context.
 */
async function tryTextBasedDismissal(page: Page): Promise<boolean> {
  const clickedText: string | null = await page.evaluate((acceptTexts: string[]) => {
    const candidates = Array.from(
      document.querySelectorAll(
        'button, a, [role="button"], input[type="submit"], input[type="button"]'
      )
    );

    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      const value = (el.getAttribute("value") || "").toLowerCase();

      for (const pattern of acceptTexts) {
        if (
          text === pattern ||
          text.includes(pattern) ||
          ariaLabel === pattern ||
          ariaLabel.includes(pattern) ||
          value === pattern ||
          value.includes(pattern)
        ) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            (el as HTMLElement).click();
            return text || ariaLabel || value;
          }
        }
      }
    }

    return null;
  }, ACCEPT_BUTTON_TEXTS);

  if (clickedText) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to dismiss a cookie consent banner on the current page.
 *
 * Tries known CMP selectors first, then falls back to text-based matching.
 * The call is wrapped in a timeout so it never blocks the audit for long.
 *
 * @returns `true` if a banner was (likely) dismissed, `false` otherwise.
 *          After a successful dismissal the function waits
 *          {@link POST_DISMISS_WAIT_MS} for the UI to settle.
 */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  const attempt = async (): Promise<boolean> => {
    // Strategy 1 — known CMP selectors
    if (await tryKnownCMPSelectors(page)) return true;

    // Strategy 2 — text-based button matching
    if (await tryTextBasedDismissal(page)) return true;

    return false;
  };

  try {
    const dismissed = await Promise.race([attempt(), sleep(DISMISS_TIMEOUT_MS).then(() => false)]);

    if (dismissed) {
      await sleep(POST_DISMISS_WAIT_MS);
    }

    return dismissed;
  } catch {
    // Non-critical — swallow and move on.
    return false;
  }
}
