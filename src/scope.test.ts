import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("open-source scope", () => {
  it("keeps paid product features out of the public API", () => {
    const source = readFileSync("src/index.ts", "utf-8");

    expect(source).not.toMatch(
      /from "\.\/(crawl|crawler|discovery|discover|payment|payments|mollie|email|emails|invoice|invoices|pdf|preview|order|orders)/
    );
  });

  it("keeps paid product dependencies out of the package", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const dependencies = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);

    const banned = [
      "@mollie/api-client",
      "stripe",
      "nodemailer",
      "mailgun.js",
      "@sendgrid/mail",
      "resend",
      "brevo",
      "sib-api-v3-sdk",
      "pdf-lib",
      "@react-pdf/renderer",
    ];

    for (const name of banned) {
      expect(dependencies.has(name)).toBe(false);
    }
  });

  it("documents the single-page scope", () => {
    const readme = readFileSync("README.md", "utf-8");

    expect(readme).toContain("Open-source core for single-page accessibility audits.");
    expect(readme).toContain("It does not include:");
  });
});
