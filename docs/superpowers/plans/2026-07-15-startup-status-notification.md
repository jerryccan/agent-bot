# Startup Status Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one self-contained Feishu status card to every known Feishu conversation after each successful acp-bot restart.

**Architecture:** Add a read-only context enumeration method to `StateStore`, a deterministic startup-card view model to `CardRenderer`, and a small `StartupNotifier` orchestration service. The application invokes the notifier after the Feishu connector is ready; delivery failures are isolated per conversation and never abort startup.

**Tech Stack:** TypeScript, Vitest, SQLite via better-sqlite3, Feishu interactive cards.

## Global Constraints

- Send only after successful Feishu WebSocket startup.
- Target persisted `chat_id:` contexts only and send once per process lifetime.
- Do not use cross-restart idempotency.
- Do not put callback-dependent actions in the card.
- Delivery failure must not terminate startup or prevent delivery to other contexts.

---

### Task 1: Enumerate persisted user contexts

**Files:**
- Modify: `tests/state/StateStore.test.ts`
- Modify: `src/state/StateStore.ts`

**Interfaces:**
- Produces: `StateStore.listUserContexts(): UserContextRecord[]`, ordered by creation time.

- [ ] **Step 1: Write the failing storage test**

Add a test that creates `chat_id:c1` and `console:local` contexts and expects:

```ts
expect(store.listUserContexts().map((context) => context.contextKey)).toEqual([
  "chat_id:c1",
  "console:local",
]);
```

- [ ] **Step 2: Run the test and verify the missing-method failure**

Run: `npm test -- tests/state/StateStore.test.ts`

Expected: FAIL because `listUserContexts` does not exist.

- [ ] **Step 3: Implement the query**

Add:

```ts
listUserContexts(): UserContextRecord[] {
  const rows = this.db
    .prepare("SELECT * FROM user_contexts ORDER BY created_at ASC")
    .all() as UserContextRow[];
  return rows.map(mapUserContext);
}
```

- [ ] **Step 4: Run the focused test and commit**

Run: `npm test -- tests/state/StateStore.test.ts`

Expected: PASS.

### Task 2: Render the startup status card

**Files:**
- Modify: `tests/feishu/CardRenderer.test.ts`
- Modify: `src/feishu/CardRenderer.ts`

**Interfaces:**
- Produces: exported `StartupStatusView` and `CardRenderer.renderStartupStatus(view): Record<string, unknown>`.
- `StartupStatusView` contains `startedAt`, `defaultAgentName`, `defaultAgentTitle`, `cwd`, and an optional current-task summary with `id`, `agentName`, `sessionStatus`, and `lastTurnStatus`.

- [ ] **Step 1: Write the failing renderer test**

Render a fixed startup status and assert the serialized card contains `acp-bot 已启动`, `在线`, `Codex`, the CWD, task ID, resumable status wording, `/new`, and `/status`; assert it contains no `button`, `action`, or `value` fields.

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- tests/feishu/CardRenderer.test.ts`

Expected: FAIL because `renderStartupStatus` does not exist.

- [ ] **Step 3: Implement the view model and renderer**

Add a green card whose body is one bounded markdown element. Convert a persisted `running` status to `上次运行中，可在下一条消息时恢复`; other statuses use stable Chinese labels.

- [ ] **Step 4: Run the focused test and commit**

Run: `npm test -- tests/feishu/CardRenderer.test.ts`

Expected: PASS.

### Task 3: Orchestrate per-context notification delivery

**Files:**
- Create: `tests/startup/StartupNotifier.test.ts`
- Create: `src/startup/StartupNotifier.ts`

**Interfaces:**
- Produces: `StartupNotifier.notify(startedAt: Date): Promise<void>`.
- Constructor consumes `StateStore`, `FeishuOutbound`, `CardRenderer`, `Pick<Logger, "warn">`, and `{ defaultAgentName, defaultAgentTitle, cwd }`.

- [ ] **Step 1: Write failing notifier tests**

Create real temporary `StateStore` instances and fake `FeishuOutbound` implementations. Assert:

```ts
expect(sendInteractiveCard).toHaveBeenCalledOnce();
expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:c1", expect.any(Object));
```

Also create two chat contexts where the first send rejects, then assert the second is attempted and `notify()` resolves while `logger.warn` is called.

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run: `npm test -- tests/startup/StartupNotifier.test.ts`

Expected: FAIL because `StartupNotifier` does not exist.

- [ ] **Step 3: Implement minimal orchestration**

Implement `notify()` by listing contexts, filtering `chat_id:`, resolving optional current sessions, rendering cards, and using per-target `try/catch` within `Promise.all`:

```ts
await Promise.all(contexts.map(async (context) => {
  try {
    await this.outbound.sendInteractiveCard(context.contextKey, card);
  } catch (error) {
    this.logger.warn({ error, contextKey: context.contextKey }, "Failed to send startup status notification.");
  }
}));
```

- [ ] **Step 4: Run the focused tests and commit**

Run: `npm test -- tests/startup/StartupNotifier.test.ts`

Expected: PASS.

### Task 4: Wire startup delivery and deploy

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `StartupNotifier.notify(processStartedAt)` after `await feishuConnector.start()`.

- [ ] **Step 1: Wire the notifier**

Capture `const processStartedAt = new Date()` before initialization. When the SDK Feishu client exists, construct `StartupNotifier` with the configured default agent name/title and resolved default CWD. After the connector starts, await the notification before starting the local console.

- [ ] **Step 2: Run full verification**

Run: `npm test`, `npm run typecheck`, and `npm run build`.

Expected: all tests pass and both TypeScript commands exit 0.

- [ ] **Step 3: Restart the live process**

Gracefully terminate the current TypeScript application process, start it again from `D:/dev/acp-bot` with `ACP_BOT_CONFIG` pointing to the worktree `agents.yaml`, and keep the process hidden.

- [ ] **Step 4: Verify the real notification**

Confirm the log contains the new Feishu WebSocket startup entry and no `Failed to send startup status notification` entry. Query the recent Feishu message send result or ask the user to visually confirm the single `acp-bot 已启动` status card.
