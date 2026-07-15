import { describe, expect, test } from "vitest";
import { truncateText } from "../../src/utils/markdown.js";

describe("truncateText", () => {
  test("uses a bounded trailing ellipsis without an explanatory message", () => {
    const result = truncateText("abcdefghij", 8);

    expect(result).toBe("abcde...");
    expect(result).toHaveLength(8);
    expect(result).not.toContain("已截断");
  });

  test("returns short text unchanged and handles very small limits", () => {
    expect(truncateText("short", 8)).toBe("short");
    expect(truncateText("abcdef", 2)).toBe("..");
  });
});
