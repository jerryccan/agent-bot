# Windows DPI-Aware Screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Codex screenshot commands capture the complete physical Windows desktop when display scaling is greater than 100%.

**Architecture:** Add one trusted, platform-specific screenshot rule to the existing Codex app-server thread lifecycle. Reuse the same instruction for new threads, restored threads, and lazy restoration after an app-server disconnect.

**Tech Stack:** TypeScript, Vitest, Codex app-server v2 JSON-RPC.

## Global Constraints

- Do not alter the user's prompt.
- Do not display the runtime instruction in Feishu cards.
- Do not add a background screenshot service or change system-wide DPI settings.
- Preserve existing thread history and resume behavior.

---

### Task 1: Attach DPI-aware screenshot instructions to every thread lifecycle path

**Files:**
- Modify: `tests/codex/CodexRuntime.test.ts`
- Modify: `src/codex/CodexRuntime.ts`

**Interfaces:**
- Produces: `WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS: string` used as `developerInstructions` in app-server thread requests.

- [ ] **Step 1: Write the failing protocol-level test**

Create and resume sessions through `CodexRuntime`, simulate an app-server disconnect, then start another turn. Assert every `thread/start` and `thread/resume` request contains `developerInstructions` with both `SetProcessDpiAwarenessContext` and `-4`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts`

Expected: FAIL because current thread requests omit `developerInstructions`.

- [ ] **Step 3: Implement the minimal runtime instruction**

Add a single constant explaining Per-Monitor DPI Aware V2 capture, and include `developerInstructions: WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS` in `thread/start` and both `thread/resume` request objects.

- [ ] **Step 4: Run focused and full verification**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts`, `npm test`, `npm run typecheck`, and `npm run build`.

Expected: all tests pass and both TypeScript commands exit successfully.

- [ ] **Step 5: Restart and run a live DPI capture**

Restart `acp-bot`, ask the active Feishu Codex session to capture the complete dual-monitor desktop, inspect the generated PNG dimensions, and confirm they equal the DPI-aware virtual bounds reported by Windows.

- [ ] **Step 6: Commit**

```text
git add src/codex/CodexRuntime.ts tests/codex/CodexRuntime.test.ts docs/superpowers/specs/2026-07-15-windows-dpi-aware-screenshot-design.md docs/superpowers/plans/2026-07-15-windows-dpi-aware-screenshot.md
git commit -m "fix: make Codex screenshots DPI aware"
```
