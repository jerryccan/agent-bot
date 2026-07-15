# Feishu Raw Tool Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve original tool commands and results in Feishu cards while bounding command length and retaining both ends of oversized results.

**Architecture:** Add a reusable bounded middle-truncation utility beside the existing trailing truncation helper. Keep command rendering on trailing truncation and switch only tool results to middle truncation before composing the existing single code block.

**Tech Stack:** TypeScript, Vitest, Feishu interactive-card Markdown.

## Global Constraints

- Commands use the original `tool.command` value, preserve internal whitespace and line breaks, and are limited to 800 characters.
- Results use the original `tool.error`, `tool.output`, or file summary value and are limited to 1,200 characters.
- Oversized results preserve both their beginning and end with `...` on its own line replacing the omitted middle.
- ANSI terminal control sequences and embedded Markdown fences remain sanitized.
- Each tool remains one collapsed panel containing one code block.

---

### Task 1: Bounded middle truncation

**Files:**
- Modify: `src/utils/markdown.ts`
- Test: `tests/utils/markdown.test.ts`

**Interfaces:**
- Produces: `truncateMiddle(text: string, maxLength?: number, marker?: string): string`

- [x] **Step 1: Write the failing tests**

```ts
import { truncateMiddle, truncateText } from "../../src/utils/markdown.js";

test("keeps both ends of oversized text within the limit", () => {
  expect(truncateMiddle("abcdefghijklmnop", 12)).toBe("abcd\n...\nnop");
  expect(truncateMiddle("abcdefghijklmnop", 12)).toHaveLength(12);
});

test("returns short text unchanged and handles limits smaller than the marker", () => {
  expect(truncateMiddle("short", 12)).toBe("short");
  expect(truncateMiddle("abcdef", 2)).toBe("..");
});
```

- [x] **Step 2: Run the utility test and verify RED**

Run: `npx vitest run tests/utils/markdown.test.ts`

Expected: FAIL because `truncateMiddle` is not exported.

- [x] **Step 3: Implement the minimal helper**

```ts
export function truncateMiddle(text: string, maxLength = 8000, marker = "\n...\n"): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  if (maxLength <= marker.length) return ".".repeat(maxLength);
  const retainedLength = maxLength - marker.length;
  const headLength = Math.ceil(retainedLength / 2);
  const tailLength = Math.floor(retainedLength / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}
```

- [x] **Step 4: Run the utility test and verify GREEN**

Run: `npx vitest run tests/utils/markdown.test.ts`

Expected: all utility tests pass.

---

### Task 2: Raw command and head-tail result rendering

**Files:**
- Modify: `src/feishu/CardRenderer.ts`
- Test: `tests/feishu/CardRenderer.test.ts`

**Interfaces:**
- Consumes: `truncateMiddle(text: string, maxLength?: number): string`
- Preserves: one `collapsible_panel` and one Markdown code block per tool.

- [x] **Step 1: Write the failing renderer test**

Create a completed command with an 810-character multiline command and a result containing unique beginning and ending sentinels around more than 1,200 characters. Assert the command begins with `$ `, keeps its original internal newline, ends with `...`, the result contains both sentinels and `\n...\n`, and the omitted middle sentinel is absent.

- [x] **Step 2: Run the renderer test and verify RED**

Run: `npx vitest run tests/feishu/CardRenderer.test.ts`

Expected: FAIL because the current result truncation discards the ending sentinel.

- [x] **Step 3: Switch only result truncation to the middle helper**

```ts
import { truncateMiddle, truncateText } from "../utils/markdown.js";

const commandText = truncateText(stripAnsi(command).trim(), 800);
const resultText = result ? truncateMiddle(stripAnsi(result).trim(), 1_200) : undefined;
```

Keep the existing `$ ${commandText}` prefix and newline join with the result.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/utils/markdown.test.ts tests/feishu/CardRenderer.test.ts`

Expected: all focused tests pass.

- [x] **Step 5: Run full verification**

Run: `npm test`, `npm run typecheck`, and `npm run build`.

Expected: all tests pass and both TypeScript commands exit successfully.

- [x] **Step 6: Commit and deploy**

```text
git add src/utils/markdown.ts tests/utils/markdown.test.ts src/feishu/CardRenderer.ts tests/feishu/CardRenderer.test.ts docs/superpowers/plans/2026-07-15-feishu-raw-tool-output.md
git commit -m "feat: preserve tool output boundaries"
```

Restart the feature server, confirm `Feishu WebSocket connector started`, send a production-rendered oversized-result card, and verify the generated card contains the beginning, `...`, and ending content.
