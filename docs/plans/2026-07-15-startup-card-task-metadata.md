# Startup Card Task Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current task's human-readable title, model, and reasoning effort on every Feishu startup card.

**Architecture:** Persist a normalized task title alongside existing runtime metadata, let `CodexRuntime` obtain authoritative titles from thread responses and `thread/name/updated`, and use the first ordinary prompt as an immediate fallback. A small startup hydrator reads metadata only for legacy current sessions that still lack a title, after which `StartupNotifier` renders entirely from persisted state.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, SQLite via better-sqlite3, Codex App Server JSON-RPC, Feishu interactive cards.

## Global Constraints

- Prefer `thread.name`; fall back to `thread.preview`, then the first non-command user prompt, then the local task ID.
- Do not erase a useful fallback title when Codex sends an empty title.
- Existing SQLite databases must migrate additively at startup.
- Missing task model and effort render as `默认` and `自动`.
- Missing-task cards render model `默认`, effort `自动`, and the existing next-message guidance.
- Preserve the existing task ID as a separate diagnostic field.
- Legacy hydration reads only current sessions without titles and uses `thread/read` with `includeTurns: false`.
- Metadata updates must not be forwarded to turn presenters or create progress cards.

---

### Task 1: Persist task titles and define runtime metadata contracts

**Files:**
- Create: `src/utils/taskTitle.ts`
- Modify: `src/state/StateStore.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/AcpRuntimeAdapter.ts`
- Test: `tests/state/StateStore.test.ts`

**Interfaces:**
- Produces: `normalizeTaskTitle(value: string | null | undefined): string | undefined`.
- Produces: `RuntimeSession.title?: string`, `CreateRuntimeSessionInput.title?: string`.
- Produces: `RuntimeEvent = AgentEvent | SessionMetadataUpdatedEvent`.
- Produces: `AgentRuntime.readSessionMetadata(remoteSessionId: string): Promise<RuntimeSessionMetadata>`.
- Produces: `SessionRecord.title?: string` and `updateRuntimeSession(..., { title })`.

- [ ] **Step 1: Write the failing persistence test**

Extend the runtime metadata test in `tests/state/StateStore.test.ts`:

```ts
store.updateRuntimeSession("s1", {
  runtimeKind: "codex",
  remoteSessionId: "thr_1",
  title: "Show startup metadata",
  model: "gpt-test",
  reasoningEffort: "high",
  permissionMode: "auto",
});
expect(store.getSession("s1")).toMatchObject({ title: "Show startup metadata" });
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/state/StateStore.test.ts`

Expected: TypeScript/Vitest fails because `title` is not accepted or persisted.

- [ ] **Step 3: Add the minimal contracts and migration**

Create `src/utils/taskTitle.ts`:

```ts
const MAX_TASK_TITLE_LENGTH = 120;

export function normalizeTaskTitle(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= MAX_TASK_TITLE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TASK_TITLE_LENGTH - 3)}...`;
}
```

Add `title` to the runtime/session types, a `SessionMetadataUpdatedEvent` carrying `{ sessionId, title }`, and a `RuntimeSessionMetadata` result. Change `AgentRuntime.onEvent` to accept `RuntimeEvent` and add `readSessionMetadata`. The ACP adapter returns `{}` for metadata reads.

Add nullable `title TEXT` to `StateStore.ensureSessionColumns()`, row mappings, `SessionRecord`, and `updateRuntimeSession`. Preserve an existing title when a patch omits it.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/state/StateStore.test.ts tests/runtime/AcpRuntimeAdapter.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit**

```powershell
git add src/utils/taskTitle.ts src/state/StateStore.ts src/runtime/types.ts src/runtime/AcpRuntimeAdapter.ts tests/state/StateStore.test.ts
git commit -m "feat: persist task display titles"
```

### Task 2: Capture and synchronize Codex thread titles

**Files:**
- Modify: `src/codex/CodexRuntime.ts`
- Test: `tests/codex/CodexRuntime.test.ts`

**Interfaces:**
- Consumes: `normalizeTaskTitle`, `RuntimeEvent`, and `RuntimeSessionMetadata` from Task 1.
- Produces: `CodexRuntime.readSessionMetadata(remoteSessionId)` using `thread/read`.
- Produces: authoritative `session_metadata_updated` events for `thread/name/updated`.

- [ ] **Step 1: Write failing runtime tests**

Add focused tests that make fake client responses include:

```ts
{ thread: { id: "thread_1", name: "Generated title", preview: "First prompt" }, model: "gpt-test" }
```

Assert `createSession()` and `resumeSession()` choose `name`, then `preview` when `name` is null. Add a notification test:

```ts
client.emit("thread/name/updated", { threadId: "thread_1", threadName: "Updated title" });
expect(runtime.getSession("s1")?.title).toBe("Updated title");
expect(events).toContainEqual({
  type: "session_metadata_updated",
  sessionId: "s1",
  title: "Updated title",
});
```

Add a metadata-read test asserting `thread/read` receives `{ threadId: "thread_1", includeTurns: false }` and returns the normalized name or preview.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/codex/CodexRuntime.test.ts`

Expected: assertions fail because thread metadata is ignored and the notification is unmapped.

- [ ] **Step 3: Implement minimal Codex metadata support**

Expand `ThreadResponse.thread` with optional `name` and `preview`. Pass the response thread into `makeSession()` and choose:

```ts
title: normalizeTaskTitle(response.thread.name)
  ?? normalizeTaskTitle(response.thread.preview)
  ?? input.title,
```

Handle `thread/name/updated` before turn-scoped event mapping. Match by remote thread ID, ignore empty/unknown updates, mutate the in-memory session, and emit `session_metadata_updated`.

Implement:

```ts
async readSessionMetadata(remoteSessionId: string): Promise<RuntimeSessionMetadata> {
  const response = await (await this.client()).request<ThreadReadResponse>(
    "thread/read",
    { threadId: remoteSessionId, includeTurns: false },
    5_000,
  );
  return { title: normalizeTaskTitle(response.thread.name) ?? normalizeTaskTitle(response.thread.preview) };
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm test -- tests/codex/CodexRuntime.test.ts`

Expected: the file passes.

- [ ] **Step 5: Commit**

```powershell
git add src/codex/CodexRuntime.ts tests/codex/CodexRuntime.test.ts
git commit -m "feat: synchronize Codex task titles"
```

### Task 3: Persist prompt fallbacks and runtime title events

**Files:**
- Modify: `src/proxy/ProxySessionController.ts`
- Modify: `tests/proxy/ProxySessionController.test.ts`

**Interfaces:**
- Consumes: `RuntimeEvent`, `normalizeTaskTitle`, and `SessionRecord.title`.
- Produces: persisted first-prompt fallback before `startTurn`.
- Produces: controller handling that persists `session_metadata_updated` without calling `outbound.onEvent`.

- [ ] **Step 1: Write failing controller tests**

Add one test that sends two ordinary prompts to the same session and asserts the stored title remains the normalized first prompt. Add another that invokes the captured runtime listener with:

```ts
{ type: "session_metadata_updated", sessionId: "saved", title: "Generated title" }
```

Assert the store title changes and `outbound.onEvent` is not called for that metadata event.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/proxy/ProxySessionController.test.ts`

Expected: stored title is undefined and/or metadata is forwarded as a turn event.

- [ ] **Step 3: Implement the fallback and metadata path**

Pass `record.title` through create/resume inputs and persist `session.title` in `persistRuntimeSession`.

Before `runtime.startTurn`, if the latest stored session has no title, persist `normalizeTaskTitle(text)`. Do not overwrite an existing title on later prompts.

Change `handleRuntimeEvent(event: RuntimeEvent)` to handle metadata first:

```ts
if (event.type === "session_metadata_updated") {
  this.store.updateRuntimeSession(event.sessionId, { title: event.title });
  return;
}
```

Only `AgentEvent` values continue to the outbound presenter.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/proxy/ProxySessionController.test.ts`

Expected: the file passes.

- [ ] **Step 5: Commit**

```powershell
git add src/proxy/ProxySessionController.ts tests/proxy/ProxySessionController.test.ts
git commit -m "feat: retain task title fallbacks"
```

### Task 4: Hydrate legacy titles and render startup metadata

**Files:**
- Create: `src/startup/SessionMetadataHydrator.ts`
- Modify: `src/startup/StartupNotifier.ts`
- Modify: `src/feishu/CardRenderer.ts`
- Modify: `src/index.ts`
- Create: `tests/startup/SessionMetadataHydrator.test.ts`
- Modify: `tests/startup/StartupNotifier.test.ts`
- Modify: `tests/feishu/CardRenderer.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeRegistry`, `StateStore`, and `AgentRuntime.readSessionMetadata`.
- Produces: `SessionMetadataHydrator.hydrate(session: SessionRecord): Promise<SessionRecord>`.
- Produces: startup view fields `title`, `model`, and `reasoningEffort`.

- [ ] **Step 1: Write failing hydrator and card tests**

Test that a titleless Codex session with a remote ID calls `readSessionMetadata`, stores the result, and returns the refreshed record. Test that titled sessions do not call the runtime. Test a read failure at `StartupNotifier` level and assert notification delivery continues while logging the session ID.

Update the card test input:

```ts
currentTask: {
  id: "sess_1",
  title: "Startup task metadata",
  model: "gpt-test",
  reasoningEffort: "high",
  agentName: "codex",
  sessionStatus: "running",
  lastTurnStatus: "running",
}
```

Assert the serialized card contains `当前模型`, `gpt-test`, `思考强度`, `high`, the title, and `任务 ID`. Add a no-task test asserting `默认` and `自动`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/startup/SessionMetadataHydrator.test.ts tests/startup/StartupNotifier.test.ts tests/feishu/CardRenderer.test.ts`

Expected: missing hydrator module and card-field assertions fail.

- [ ] **Step 3: Implement hydration and card rendering**

Implement `SessionMetadataHydrator` so only titleless sessions with `runtimeKind` and `remoteSessionId` are read. Persist a non-empty title and return `store.getSession(id) ?? session`.

Inject the hydrator into `StartupNotifier`. Resolve the current session, attempt hydration inside a per-session try/catch, log `Failed to hydrate startup task metadata.` on failure, and still send the card.

Extend `StartupStatusView.currentTask` with optional title/model/effort and render:

```ts
`**当前模型**：${inlineCode(view.currentTask?.model ?? "默认")}`,
`**思考强度**：${inlineCode(view.currentTask?.reasoningEffort ?? "自动")}`,
```

For an existing task, render `当前任务` from `title ?? id` and add a separate `任务 ID`. For no task, retain the existing explanatory line.

Construct `SessionMetadataHydrator` in `src/index.ts` and pass it to `StartupNotifier`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/startup/SessionMetadataHydrator.test.ts tests/startup/StartupNotifier.test.ts tests/feishu/CardRenderer.test.ts`

Expected: all three files pass.

- [ ] **Step 5: Commit**

```powershell
git add src/startup/SessionMetadataHydrator.ts src/startup/StartupNotifier.ts src/feishu/CardRenderer.ts src/index.ts tests/startup/SessionMetadataHydrator.test.ts tests/startup/StartupNotifier.test.ts tests/feishu/CardRenderer.test.ts
git commit -m "feat: show task metadata on startup cards"
```

### Task 5: Full verification and live restart

**Files:**
- Verify: all files changed by Tasks 1–4

**Interfaces:**
- Consumes: completed implementation and tests.
- Produces: rebuilt `dist/` application and a restarted live bot.

- [ ] **Step 1: Run the full automated verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
git diff --check HEAD~4..HEAD
```

Expected: all tests pass, both TypeScript projects typecheck, the production build exits 0, and diff check produces no output.

- [ ] **Step 2: Review the requirement checklist**

Confirm from code and focused tests that generated title priority, prompt fallback, empty-title preservation, legacy hydration, model/effort defaults, separate task ID, and non-forwarded metadata events are all covered.

- [ ] **Step 3: Restart and verify the live service**

Stop only the process whose command line is the repository's `dist/index.js`, start `node dist/index.js` hidden with the existing environment, and verify the new PID remains alive and the Feishu WebSocket reports ready. Do not alter `.tmp/` or unrelated user files.

- [ ] **Step 4: Record final repository state**

Run: `git status --short; git log -5 --oneline`

Expected: only the pre-existing user-owned `.tmp/` remains untracked and the feature commits are at the tip of `master`.
