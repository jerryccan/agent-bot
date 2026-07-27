# Codex App Server Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Codex App Server runtime to `agent-bot` with a Feishu-first progress-card experience, resumable threads without history replay, controllable permissions, steering, cancellation, and a concurrent test console.

**Architecture:** Introduce a runtime-neutral event and session interface, retain ACP as one implementation, and add a single-process multi-thread Codex App Server implementation. Normalize Codex events into a pure turn-view state, then render and rate-limit complete Feishu cards while delivering the final answer separately.

**Tech Stack:** TypeScript, Node.js 20+, Codex App Server JSONL/JSON-RPC-lite, `@larksuiteoapi/node-sdk`, SQLite via `better-sqlite3`, Zod, Vitest.

## Global Constraints

- Feishu is the primary interface; console is a lightweight test interface.
- Feishu and console run concurrently and keep separate current-session state.
- Default Codex permissions are `auto`; `/permissions confirm` enables card approvals.
- Normal progress-card updates occur at most once every 2 seconds; critical updates keep a 500 ms minimum write gap.
- A resumed Codex thread never re-emits historical messages or final answers.
- App Server crashes never trigger automatic prompt replay.
- Existing ACP agents remain usable; missing agent `kind` means `acp`.

---

### Task 1: Runtime contracts, configuration, and persistence

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/AgentRuntimeRegistry.ts`
- Create: `src/runtime/AcpRuntimeAdapter.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/state/migrations.ts`
- Modify: `src/state/StateStore.ts`
- Modify: `config.yaml`
- Test: `tests/runtime/registry.test.ts`
- Test: `tests/config/loadConfig.test.ts`
- Test: `tests/state/StateStore.test.ts`

**Interfaces:**
- Produces `AgentRuntime`, `RuntimeSession`, `AgentEvent`, `PermissionMode`, and `AgentRuntimeRegistry`.
- Produces `StateStore.updateRuntimeSession(...)`, `saveTurnSnapshot(...)`, and delivery-ledger methods.

- [ ] **Step 1: Write failing tests for runtime selection and backward-compatible config**

```ts
test("uses ACP when agent kind is omitted", () => {
  const parsed = agentConfigSchema.parse({ title: "Example", command: "node" });
  expect(parsed.kind).toBe("acp");
});

test("selects the Codex runtime for a codex agent", () => {
  const codex = { kind: "codex", createSession: vi.fn() } as unknown as AgentRuntime;
  const acp = { kind: "acp", createSession: vi.fn() } as unknown as AgentRuntime;
  const registry = new AgentRuntimeRegistry({ acp, codex });
  expect(registry.forAgent({ kind: "codex" } as AgentConfig)).toBe(codex);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/runtime/registry.test.ts tests/config/loadConfig.test.ts`

Expected: FAIL because `kind`, `AgentRuntime`, and `AgentRuntimeRegistry` do not exist.

- [ ] **Step 3: Implement focused runtime contracts and registry**

```ts
export type RuntimeKind = "acp" | "codex";
export type PermissionMode = "auto" | "confirm";

export type AgentEvent =
  | { type: "turn_started"; sessionId: string; turnId: string; startedAt: number }
  | { type: "agent_text_delta"; sessionId: string; turnId: string; text: string }
  | { type: "plan_updated"; sessionId: string; turnId: string; steps: PlanStep[] }
  | { type: "tool_started"; sessionId: string; turnId: string; tool: ToolState }
  | { type: "tool_updated"; sessionId: string; turnId: string; tool: ToolState }
  | { type: "approval_requested"; sessionId: string; turnId: string; request: ApprovalRequest }
  | { type: "turn_completed"; sessionId: string; turnId: string; finalResponse: string; durationMs?: number }
  | { type: "turn_cancelled"; sessionId: string; turnId: string }
  | { type: "turn_failed"; sessionId: string; turnId: string; message: string };

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession>;
  startTurn(sessionId: string, text: string): Promise<string>;
  steerTurn(sessionId: string, turnId: string, text: string): Promise<void>;
  cancelTurn(sessionId: string, turnId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>;
  respondToApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}
```

Add `kind: z.enum(["acp", "codex"]).default("acp")` to agent configuration, add `console: { enabled: z.boolean().default(true) }`, and add the Codex agent to `config.yaml`. Implement `AcpRuntimeAdapter` by delegating create, prompt, cancel, close, mode, events, and permissions to the existing `AcpSessionManager`; return unsupported capability errors for Codex-only model operations.

- [ ] **Step 4: Write failing persistence migration tests**

```ts
test("persists Codex thread settings and delivery state", () => {
  const store = new StateStore(temporaryDb());
  store.createSession({ localSessionId: "s1", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready" });
  store.updateRuntimeSession("s1", { runtimeKind: "codex", remoteSessionId: "thr_1", model: "gpt-test", permissionMode: "auto" });
  expect(store.getSession("s1")).toMatchObject({ runtimeKind: "codex", remoteSessionId: "thr_1", model: "gpt-test", permissionMode: "auto" });
});
```

- [ ] **Step 5: Run persistence test and verify RED**

Run: `npx vitest run tests/state/StateStore.test.ts`

Expected: FAIL because runtime session fields and migration tables do not exist.

- [ ] **Step 6: Implement additive migrations and store APIs**

Add nullable `runtime_kind`, `remote_session_id`, `model`, `permission_mode`, `last_turn_id`, and `last_turn_status` columns. Add `turn_snapshots` and `turn_deliveries` tables keyed by local turn ID. Preserve `acp_session_id` for compatibility and map it to `remoteSessionId` when the new column is null.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/runtime/registry.test.ts tests/config/loadConfig.test.ts tests/state/StateStore.test.ts`

Expected: PASS.

Commit files: `git add src/runtime src/config/schema.ts src/state config.yaml tests/runtime tests/config tests/state`, then `git commit -m "feat: add runtime contracts and persistent session metadata"`.

---

### Task 2: Codex App Server JSONL connection

**Files:**
- Create: `src/codex/protocol.ts`
- Create: `src/codex/AppServerConnection.ts`
- Test: `tests/codex/AppServerConnection.test.ts`

**Interfaces:**
- Produces `AppServerConnection.request<T>()`, `notify()`, `registerRequestHandler()`, `onNotification()`, and `close()`.
- Consumes a spawned process with stdin/stdout/stderr streams.

- [ ] **Step 1: Write failing connection tests against in-memory streams**

```ts
test("writes JSON-RPC-lite requests without a jsonrpc field", async () => {
  const process = fakeChildProcess();
  const connection = new AppServerConnection(process.child, logger);
  const pending = connection.request("initialize", { clientInfo: { name: "agent-bot", version: "0.1.0" } });
  expect(process.writtenJson()).toEqual([{ id: 1, method: "initialize", params: expect.any(Object) }]);
  process.pushStdout({ id: 1, result: { userAgent: "codex" } });
  await expect(pending).resolves.toMatchObject({ userAgent: "codex" });
});

test("answers server initiated approval requests", async () => {
  const process = fakeChildProcess();
  const connection = new AppServerConnection(process.child, logger);
  connection.registerRequestHandler("item/commandExecution/requestApproval", async () => ({ decision: "accept" }));
  process.pushStdout({ id: 9, method: "item/commandExecution/requestApproval", params: { command: "npm test" } });
  await vi.waitFor(() => expect(process.writtenJson()).toContainEqual({ id: 9, result: { decision: "accept" } }));
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `npx vitest run tests/codex/AppServerConnection.test.ts`

Expected: FAIL because the connection does not exist.

- [ ] **Step 3: Implement request correlation, notifications, handlers, and close semantics**

Use line-delimited JSON, omit `jsonrpc`, reject all pending requests on close, ignore malformed stdout with a warning, and send method-not-found errors for unregistered server requests.

- [ ] **Step 4: Test timeout and malformed-line behavior**

```ts
test("rejects timed out requests and removes them", async () => {
  vi.useFakeTimers();
  const connection = new AppServerConnection(fakeChildProcess().child, logger);
  const request = connection.request("model/list", {}, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(request).rejects.toThrow("App Server request timed out: model/list");
});
```

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/codex/AppServerConnection.test.ts`

Expected: PASS.

Commit files: `git add src/codex/protocol.ts src/codex/AppServerConnection.ts tests/codex/AppServerConnection.test.ts`, then `git commit -m "feat: add Codex app-server JSONL connection"`.

---

### Task 3: Codex runtime, event mapping, approvals, and no-replay resume

**Files:**
- Create: `src/codex/CodexProcessManager.ts`
- Create: `src/codex/CodexEventMapper.ts`
- Create: `src/codex/CodexRuntime.ts`
- Test: `tests/codex/CodexRuntime.test.ts`
- Test: `tests/codex/CodexEventMapper.test.ts`
- Create: `tests/fixtures/fake-codex-app-server.js`

**Interfaces:**
- Implements `AgentRuntime` with one App Server process and many thread-backed sessions.
- Emits normalized events only for a locally active `turnId`.

- [ ] **Step 1: Write failing create/start/stream tests**

```ts
test("starts a Codex thread and emits only the active turn deltas", async () => {
  const runtime = createRuntimeWithFakeServer();
  await runtime.createSession({ localSessionId: "s1", cwd: process.cwd(), permissionMode: "auto" });
  const events: AgentEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  const turnId = await runtime.startTurn("s1", "inspect the repo");
  fakeServer.notify("item/agentMessage/delta", { threadId: "thr_1", turnId, itemId: "i1", delta: "hello" });
  expect(events).toContainEqual(expect.objectContaining({ type: "agent_text_delta", text: "hello", turnId }));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts tests/codex/CodexEventMapper.test.ts`

Expected: FAIL because the Codex runtime and mapper do not exist.

- [ ] **Step 3: Implement process initialization and thread/turn methods**

Send `initialize` followed by `initialized`; map create to `thread/start`, resume to `thread/resume`, prompt to `turn/start`, steering to `turn/steer`, cancellation to `turn/interrupt`, and close to `thread/archive`. Map `auto` to `approvalPolicy: "never", sandbox: "danger-full-access"`; map `confirm` to `approvalPolicy: "on-request", sandbox: "workspace-write"`.

- [ ] **Step 4: Write the resume regression test before implementing resume event gates**

```ts
test("resume never emits historical items", async () => {
  const runtime = createRuntimeWithFakeServer({
    resumeResult: { thread: { id: "thr_1", turns: [{ id: "old", items: [{ type: "agentMessage", text: "already sent" }] }] } },
  });
  const events: AgentEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  await runtime.resumeSession({ localSessionId: "s1", remoteSessionId: "thr_1", cwd: process.cwd(), permissionMode: "auto" });
  fakeServer.notify("item/agentMessage/delta", { threadId: "thr_1", turnId: "old", itemId: "old_i", delta: "already sent" });
  expect(events).toEqual([]);
});
```

- [ ] **Step 5: Run resume test and verify RED**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts -t "resume never emits"`

Expected: FAIL because resume or notification filtering is missing.

- [ ] **Step 6: Implement active-turn gates and approvals**

Ignore history in resume responses. Ignore item/turn notifications unless their `turnId` equals the session's locally started active turn. In `auto`, answer approval requests with `accept`; in `confirm`, emit `approval_requested` and resolve only after `respondToApproval` receives the Feishu selection.

- [ ] **Step 7: Verify steering, interruption, completion, crash, and no replay**

Run: `npx vitest run tests/codex`

Expected: PASS.

Commit files: `git add src/codex tests/codex tests/fixtures`, then `git commit -m "feat: add resumable Codex runtime without history replay"`.

---

### Task 4: Turn view state and Feishu card rendering

**Files:**
- Create: `src/presentation/TurnStateReducer.ts`
- Create: `src/presentation/turnViewTypes.ts`
- Create: `src/presentation/splitMarkdown.ts`
- Rewrite: `src/feishu/CardRenderer.ts`
- Test: `tests/presentation/TurnStateReducer.test.ts`
- Test: `tests/presentation/splitMarkdown.test.ts`
- Test: `tests/feishu/CardRenderer.test.ts`

**Interfaces:**
- Produces immutable `TurnViewState` from `AgentEvent`.
- Produces complete Feishu cards and Markdown-safe final-answer chunks.

- [ ] **Step 1: Write failing reducer tests for tools, plans, files, and final output**

```ts
test("keeps the active tool visible and groups completed tools", () => {
  let state = createTurnViewState("turn_1", 1000);
  state = reduceTurnEvent(state, { type: "tool_started", sessionId: "s1", turnId: "turn_1", tool: tool("t1", "npm test", "running") });
  state = reduceTurnEvent(state, { type: "tool_updated", sessionId: "s1", turnId: "turn_1", tool: tool("t1", "npm test", "completed") });
  expect(state.activeTool).toBeUndefined();
  expect(state.completedTools).toHaveLength(1);
});
```

- [ ] **Step 2: Run reducer test and verify RED**

Run: `npx vitest run tests/presentation/TurnStateReducer.test.ts`

Expected: FAIL because the reducer does not exist.

- [ ] **Step 3: Implement the pure reducer with bounded output**

Retain at most 20 completed tool summaries, 5 failed tools, and 6000 characters per bounded output field. Derive aggregate tool, command, file, and duration summaries without protocol JSON.

- [ ] **Step 4: Write failing card and Markdown split tests**

```ts
test("renders completed tools in a collapsed panel and failed tools expanded", () => {
  const card = new CardRenderer().renderTurn(stateWithCompletedAndFailedTools());
  expect(findTag(card, "collapsible_panel", { expanded: false })).toBeDefined();
  expect(findText(card, "命令失败")).toBe(true);
});

test("splits long fenced code without leaving an unclosed fence", () => {
  const chunks = splitMarkdown(`before\n\`\`\`ts\n${"const x = 1;\n".repeat(500)}\`\`\``, 1000);
  expect(chunks.every(hasBalancedFences)).toBe(true);
});
```

- [ ] **Step 5: Implement complete-card rendering and safe splitting**

Use a stable card header, visible active tool, collapsed successful tools, expanded failures, compact file summary, and action values containing `action`, `sessionId`, and `turnId`. Render a compact fallback when a card would exceed configured bounds.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/presentation tests/feishu/CardRenderer.test.ts`

Expected: PASS.

Commit files: `git add src/presentation src/feishu/CardRenderer.ts tests/presentation tests/feishu/CardRenderer.test.ts`, then `git commit -m "feat: render Feishu-first Codex turn progress"`.

---

### Task 5: Card scheduler, delivery idempotency, and details actions

**Files:**
- Create: `src/feishu/CardUpdateScheduler.ts`
- Create: `src/feishu/FeishuTurnPresenter.ts`
- Modify: `src/feishu/FeishuMessageClient.ts`
- Modify: `src/feishu/types.ts`
- Test: `tests/feishu/CardUpdateScheduler.test.ts`
- Test: `tests/feishu/FeishuTurnPresenter.test.ts`

**Interfaces:**
- Consumes `TurnViewState`, `FeishuOutbound`, and `StateStore`.
- Produces one progress-card lifecycle and exactly-once final-answer delivery.

- [ ] **Step 1: Write fake-timer tests for update cadence and latest-state replacement**

```ts
test("coalesces normal updates and renders only the latest state", async () => {
  vi.useFakeTimers();
  const scheduler = createScheduler({ normalIntervalMs: 2000, criticalGapMs: 500 });
  scheduler.update(state("one"));
  scheduler.update(state("two"));
  await vi.advanceTimersByTimeAsync(1999);
  expect(updateCard).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(updateCard).toHaveBeenCalledTimes(1);
  expect(updateCard).toHaveBeenLastCalledWith(expect.objectContaining({ progressText: "two" }));
});
```

- [ ] **Step 2: Run scheduler test and verify RED**

Run: `npx vitest run tests/feishu/CardUpdateScheduler.test.ts`

Expected: FAIL because the scheduler does not exist.

- [ ] **Step 3: Implement scheduler and rate-limit classification**

Track dirty state, last successful hash, last write timestamp, pending timer, retry index, and final flush promise. Extend `FeishuApiError` with retryability metadata so 2/4/8/16/30 second backoff is applied without storing stale renders.

- [ ] **Step 4: Write failing presenter idempotency tests**

```ts
test("delivers the final answer once even when completion is observed twice", async () => {
  const presenter = createPresenter();
  await presenter.onEvent(completed("turn_1", "answer"));
  await presenter.onEvent(completed("turn_1", "answer"));
  expect(outbound.sendMarkdown).toHaveBeenCalledTimes(1);
  expect(store.markFinalDelivered).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 5: Implement presenter, delivery ledger, and details action**

Create the progress card immediately, reduce subsequent events, schedule full-card updates, force completion flush, split and send the final answer, then mark delivery successful. `View turn details` reads the bounded snapshot and sends one details card; it never calls App Server history APIs.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/feishu/CardUpdateScheduler.test.ts tests/feishu/FeishuTurnPresenter.test.ts`

Expected: PASS.

Commit files: `git add src/feishu src/state tests/feishu`, then `git commit -m "feat: schedule idempotent Feishu turn delivery"`.

---

### Task 6: Controller commands, steering, approvals, and concurrent connectors

**Files:**
- Modify: `src/commands/commandTypes.ts`
- Modify: `src/commands/CommandRouter.ts`
- Rewrite: `src/proxy/ProxySessionController.ts`
- Split: `src/feishu/FeishuConnector.ts`
- Create: `src/console/ConsoleConnector.ts`
- Create: `src/console/ConsoleTurnPresenter.ts`
- Create: `src/presentation/OutboundRouter.ts`
- Test: `tests/commands/CommandRouter.test.ts`
- Test: `tests/proxy/ProxySessionController.test.ts`
- Test: `tests/console/ConsoleConnector.test.ts`

**Interfaces:**
- Controller consumes `AgentRuntimeRegistry`, `StateStore`, and `OutboundRouter`.
- Connectors share the same handler but emit `chat_id:*` and `console:*` contexts.

- [ ] **Step 1: Write failing command tests**

```ts
expect(router.parse("/permissions confirm")).toEqual({ type: "permissions", mode: "confirm" });
expect(router.parse("/model gpt-test")).toEqual({ type: "model", model: "gpt-test" });
expect(router.parse("/model")).toEqual({ type: "model" });
```

- [ ] **Step 2: Run command tests and verify RED**

Run: `npx vitest run tests/commands/CommandRouter.test.ts`

Expected: FAIL because the commands are unsupported.

- [ ] **Step 3: Implement commands and automatic default-session creation**

Plain text with no current session creates the default Codex session. Persist model and permission changes. `/sessions` and `/status` render cards through the context's presenter.

- [ ] **Step 4: Write failing concurrency tests**

```ts
test("cancel bypasses a running prompt and plain text steers it", async () => {
  runtime.startTurn.mockResolvedValue("turn_1");
  await controller.onMessage(message("build it"));
  await controller.onMessage(message("also update docs"));
  await controller.onMessage(message("/cancel"));
  expect(runtime.steerTurn).toHaveBeenCalledWith(expect.any(String), "turn_1", "also update docs");
  expect(runtime.cancelTurn).toHaveBeenCalledWith(expect.any(String), "turn_1");
});
```

- [ ] **Step 5: Implement out-of-band control routing and steering fallback**

Do not await an entire turn inside the per-context command queue. Track active turn IDs in runtime session state. If `turn/steer` loses the active-turn race, enqueue the text as exactly one next turn.

- [ ] **Step 6: Split and run both connectors concurrently**

`FeishuConnector` handles only Feishu WebSocket events. `ConsoleConnector` always starts when `console.enabled` is true and uses `contextKey: "console:local"`. `OutboundRouter` chooses Feishu or console presentation by context prefix.

- [ ] **Step 7: Implement approval and card actions**

Permission buttons resolve the exact App Server request ID with `accept`, `acceptForSession`, `decline`, or `cancel`. Cancel, switch, close, and details card actions are idempotent by event/action ID, and resolved approval cards are replaced with their final state.

- [ ] **Step 8: Run focused tests and commit**

Run: `npx vitest run tests/commands tests/proxy tests/console tests/feishu/transport.test.ts`

Expected: PASS.

Commit files: `git add src/commands src/proxy src/feishu src/console src/presentation tests`, then `git commit -m "feat: add Codex commands steering and dual inputs"`.

---

### Task 7: Application wiring, documentation, and end-to-end verification

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `config.yaml`
- Test: `tests/integration/codex-flow.test.ts`

**Interfaces:**
- Wires the App Server process, runtime registry, presenters, controller, Feishu connector, and console connector.

- [ ] **Step 1: Write failing fake-App-Server integration test**

```ts
test("new turn streams one progress card and one final answer, then resumes without replay", async () => {
  const app = await startTestApplication({ codexCommand: process.execPath, codexArgs: [fixturePath] });
  await app.sendFeishu("inspect this repo");
  await app.waitForTurnCompletion();
  expect(app.feishu.progressCards()).toHaveLength(1);
  expect(app.feishu.finalAnswers()).toEqual(["fixture final answer"]);
  await app.restart();
  await app.sendFeishu("continue");
  await app.waitForTurnCompletion();
  expect(app.feishu.finalAnswers()).toEqual(["fixture final answer", "fixture second answer"]);
});
```

- [ ] **Step 2: Run integration test and verify RED**

Run: `npx vitest run tests/integration/codex-flow.test.ts`

Expected: FAIL because application wiring is incomplete.

- [ ] **Step 3: Wire application lifecycle and graceful shutdown**

Start Feishu when credentials are present and console when enabled. Start Codex lazily on first Codex use. On shutdown, stop connectors, flush presenters, close runtimes, then close SQLite.

- [ ] **Step 4: Update user documentation**

Document the precondition `codex login status`, Codex agent configuration, concurrent console behavior, auto-created sessions, all supported commands, permission modes, resume behavior, and Feishu card lifecycle.

- [ ] **Step 5: Run full automated verification**

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript errors.

Run: `npm run build`

Expected: exit 0 and a fresh `dist/` tree.

- [ ] **Step 6: Run local authenticated smoke test**

Run: `codex login status`

Expected: `Logged in using ChatGPT` or an explicitly configured API-key login.

Run: `npm run dev`

Expected: both configured Feishu WebSocket and console connectors start; a console prompt completes through Codex and produces no historical replay after process restart.

- [ ] **Step 7: Review acceptance criteria and commit**

Confirm every acceptance criterion in the design document has either an automated assertion or a recorded manual verification result.

Commit files: `git add src/index.ts README.md .env.example config.yaml tests/integration`, then `git commit -m "feat: integrate Codex app-server with Feishu-first UX"`.
