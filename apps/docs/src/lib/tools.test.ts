import { describe, expect, it } from "vitest";

import { BROWSER_TOOL_GROUPS, BROWSER_TOOLS, TOOLS } from "./tools";

describe("browser tool groups", () => {
  it("derives every working tool exactly once from the registry", () => {
    const grouped = BROWSER_TOOL_GROUPS.flatMap((group) => group.tools);

    expect(grouped.map((tool) => tool.slug).sort()).toEqual(
      BROWSER_TOOLS.map((tool) => tool.slug).sort(),
    );
    expect(new Set(grouped.map((tool) => tool.slug)).size).toBe(
      BROWSER_TOOLS.length,
    );
    expect(BROWSER_TOOL_GROUPS.map((group) => group.category)).toEqual([
      "Excel",
      "PDF",
      "PowerPoint",
      "Database",
    ]);
  });

  it("assigns every registry operation to a category", () => {
    expect(TOOLS.every((tool) => tool.category.length > 0)).toBe(true);
  });
});
