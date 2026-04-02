import { describe, expect, it } from "bun:test";
import { analyzeSelector, extractAllComponentHints } from "./selector";

describe("analyzeSelector", () => {
  describe("CSS module patterns", () => {
    it("extracts component name from Next.js/Webpack CSS modules", () => {
      const result = analyzeSelector(".Header_nav__x7Hk2");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("Header");
      expect(result?.confidence).toBe("low");
    });

    it("extracts component name from styles_ prefix pattern", () => {
      const result = analyzeSelector(".styles_UserProfile__abc123");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("UserProfile");
    });
  });

  describe("PascalCase class names", () => {
    it("identifies PascalCase component names", () => {
      const result = analyzeSelector(".UserProfile");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("UserProfile");
    });

    it("identifies simple PascalCase names", () => {
      const result = analyzeSelector(".Button");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("Button");
    });
  });

  describe("BEM patterns", () => {
    it("extracts component from BEM block__element", () => {
      const result = analyzeSelector(".Header__nav");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("Header");
    });

    it("extracts component from BEM block--modifier", () => {
      const result = analyzeSelector(".Button--primary");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("Button");
    });
  });

  describe("utility class filtering", () => {
    it("skips Tailwind utility classes", () => {
      const result = analyzeSelector(".flex.items-center.justify-between");
      expect(result).toBeNull();
    });

    it("skips padding/margin utilities", () => {
      const result = analyzeSelector(".p-4.m-2.px-6");
      expect(result).toBeNull();
    });

    it("skips common layout utilities", () => {
      const result = analyzeSelector(".hidden.block.inline");
      expect(result).toBeNull();
    });
  });

  describe("ID extraction", () => {
    it("extracts component name from ID", () => {
      const result = analyzeSelector("#user-profile");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("UserProfile");
    });

    it("extracts component name from camelCase ID", () => {
      const result = analyzeSelector("#mainHeader");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("MainHeader");
    });
  });

  describe("complex selectors", () => {
    it("finds component in multi-class selector", () => {
      const result = analyzeSelector(".flex.Header_container__x7Hk2.p-4");
      expect(result).not.toBeNull();
      expect(result?.componentName).toBe("Header");
    });

    it("returns null for selectors with only utilities", () => {
      const result = analyzeSelector("div.flex.p-4 > span.text-sm");
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty selector", () => {
      expect(analyzeSelector("")).toBeNull();
    });

    it("returns null for tag-only selector", () => {
      expect(analyzeSelector("div")).toBeNull();
    });

    it("handles selector with no classes", () => {
      const result = analyzeSelector("div > span");
      expect(result).toBeNull();
    });
  });
});

describe("extractAllComponentHints", () => {
  it("extracts multiple component hints", () => {
    const hints = extractAllComponentHints(".Header_nav__abc.Footer");
    expect(hints).toContain("Header");
    expect(hints).toContain("Footer");
  });

  it("returns unique hints only", () => {
    const hints = extractAllComponentHints(".Header.Header_nav__abc");
    const headerCount = hints.filter((h) => h === "Header").length;
    expect(headerCount).toBe(1);
  });

  it("returns empty array for utility-only selectors", () => {
    const hints = extractAllComponentHints(".flex.p-4.m-2");
    expect(hints).toEqual([]);
  });

  it("returns empty array for empty selector", () => {
    expect(extractAllComponentHints("")).toEqual([]);
  });
});
