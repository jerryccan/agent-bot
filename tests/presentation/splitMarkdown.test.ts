import { describe, expect, test } from "vitest";
import { splitMarkdown } from "../../src/presentation/splitMarkdown.js";

function hasBalancedFences(value: string): boolean {
  return (value.match(/^```/gm) ?? []).length % 2 === 0;
}

function tableCount(value: string): number {
  const lines = value.split("\n");
  return lines.filter((line, index) => (
    line.includes("|")
    && /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1] ?? "")
  )).length;
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

  test("moves a complete line to the next chunk instead of cutting its inline Markdown", () => {
    const inline = "Use `agentbot server status` before continuing.\n";
    const input = `${"x".repeat(55)}\n${inline}`;
    const chunks = splitMarkdown(input, 80);

    expect(chunks).toEqual([`${"x".repeat(55)}\n`, inline]);
  });

  test("does not split inline code, links, images, or emphasis markers", () => {
    const atoms = [
      "`agentbot task status 12`",
      "[任务详情](https://example.com/tasks/123?from=agent-bot)",
      "![执行截图](D:/dev/agent-bot/data/result.png)",
      "**需要完整显示的重点**",
      "~~已经废弃的选项~~",
    ];
    const input = `prefix ${atoms.join(" middle ")} suffix`;
    const chunks = splitMarkdown(input, 72);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 72)).toBe(true);
    expect(chunks.join("")).toBe(input);
    for (const atom of atoms) {
      expect(chunks.filter((chunk) => chunk.includes(atom))).toHaveLength(1);
    }
  });

  test("keeps links with nested destination parentheses intact", () => {
    const link = "[API](https://example.com/search?q=fn(value))";
    const input = `${"before ".repeat(5)}${link} after`;
    const chunks = splitMarkdown(input, 64);

    expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
    expect(chunks.join("")).toBe(input);
    expect(chunks.filter((chunk) => chunk.includes(link))).toHaveLength(1);
  });

  test("splits tables only between complete data rows and repeats column headers", () => {
    const rows = [
      `| 1 | ${"a".repeat(24)} |\n`,
      `| 2 | ${"b".repeat(24)} |\n`,
      `| 3 | ${"c".repeat(24)} |\n`,
    ];
    const input = `intro\n| Name | Value |\n| --- | --- |\n${rows.join("")}outro`;
    const chunks = splitMarkdown(input, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.join("\n").match(/\| Name \| Value \|/g)?.length).toBeGreaterThan(1);
    expect(chunks.slice(1).some((chunk) => chunk.startsWith("| Name | Value |\n| --- | --- |\n"))).toBe(true);
    for (const row of rows) {
      expect(chunks.filter((chunk) => chunk.includes(row.trimEnd()))).toHaveLength(1);
    }
  });

  test("does not parse table-looking text inside a fenced code block", () => {
    const input = `\`\`\`md\n| Name | Value |\n| --- | --- |\n${`| 1 | ${"x".repeat(30)} |\n`.repeat(4)}\`\`\``;
    const chunks = splitMarkdown(input, 80);

    expect(chunks.every(hasBalancedFences)).toBe(true);
    expect(chunks.join("\n").match(/\| Name \| Value \|/g)).toHaveLength(1);
  });

  test("moves a table away from the end of a full chunk with its first data row", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const chunks = splitMarkdown(`${"x".repeat(60)}\n${table}`, 80);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${"x".repeat(60)}\n`);
    expect(chunks[1]).toBe(table);
  });

  test("limits the number of Markdown tables in each chunk", () => {
    const tables = Array.from({ length: 9 }, (_, index) => [
      `### Table ${index + 1}\n`,
      "| Name | Value |\n",
      "| --- | --- |\n",
      `| item | ${index + 1} |\n`,
      "\n",
    ].join(""));
    const input = tables.join("");
    const chunks = splitMarkdown(input, 4_000, 5);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => tableCount(chunk) <= 5)).toBe(true);
    expect(chunks.map(tableCount)).toEqual([5, 4]);
    expect(chunks.join("")).toBe(input);
    expect(chunks[1]?.trimStart().startsWith("### Table 6")).toBe(true);
  });

  test("counts repeated headers when a long table also crosses the length limit", () => {
    const longTable = [
      "| Name | Value |\n",
      "| --- | --- |\n",
      ...Array.from({ length: 6 }, (_, index) => `| ${index + 1} | ${"x".repeat(28)} |\n`),
    ].join("");
    const trailingTable = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const chunks = splitMarkdown(`${longTable}\n${trailingTable}`, 100, 1);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.every((chunk) => tableCount(chunk) <= 1)).toBe(true);
    expect(chunks.at(-1)?.trimStart()).toBe(trailingTable);
  });
});
