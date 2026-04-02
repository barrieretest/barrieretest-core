import { describe, expect, it } from "bun:test";

// Import the internal functions for unit testing
// We test the component name extraction logic here since it's pure

/**
 * Extracts a component name from an attribute value
 * (Copy of the internal function for testing)
 */
function extractComponentName(value: string): string | undefined {
  if (!value) return undefined;

  // If it looks like a PascalCase component name, use it directly
  if (/^[A-Z][a-zA-Z0-9]*$/.test(value)) {
    return value;
  }

  // Handle BEM-style: ComponentName__element or ComponentName--modifier
  const bemMatch = value.match(/^([A-Z][a-zA-Z0-9]*)(?:__|--)/);
  if (bemMatch) {
    return bemMatch[1];
  }

  // Handle kebab-case: component-name -> ComponentName
  if (value.includes("-") && /^[a-z]/.test(value)) {
    // Only convert if it looks like a component name (not a generic class like "btn-primary")
    if (!isGenericClassName(value)) {
      return kebabToPascal(value.split("__")[0].split("--")[0]);
    }
  }

  // Handle snake_case: component_name -> ComponentName
  if (value.includes("_") && /^[a-z]/.test(value)) {
    return snakeToPascal(value);
  }

  // Return the value as-is if it seems component-like
  if (/[A-Z]/.test(value) && value.length > 2) {
    return value;
  }

  return undefined;
}

function isGenericClassName(name: string): boolean {
  const genericPrefixes = [
    "btn",
    "col",
    "row",
    "flex",
    "grid",
    "text",
    "bg",
    "border",
    "p-",
    "m-",
    "w-",
    "h-",
    "mt-",
    "mb-",
    "ml-",
    "mr-",
    "pt-",
    "pb-",
    "pl-",
    "pr-",
    "px-",
    "py-",
    "mx-",
    "my-",
  ];
  return genericPrefixes.some((prefix) => name.startsWith(prefix));
}

function kebabToPascal(str: string): string {
  return str
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function snakeToPascal(str: string): string {
  return str
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

describe("extractComponentName", () => {
  describe("PascalCase names", () => {
    it("returns PascalCase names as-is", () => {
      expect(extractComponentName("UserProfile")).toBe("UserProfile");
      expect(extractComponentName("Button")).toBe("Button");
      expect(extractComponentName("NavBar")).toBe("NavBar");
    });
  });

  describe("BEM patterns", () => {
    it("extracts component from BEM block__element", () => {
      expect(extractComponentName("Header__nav")).toBe("Header");
      expect(extractComponentName("Button__icon")).toBe("Button");
    });

    it("extracts component from BEM block--modifier", () => {
      expect(extractComponentName("Button--primary")).toBe("Button");
      expect(extractComponentName("Card--highlighted")).toBe("Card");
    });
  });

  describe("kebab-case names", () => {
    it("converts kebab-case to PascalCase", () => {
      expect(extractComponentName("user-profile")).toBe("UserProfile");
      expect(extractComponentName("nav-bar")).toBe("NavBar");
    });

    it("skips generic class names", () => {
      expect(extractComponentName("btn-primary")).toBeUndefined();
      expect(extractComponentName("col-6")).toBeUndefined();
      expect(extractComponentName("text-center")).toBeUndefined();
    });
  });

  describe("snake_case names", () => {
    it("converts snake_case to PascalCase", () => {
      expect(extractComponentName("user_profile")).toBe("UserProfile");
      expect(extractComponentName("nav_bar")).toBe("NavBar");
    });
  });

  describe("mixed case names", () => {
    it("returns mixed case names with uppercase letters", () => {
      expect(extractComponentName("userProfile")).toBe("userProfile");
      expect(extractComponentName("navBar")).toBe("navBar");
    });
  });

  describe("edge cases", () => {
    it("returns undefined for empty string", () => {
      expect(extractComponentName("")).toBeUndefined();
    });

    it("returns undefined for short lowercase strings", () => {
      expect(extractComponentName("ab")).toBeUndefined();
    });

    it("returns undefined for generic utility patterns", () => {
      expect(extractComponentName("p-4")).toBeUndefined();
      expect(extractComponentName("m-2")).toBeUndefined();
    });
  });
});

describe("isGenericClassName", () => {
  it("identifies utility prefixes", () => {
    expect(isGenericClassName("btn-primary")).toBe(true);
    expect(isGenericClassName("col-6")).toBe(true);
    expect(isGenericClassName("flex-1")).toBe(true);
    expect(isGenericClassName("text-center")).toBe(true);
    expect(isGenericClassName("bg-white")).toBe(true);
  });

  it("rejects component-like names", () => {
    expect(isGenericClassName("user-profile")).toBe(false);
    expect(isGenericClassName("nav-bar")).toBe(false);
    expect(isGenericClassName("header-container")).toBe(false);
  });
});

describe("kebabToPascal", () => {
  it("converts kebab-case to PascalCase", () => {
    expect(kebabToPascal("user-profile")).toBe("UserProfile");
    expect(kebabToPascal("my-component")).toBe("MyComponent");
    expect(kebabToPascal("a-b-c")).toBe("ABC");
  });

  it("handles single word", () => {
    expect(kebabToPascal("user")).toBe("User");
  });
});

describe("snakeToPascal", () => {
  it("converts snake_case to PascalCase", () => {
    expect(snakeToPascal("user_profile")).toBe("UserProfile");
    expect(snakeToPascal("my_component")).toBe("MyComponent");
  });

  it("handles single word", () => {
    expect(snakeToPascal("user")).toBe("User");
  });
});
