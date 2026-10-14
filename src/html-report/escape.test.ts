import { describe, expect, it } from "bun:test";
import { escapeHtml, safeLinkHref, truncate } from "./escape.js";

describe("escapeHtml", () => {
  it("escapes the five characters that break out of text or attribute context", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("neutralizes a script payload", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralizes an attribute-breakout payload", () => {
    expect(escapeHtml('"><img src=x onerror=alert(1)>')).toBe(
      "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"
    );
  });

  it("escapes ampersands before anything else, so entities cannot be forged", () => {
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  it("leaves umlauts and other text untouched", () => {
    expect(escapeHtml("Größe der Fläche – 5 µm")).toBe("Größe der Fläche – 5 µm");
  });
});

describe("safeLinkHref", () => {
  it("accepts http and https URLs", () => {
    expect(safeLinkHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeLinkHref("http://example.com")).toBe("http://example.com");
    expect(safeLinkHref("  https://example.com  ")).toBe("https://example.com");
    expect(safeLinkHref("HTTPS://Example.com")).toBe("HTTPS://Example.com");
  });

  it("rejects every other scheme and shape", () => {
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "//example.com",
      "/relative/path",
      "mailto:someone@example.com",
      "java\nscript:alert(1)",
      "",
      "   ",
    ]) {
      expect(safeLinkHref(value)).toBeNull();
    }
  });

  it("rejects a missing URL", () => {
    expect(safeLinkHref(undefined)).toBeNull();
    expect(safeLinkHref(null)).toBeNull();
  });
});

describe("truncate", () => {
  it("leaves a short value alone", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("cuts a long value and marks the cut", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
});
