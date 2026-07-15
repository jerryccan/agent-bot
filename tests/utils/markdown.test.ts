import { describe, expect, test } from "vitest";
import { truncateMiddle, truncateText } from "../../src/utils/markdown.js";

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

describe("truncateMiddle", () => {
  test("keeps both ends of oversized text within the limit", () => {
    const result = truncateMiddle("abcdefghijklmnop", 12);

    expect(result).toBe("abcd\n...\nnop");
    expect(result).toHaveLength(12);
  });

  test("returns short text unchanged and handles very small limits", () => {
    expect(truncateMiddle("short", 12)).toBe("short");
    expect(truncateMiddle("abcdef", 2)).toBe("..");
  });
});
