import { describe, expect, test } from "vitest";
import { splitMarkdown } from "../../src/presentation/splitMarkdown.js";

function hasBalancedFences(value: string): boolean {
  return (value.match(/^```/gm) ?? []).length % 2 === 0;
}

describe("splitMarkdown", () => {
  test("returns short text unchanged", () => {
    expect(splitMarkdown("hello", 100)).toEqual(["hello"]);
  });

  test("splits long fenced code into independently balanced chunks", () => {
    const input = `before\n\`\`\`ts\n${"const x = 1;\n".repeat(250)}\`\`\`\nafter`;
    const chunks = splitMarkdown(input, 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.every(hasBalancedFences)).toBe(true);
    expect(chunks.join("\n")).toContain("before");
    expect(chunks.join("\n")).toContain("after");
  });

  test("hard-splits a single oversized line without losing text", () => {
    const chunks = splitMarkdown("a".repeat(1_001), 250);
    expect(chunks.every((chunk) => chunk.length <= 250)).toBe(true);
    expect(chunks.join("")).toBe("a".repeat(1_001));
  });
});
