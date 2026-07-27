# Feishu Reasoning Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Codex reasoning summaries and tool calls in their original event order, with visible reasoning and one collapsed Feishu panel per tool.

**Architecture:** Extend progress events with a stable activity ID and append semantics, then let the turn reducer maintain a bounded ordered `activities` list while retaining legacy status collections. Render that list directly in the Feishu card, and explicitly request App Server reasoning summaries for every turn.

**Tech Stack:** TypeScript, Vitest, Codex App Server JSON-RPC, Feishu interactive cards.

## Global Constraints

- Only `item/reasoning/summaryTextDelta` may be exposed; raw `item/reasoning/textDelta` must be ignored.
- Activity order must remain reasoning 1, tool 1, reasoning 2, tool 2 as emitted.
- Reasoning is always expanded; each tool is a separate `collapsible_panel` with `expanded: false`.
- Keep at most 40 activity items per turn.
- Existing 2-second normal card coalescing and critical update behavior must remain unchanged.
- Persisted snapshots without `activities` must still render.

---

### Task 1: Map stable reasoning-summary progress events

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/codex/CodexEventMapper.ts`
- Modify: `src/codex/CodexRuntime.ts`
- Test: `tests/codex/CodexEventMapper.test.ts`

**Interfaces:**
- Produces: `AgentEvent` progress fields `activityId?: string` and `append?: boolean`.
- Produces: mapped progress notification with the same fields.

- [ ] **Step 1: Write failing mapper tests**

Add tests that map `item/reasoning/summaryTextDelta` with `itemId: "reason_1"` and `summaryIndex: 2` to `activityId: "reasoning:reason_1:2"`, `append: true`, and the delta text. Add a second assertion that `item/reasoning/textDelta` returns `undefined`.

- [ ] **Step 2: Run the mapper test and verify failure**

Run: `npx vitest run tests/codex/CodexEventMapper.test.ts`

Expected: FAIL because stable activity metadata is absent and raw text is currently mapped.

- [ ] **Step 3: Implement summary-only mapping**

Update the mapped progress variant and mapper:

```ts
| { kind: "progress"; threadId: string; turnId: string; activityId: string; text: string; append: true }

if (method === "item/reasoning/summaryTextDelta") {
  const text = stringValue(params.delta);
  const itemId = stringValue(params.itemId);
  const summaryIndex = numberValue(params.summaryIndex);
  if (text === undefined || !itemId || summaryIndex === undefined) return undefined;
  return {
    kind: "progress",
    threadId,
    turnId,
    activityId: `reasoning:${itemId}:${summaryIndex}`,
    text,
    append: true,
  };
}
```

Pass these fields through `CodexRuntime.emit`, and extend the progress `AgentEvent` type with optional fields so non-Codex runtimes remain compatible.

- [ ] **Step 4: Run the mapper and runtime unit tests**

Run: `npx vitest run tests/codex/CodexEventMapper.test.ts tests/codex/CodexRuntime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/runtime/types.ts src/codex/CodexEventMapper.ts src/codex/CodexRuntime.ts tests/codex/CodexEventMapper.test.ts
git commit -m "feat: map Codex reasoning summaries"
```

### Task 2: Maintain a chronological turn activity list

**Files:**
- Modify: `src/presentation/turnViewTypes.ts`
- Modify: `src/presentation/TurnStateReducer.ts`
- Test: `tests/presentation/TurnStateReducer.test.ts`

**Interfaces:**
- Produces: exported `TurnActivity` union and `TurnViewState.activities: TurnActivity[]`.
- Consumes: progress `activityId` and `append` fields from Task 1.

- [ ] **Step 1: Write a failing chronological reducer test**

Build the following event sequence and assert the activity kinds and IDs without relying on grouped tool collections:

```ts
progress({ activityId: "reasoning:r1:0", text: "分析仓库", append: true })
tool_started(tool("t1", "rg --files", "running"))
tool_updated(tool("t1", "rg --files", "completed", { output: "a.ts" }))
progress({ activityId: "reasoning:r2:0", text: "准备测试", append: true })
tool_started(tool("t2", "npm test", "running"))
```

Expected activities: `reasoning:r1:0`, `t1`, `reasoning:r2:0`, `t2`. Also send a second delta for `reasoning:r1:0` and assert it appends in place without changing order.

- [ ] **Step 2: Run the reducer test and verify failure**

Run: `npx vitest run tests/presentation/TurnStateReducer.test.ts`

Expected: FAIL because `activities` does not exist.

- [ ] **Step 3: Implement bounded activity upserts**

Add the union:

```ts
export type TurnActivity =
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolState };
```

Initialize `activities: []`. Implement `upsertReasoningActivity` and `upsertToolActivity` that update an existing item at its current index or append a new item, then retain the newest 40. Apply tool upserts in both `tool_started` and `tool_updated` paths. Preserve `progressText` as a compatibility snapshot field, but use activities for new rendering.

- [ ] **Step 4: Run the reducer tests**

Run: `npx vitest run tests/presentation/TurnStateReducer.test.ts`

Expected: PASS, including the existing bounds and tool-history assertions.

- [ ] **Step 5: Commit**

```powershell
git add src/presentation/turnViewTypes.ts src/presentation/TurnStateReducer.ts tests/presentation/TurnStateReducer.test.ts
git commit -m "feat: preserve turn activity order"
```

### Task 3: Render visible reasoning and one collapsed panel per tool

**Files:**
- Modify: `src/feishu/CardRenderer.ts`
- Test: `tests/feishu/CardRenderer.test.ts`

**Interfaces:**
- Consumes: `TurnViewState.activities` from Task 2.
- Produces: one top-level Markdown element per reasoning item and one top-level collapsed panel per tool item.

- [ ] **Step 1: Write failing renderer tests**

Create four activities in reasoning/tool/reasoning/tool order. Assert:

```ts
expect(topLevelElements.map((element) => element.tag)).toContainSequence([
  "markdown",
  "collapsible_panel",
  "markdown",
  "collapsible_panel",
]);
expect(toolPanels).toHaveLength(2);
expect(toolPanels.every((panel) => panel.expanded === false)).toBe(true);
```

Assert each panel contains only its own command/output details, and that no grouped headers such as `已完成的工具（2）` appear.

- [ ] **Step 2: Run the renderer test and verify failure**

Run: `npx vitest run tests/feishu/CardRenderer.test.ts`

Expected: FAIL because tools are grouped and active/failed panels may be expanded.

- [ ] **Step 3: Implement timeline rendering**

Render each activity with:

```ts
function renderActivity(activity: TurnActivity): Record<string, unknown> {
  if (activity.kind === "reasoning") {
    return markdown(`**💭 思考**\n${truncateText(activity.text, 2_000)}`);
  }
  return toolPanel(activity.tool);
}
```

Make `toolPanel(tool)` produce a single `collapsible_panel` with `expanded: false`, a one-line status/title header, status template, and `renderToolDetails(tool)` inside. For snapshots without activities, synthesize a legacy list from `progressText`, `activeTool`, `failedTools`, and `completedTools` so old records remain viewable.

- [ ] **Step 4: Run renderer and presenter tests**

Run: `npx vitest run tests/feishu/CardRenderer.test.ts tests/feishu/FeishuTurnPresenter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/feishu/CardRenderer.ts tests/feishu/CardRenderer.test.ts
git commit -m "feat: render chronological Feishu activity"
```

### Task 4: Request reasoning summaries from App Server

**Files:**
- Modify: `src/codex/CodexRuntime.ts`
- Test: `tests/codex/CodexRuntime.test.ts`

**Interfaces:**
- Changes the existing `turn/start` request by adding `summary: "auto"`.

- [ ] **Step 1: Write a failing runtime request test**

After `startTurn`, find the `turn/start` request and assert:

```ts
expect(turnStart.params).toEqual(expect.objectContaining({ summary: "auto" }));
```

- [ ] **Step 2: Run the runtime test and verify failure**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts`

Expected: FAIL because the request currently omits `summary`.

- [ ] **Step 3: Add the App Server request parameter**

Add `summary: "auto"` to `turn/start`. Do not add it to thread resume, and do not change reasoning effort or model selection.

- [ ] **Step 4: Run runtime tests**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/codex/CodexRuntime.ts tests/codex/CodexRuntime.test.ts
git commit -m "feat: request Codex reasoning summaries"
```

### Task 5: Compatibility and end-to-end verification

**Files:**
- Modify only if a verification failure exposes a requirement gap.

**Interfaces:**
- Validates the complete implementation without changing delivery idempotency or update cadence.

- [ ] **Step 1: Run focused tests**

Run: `npx vitest run tests/codex/CodexEventMapper.test.ts tests/codex/CodexRuntime.test.ts tests/presentation/TurnStateReducer.test.ts tests/feishu/CardRenderer.test.ts tests/feishu/FeishuTurnPresenter.test.ts`

Expected: all selected test files pass.

- [ ] **Step 2: Run full verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all tests pass, TypeScript reports no errors, and `dist` builds successfully.

- [ ] **Step 3: Restart the running feature server**

Stop only the known Agent Bot process tree, then launch `npm start` from the feature worktree with working directory `D:\dev\agent-bot` and `AGENT_BOT_CONFIG` pointing at the feature worktree `config.yaml`. Confirm the log contains a fresh `Feishu WebSocket connector started` entry.

- [ ] **Step 4: Verify the Feishu chain**

Use the existing bot chat to submit a prompt that causes at least two tool calls. Read the resulting interactive card and confirm visible reasoning Markdown alternates with separate collapsed tool panels. Confirm the final answer is sent once and resume does not resend it.

- [ ] **Step 5: Commit any verification-only corrections**

If corrections were required, commit only those focused changes with a descriptive `fix:` message. If no correction was required, leave the worktree clean.
