# Feishu Compact Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant labels and explanatory prompts from Codex turn cards while preserving chronological reasoning and independently collapsed tool details.

**Architecture:** Keep the existing activity timeline and Feishu card components. Change the shared truncation primitive to a bounded trailing ellipsis, then simplify only the turn-card presentation helpers in `CardRenderer` so structured startup/status cards remain unchanged.

**Tech Stack:** TypeScript, Vitest, Feishu interactive cards.

## Global Constraints

- The colored card header is the only turn-status label; the body retains `耗时：` before the elapsed value.
- Reasoning summaries render as original text without a heading or icon.
- Every tool remains an independent panel with `expanded: false`.
- Tool details contain one code block with `$ ` before the command/tool name and the available result on the immediately following line.
- Truncated content ends with `...` and stays within its requested maximum length.
- Startup and structured status cards retain their field labels.

---

### Task 1: Bounded trailing-ellipsis truncation

**Files:**
- Create: `tests/utils/markdown.test.ts`
- Modify: `src/utils/markdown.ts`

**Interfaces:**
- Produces: `truncateText(text: string, maxLength?: number): string` with total-length bounds and a trailing `...`.

- [ ] **Step 1: Write the failing truncation tests**

```ts
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
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run tests/utils/markdown.test.ts`

Expected: FAIL because the current result exceeds the limit and contains the explanatory Chinese suffix.

- [ ] **Step 3: Implement the minimal bounded truncation**

```ts
export function truncateText(text: string, maxLength = 8000): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}
```

- [ ] **Step 4: Run the utility tests and verify GREEN**

Run: `npx vitest run tests/utils/markdown.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/utils/markdown.ts tests/utils/markdown.test.ts
git commit -m "feat: use compact text truncation"
```

### Task 2: Compact Codex turn rendering

**Files:**
- Modify: `tests/feishu/CardRenderer.test.ts`
- Modify: `src/feishu/CardRenderer.ts`

**Interfaces:**
- Consumes: bounded `truncateText` from Task 1.
- Produces: compact `renderTurn` and `renderTurnDetails` output with unchanged card JSON contracts.

- [ ] **Step 1: Write failing compact-card assertions**

Update the turn fixture with a command, output containing ANSI color, and long text. Assert that the serialized routine card:

```ts
expect(serialized).toContain("耗时：51.6s");
expect(serialized).toContain("先检查测试配置");
expect(serialized).toContain("```\\n$ npm test\\nall passed\\n```");
for (const label of ["状态", "思考", "工具", "命令", "退出码", "结果摘要", "错误摘要"]) {
  expect(serialized).not.toContain(label);
}
expect(serialized).not.toContain("完整内容请查看本地日志");
expect(serialized).not.toContain("/cancel");
```

Keep the chronological-order and one-collapsed-panel-per-tool assertions.

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `npx vitest run tests/feishu/CardRenderer.test.ts`

Expected: FAIL on the redundant labels and current labeled tool details.

- [ ] **Step 3: Implement compact rendering**

Apply these helper contracts:

```ts
function renderTurnSummary(state: TurnViewState): string {
  const elapsed = state.durationMs ?? Math.max(0, Date.now() - state.startedAt);
  return `耗时：${formatDuration(elapsed)}`;
}

function renderActivity(activity: TurnActivity): Record<string, unknown>[] {
  if (activity.kind === "reasoning") {
    const text = activity.text.trim();
    return text ? [markdown(truncateText(text, 2_000))] : [];
  }
  return [toolPanel(activity.tool)];
}
```

Make `renderToolDetails` return one unlabeled code block: `$ ` and the command/tool title first, then error/output/file summary on the immediately following line when present. Remove exit code and per-tool elapsed rendering. Remove the plan heading, routine turn-error heading, generated-response heading, and `/cancel` instruction. Add a local ANSI-removal helper before truncating code-block content.

```ts
function renderToolDetails(tool: ToolState): string {
  const command = tool.command ?? tool.title;
  const fileSummary = tool.files?.length
    ? tool.files.map((file) => `${file.path}  +${file.additions ?? 0} -${file.deletions ?? 0}`).join("\n")
    : undefined;
  const result = tool.error ?? tool.output ?? fileSummary;
  const commandText = truncateText(stripAnsi(command).trim(), 800);
  const resultText = result ? truncateText(stripAnsi(result).trim(), 1_200) : undefined;
  return codeBlock(
    [`$ ${commandText}`, resultText].filter((part): part is string => part !== undefined).join("\n"),
    2_003,
  );
}

function codeBlock(value: string, maxLength: number): string {
  const clean = stripAnsi(value).trim();
  return `\`\`\`\n${truncateText(clean, maxLength).replaceAll("\`\`\`", "''' ")}\n\`\`\``;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}
```

Change the surrounding elements exactly as follows:

```ts
if (state.plan.length > 0) {
  elements.push(markdown(state.plan.map(renderPlanStep).join("\n")));
}
if (state.error) elements.push(markdown(codeBlock(state.error, 2_000)));

// renderTurnDetails
...(state.plan.length ? [markdown(state.plan.map(renderPlanStep).join("\n"))] : []),
...(state.assistantText ? [markdown(truncateText(state.assistantText, 3_000))] : []),
```

Delete the non-terminal `/cancel` element. In approval content, keep `request.title` as the actionable text and render `request.command` through `codeBlock` rather than inline-code labeling.

- [ ] **Step 4: Run renderer and presenter tests**

Run: `npx vitest run tests/feishu/CardRenderer.test.ts tests/feishu/FeishuTurnPresenter.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/feishu/CardRenderer.ts tests/feishu/CardRenderer.test.ts
git commit -m "feat: compact Codex turn cards"
```

### Task 3: Full verification and live rollout

**Files:**
- Modify only if verification exposes a requirement gap.

**Interfaces:**
- Verifies the built server and Feishu rendering without changing message delivery or session-resume behavior.

- [ ] **Step 1: Run full verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all tests pass, TypeScript reports no errors, and the production build exits successfully.

- [ ] **Step 2: Restart the feature server**

Stop only the identified Agent Bot process tree. Start `<repo-root>\.worktrees\codex-app-server\dist\index.js` with working directory `<repo-root>`, hidden window, and `AGENT_BOT_CONFIG` pointing to the worktree config. Confirm a fresh `Feishu WebSocket connector started` log entry.

- [ ] **Step 3: Send and read back a production-renderer card**

Use the production `CardRenderer` to create a reasoning/tool/reasoning/tool sample, send it with bot identity, and read the same message back. Confirm that reasoning is raw text, tool panels are separate, each tool has one unlabeled command-and-result code block, and no explanatory truncation message appears.

- [ ] **Step 4: Confirm clean branch state**

Run: `git status --short --branch`

Expected: named feature branch with no uncommitted files.
