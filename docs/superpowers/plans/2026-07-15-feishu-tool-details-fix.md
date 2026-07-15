# Feishu Tool Details Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken Feishu details interaction and show concrete tool commands and bounded result summaries, including ACP compatibility.

**Architecture:** Keep the primary Feishu progress card as the source of truth and use its native collapsible panels for details. Normalize partial ACP tool events inside the ACP runtime adapter so all presenters receive complete `ToolState` objects. Migrate only the currently deployed legacy Feishu context operationally, preserving normal agent/session selection semantics in code.

**Tech Stack:** TypeScript, Vitest, Feishu interactive cards, ACP SDK, SQLite.

## Global Constraints

- Completed tools remain collapsed by default; active and failed tools remain expanded.
- Command and result summaries are bounded before card delivery.
- Do not replay already delivered final messages on resume.
- Do not change explicit `/use` or `/switch` semantics.

---

### Task 1: Self-contained Feishu tool details

**Files:**
- Modify: `tests/feishu/CardRenderer.test.ts`
- Modify: `src/feishu/CardRenderer.ts`

**Interfaces:**
- Consumes: `ToolState` fields `title`, `kind`, `command`, `output`, `error`, and `exitCode`.
- Produces: `CardRenderer.renderTurn(state)` cards with native collapsible detail panels and no `turn_details` action.

- [ ] **Step 1: Write the failing renderer test**

Add assertions that serialized cards contain `命令`, `结果摘要`, the exact command/output, and do not contain `turn_details` or `查看详情`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- tests/feishu/CardRenderer.test.ts`

Expected: FAIL because the current card still contains `turn_details` and omits explicit labels.

- [ ] **Step 3: Implement the minimal renderer change**

Remove the redundant detail/stop buttons, render `/cancel` guidance for active turns, retain approval actions only for explicit confirmation mode, and render a bounded labeled summary:

```ts
const command = tool.command ?? (tool.kind === "command" ? tool.title : undefined);
if (command) parts.push(`**命令**\n\`${escapeInline(command)}\``);
if (tool.output) parts.push(`**结果摘要**\n${truncateText(tool.output, 1_200)}`);
```

- [ ] **Step 4: Run the focused test and commit**

Run: `npm test -- tests/feishu/CardRenderer.test.ts`

Expected: PASS.

### Task 2: Preserve ACP command and output across partial updates

**Files:**
- Create: `tests/runtime/AcpRuntimeAdapter.test.ts`
- Modify: `src/runtime/AcpRuntimeAdapter.ts`

**Interfaces:**
- Consumes: ACP `tool_call` / `tool_call_update` payloads with `rawInput`, `content`, and `rawOutput`.
- Produces: complete `tool_started` / `tool_updated` events whose `ToolState` retains command/title and adds output/error/exit code.

- [ ] **Step 1: Write a failing captured-payload test**

Replay a start event containing `rawInput.Command` and `rawInput.Description`, followed by a completion event containing `content[].content.text` and `rawOutput.Output.stdout`; assert the final event retains the command and contains the output.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- tests/runtime/AcpRuntimeAdapter.test.ts`

Expected: FAIL because the adapter currently emits “ACP tool” without command or output.

- [ ] **Step 3: Implement normalized tool state merging**

Add a per-session map keyed by `toolCallId`, parse string fields case-insensitively from the observed ACP shapes, merge completion updates with prior start state, and clear per-session data when the turn/session completes.

- [ ] **Step 4: Run focused runtime and reducer tests**

Run: `npm test -- tests/runtime/AcpRuntimeAdapter.test.ts tests/presentation/TurnStateReducer.test.ts`

Expected: PASS.

### Task 3: Deploy and smoke-test the real Feishu path

**Files:**
- Modify operational state: `D:/dev/acp-bot/data/acp-bot.sqlite`
- No source file changes unless the smoke test exposes a new reproducible defect.

**Interfaces:**
- Consumes: deployed default agent `codex` and the existing chat context.
- Produces: a new current Codex session for the existing Feishu chat.

- [ ] **Step 1: Run full verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests pass and both compilation commands exit 0.

- [ ] **Step 2: Stop the current server gracefully**

Stop the running Node process before changing the live context record.

- [ ] **Step 3: Migrate the single Feishu context**

In one SQLite transaction, set its `default_agent` to `codex` and clear `current_session_id`; preserve all session and turn history rows.

- [ ] **Step 4: Restart and verify readiness**

Start the server with the feature worktree config and main `.env`; verify the Feishu WebSocket and local console startup log entries.

- [ ] **Step 5: Verify a real command turn**

Send a Feishu prompt that causes a shell command and verify the completed tool panel shows the concrete command and result summary without callback-only normal controls or resent historical final messages.
