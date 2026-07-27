# Model and Thinking Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/model` show the active model and reasoning effort, add `/thinking` display and mutation commands, and preserve compatible reasoning state across model changes and process restarts.

**Architecture:** Add `reasoningEffort` to the shared session contract and SQLite record, enrich normalized model metadata with supported/default efforts, and pass the selected value through `turn/start.effort`. Keep validation and user-facing behavior in `ProxySessionController`; runtime implementations only own capability transport and in-memory session state.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Codex App Server JSON-RPC v2, npm scripts.

## Global Constraints

- `/model` displays the current model and current reasoning effort; `/model <name>` continues to switch models.
- `/thinking` displays the current effort and the current model's supported values; `/thinking <level>` applies from the next turn.
- Supported efforts come from `model/list`, not a hard-coded enum.
- A model switch retains a compatible effort or atomically falls back to the new model's default effort.
- The active session is the only scope; no global default or graphical picker is added.
- ACP must report unsupported model/reasoning configuration explicitly.
- User-facing command responses remain concise and in Chinese.

---

### Task 1: Persist Reasoning Effort as Session State

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/state/StateStore.ts`
- Test: `tests/state/StateStore.test.ts`

**Interfaces:**
- Produces: `RuntimeSession.reasoningEffort?: string`.
- Produces: `CreateRuntimeSessionInput.reasoningEffort?: string` and inherited resume input.
- Produces: `SessionRecord.reasoningEffort?: string`, persisted as `sessions.reasoning_effort`.

- [ ] **Step 1: Write the failing persistence test**

Extend `persists Codex thread settings` in `tests/state/StateStore.test.ts`:

```ts
store.updateRuntimeSession("s1", {
  runtimeKind: "codex",
  remoteSessionId: "thr_1",
  model: "gpt-test",
  reasoningEffort: "high",
  permissionMode: "auto",
});

expect(store.getSession("s1")).toMatchObject({
  runtimeKind: "codex",
  remoteSessionId: "thr_1",
  model: "gpt-test",
  reasoningEffort: "high",
  permissionMode: "auto",
});
```

- [ ] **Step 2: Run the state test and verify RED**

Run: `npx vitest run tests/state/StateStore.test.ts`

Expected: FAIL because `reasoningEffort` is not accepted or persisted.

- [ ] **Step 3: Add shared session input and output state**

Add `reasoningEffort` to the existing session interfaces in `src/runtime/types.ts`:

```ts
export interface RuntimeSession {
  localSessionId: string;
  remoteSessionId: string;
  runtimeKind: RuntimeKind;
  agentName: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  activeTurnId?: string;
}

export interface CreateRuntimeSessionInput {
  localSessionId: string;
  agentName: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
}
```

- [ ] **Step 4: Add the additive SQLite column and mappings**

In `src/state/StateStore.ts`, add `reasoningEffort?: string` to `SessionRecord`, `reasoning_effort: string | null` to `SessionRow`, include `"reasoningEffort"` in `updateRuntimeSession`, write `reasoning_effort` in the SQL update, and map it in `mapSession`:

```ts
reasoningEffort: row.reasoning_effort ?? undefined,
```

Add the startup-safe column declaration:

```ts
["reasoning_effort", "TEXT"],
```

- [ ] **Step 5: Run the state test and typecheck**

Run: `npx vitest run tests/state/StateStore.test.ts && npm run typecheck`

Expected: State tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit the session-state slice**

```powershell
git add src/runtime/types.ts src/state/StateStore.ts tests/state/StateStore.test.ts
git commit -m "feat: persist reasoning effort"
```

---

### Task 2: Carry Reasoning Effort Through Runtime Implementations

**Files:**
- Modify: `src/codex/CodexRuntime.ts`
- Modify: `src/runtime/AcpRuntimeAdapter.ts`
- Modify: `src/runtime/types.ts`
- Test: `tests/codex/CodexRuntime.test.ts`
- Test: `tests/runtime/AcpRuntimeAdapter.test.ts`
- Test fixture: `tests/proxy/ProxySessionController.test.ts`
- Test fixture: `tests/integration/codex-flow.test.ts`

**Interfaces:**
- Consumes: `CreateRuntimeSessionInput.reasoningEffort` and `RuntimeSession.reasoningEffort` from Task 1.
- Produces: `AgentRuntime.setReasoningEffort(sessionId: string, effort: string): Promise<void>`.
- Produces: `ReasoningEffortOption { value: string; description?: string }`.
- Produces: `ModelOption.supportedReasoningEfforts` and `ModelOption.defaultReasoningEffort`.
- Produces: Codex session initialization from persisted or server-returned effort.
- Produces: `turn/start` requests containing `effort`.
- Produces: normalized model catalog effort metadata.

- [ ] **Step 1: Write failing Codex runtime tests**

Update the fake thread response in `tests/codex/CodexRuntime.test.ts` to include `reasoningEffort: "medium"`. In the create/start test assert:

```ts
expect(session.reasoningEffort).toBe("medium");
expect(client.requests.find((request) => request.method === "turn/start")?.params).toEqual(
  expect.objectContaining({ effort: "medium", summary: "auto" }),
);
```

Add a focused test:

```ts
test("persists a selected effort in runtime state and exposes model effort metadata", async () => {
  const client = new FakeAppServerClient();
  const runtime = new CodexRuntime(provider(client), logger());
  await runtime.createSession({
    localSessionId: "s1",
    agentName: "codex",
    cwd: process.cwd(),
    permissionMode: "auto",
    reasoningEffort: "high",
  });

  await runtime.setReasoningEffort("s1", "low");
  expect(runtime.getSession("s1")?.reasoningEffort).toBe("low");
  await expect(runtime.listModels()).resolves.toEqual([
    expect.objectContaining({
      id: "gpt-test",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { value: "low", description: "Fast" },
        { value: "medium", description: "Balanced" },
      ],
    }),
  ]);
});
```

Add the catalog-default fallback test:

```ts
test("uses the model default when a new thread omits reasoning effort", async () => {
  const client = new FakeAppServerClient();
  client.startResult = { thread: { id: "thr_1" }, model: "gpt-test", reasoningEffort: null };
  const runtime = new CodexRuntime(provider(client), logger());

  const session = await runtime.createSession({
    localSessionId: "s1",
    agentName: "codex",
    cwd: process.cwd(),
    permissionMode: "auto",
  });

  expect(session.reasoningEffort).toBe("medium");
});
```

Expose `startResult` on the fake client and return it from `thread/start`, mirroring the existing `resumeResult` test fixture.

Change the fake `model/list` result to include:

```ts
supportedReasoningEfforts: [
  { reasoningEffort: "low", description: "Fast" },
  { reasoningEffort: "medium", description: "Balanced" },
],
defaultReasoningEffort: "medium",
```

- [ ] **Step 2: Write the failing ACP unsupported test**

In `tests/runtime/AcpRuntimeAdapter.test.ts`, after creating an ACP session:

```ts
await expect(runtime.setReasoningEffort("s1", "high")).rejects.toThrow(
  "ACP runtime does not expose reasoning effort through Agent Bot.",
);
```

- [ ] **Step 3: Run focused runtime tests and verify RED**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts tests/runtime/AcpRuntimeAdapter.test.ts`

Expected: FAIL because effort state, transport, catalog mapping, and ACP method are missing.

- [ ] **Step 4: Extend the runtime capability contract**

Add to `src/runtime/types.ts`:

```ts
export interface ReasoningEffortOption {
  value: string;
  description?: string;
}

export interface ModelOption {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort?: string;
}
```

Add this method to `AgentRuntime`:

```ts
setReasoningEffort(sessionId: string, effort: string): Promise<void>;
```

Add `setReasoningEffort: vi.fn(async () => undefined)` and complete model metadata to the `AgentRuntime` fixtures in `tests/proxy/ProxySessionController.test.ts` and `tests/integration/codex-flow.test.ts` so the shared contract remains type-correct.

- [ ] **Step 5: Implement Codex effort state and transport**

Extend the internal response and model-list shapes in `src/codex/CodexRuntime.ts`:

```ts
interface ThreadResponse {
  thread: { id: string };
  model?: string;
  reasoningEffort?: string | null;
}
```

Resolve effort before `makeSession`; persisted input wins, then the App Server response, then the selected model's catalog default:

```ts
const model = input.model ?? response.model;
const reasoningEffort = input.reasoningEffort
  ?? response.reasoningEffort
  ?? (await this.listModels()).find((item) => item.id === model)?.defaultReasoningEffort;
const session = this.makeSession(input, response.thread.id, response.model, reasoningEffort);
```

Add the resolved argument in `makeSession`:

```ts
reasoningEffort,
```

Include it in lifecycle resume input state and every turn:

```ts
effort: session.reasoningEffort,
```

Implement:

```ts
async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
  this.requireSession(sessionId).reasoningEffort = effort;
}
```

Normalize catalog fields:

```ts
supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({
  value: option.reasoningEffort,
  description: option.description,
})),
defaultReasoningEffort: model.defaultReasoningEffort,
```

- [ ] **Step 6: Implement explicit ACP rejection**

Add to `src/runtime/AcpRuntimeAdapter.ts`:

```ts
async setReasoningEffort(): Promise<void> {
  throw new Error("ACP runtime does not expose reasoning effort through Agent Bot.");
}
```

Initialize ACP session `reasoningEffort` from input only so persisted records remain structurally intact without claiming support.

- [ ] **Step 7: Run runtime tests and typecheck**

Run: `npx vitest run tests/codex/CodexRuntime.test.ts tests/runtime/AcpRuntimeAdapter.test.ts && npm run typecheck`

Expected: PASS with zero failures and no TypeScript errors.

- [ ] **Step 8: Commit the runtime slice**

```powershell
git add src/runtime/types.ts src/codex/CodexRuntime.ts src/runtime/AcpRuntimeAdapter.ts tests/codex/CodexRuntime.test.ts tests/runtime/AcpRuntimeAdapter.test.ts tests/proxy/ProxySessionController.test.ts tests/integration/codex-flow.test.ts
git commit -m "feat: propagate Codex reasoning effort"
```

---

### Task 3: Implement `/model` and `/thinking` Command Behavior

**Files:**
- Modify: `src/commands/commandTypes.ts`
- Modify: `src/commands/CommandRouter.ts`
- Modify: `src/proxy/ProxySessionController.ts`
- Test: `tests/commands/CommandRouter.test.ts`
- Test: `tests/proxy/ProxySessionController.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime.listModels`, `setModel`, `setReasoningEffort`, and persisted `SessionRecord.reasoningEffort`.
- Produces: `{ type: "thinking"; effort?: string }` command.
- Produces: model display, effort display, validated effort mutation, and compatible/default model-switch behavior.

- [ ] **Step 1: Write failing parser tests**

Add to `tests/commands/CommandRouter.test.ts`:

```ts
test("parses thinking display and selection", () => {
  expect(router.parse("/thinking")).toEqual({ type: "thinking" });
  expect(router.parse("/thinking high")).toEqual({ type: "thinking", effort: "high" });
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npx vitest run tests/commands/CommandRouter.test.ts`

Expected: FAIL because `/thinking` is currently forwarded as a prompt.

- [ ] **Step 3: Add command parsing**

Add to `Command` in `src/commands/commandTypes.ts`:

```ts
| { type: "thinking"; effort?: string }
```

Add to the router switch:

```ts
case "thinking":
  return { type: "thinking", effort: args[0] };
```

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `npx vitest run tests/commands/CommandRouter.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing controller display and mutation tests**

Enrich the controller fake catalog with two models:

```ts
listModels: vi.fn(async () => [
  {
    id: "gpt-test",
    displayName: "GPT Test",
    isDefault: true,
    supportedReasoningEfforts: [
      { value: "low", description: "Fast" },
      { value: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "low",
  },
  {
    id: "gpt-next",
    displayName: "GPT Next",
    supportedReasoningEfforts: [{ value: "medium", description: "Balanced" }],
    defaultReasoningEffort: "medium",
  },
]),
```

Make fake create sessions start with `model: "gpt-test"` and `reasoningEffort: "high"`, and make fake setters update the session map. Add tests that assert:

```ts
await controller.onMessage(message("start"));
await controller.onMessage(message("/model"));
expect(outbound.sendText).toHaveBeenCalledWith(
  "chat_id:c1",
  expect.stringMatching(/当前模型：gpt-test[\s\S]*当前思考强度：high/),
);

await controller.onMessage(message("/thinking"));
expect(outbound.sendMarkdown).toHaveBeenCalledWith(
  "chat_id:c1",
  expect.stringContaining("当前思考强度：high"),
);
expect(outbound.sendMarkdown).toHaveBeenCalledWith(
  "chat_id:c1",
  expect.stringContaining("`low`：Fast"),
);

await controller.onMessage(message("/thinking low"));
expect(runtime.setReasoningEffort).toHaveBeenCalledWith(expect.any(String), "low");
expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ reasoningEffort: "low" });
```

Add an invalid-level test that expects an error containing `支持的强度：low、high` and asserts `setReasoningEffort` was not called.

Add model-switch tests for both paths:

```ts
await controller.onMessage(message("/model gpt-test"));
expect(runtime.setReasoningEffort).not.toHaveBeenCalled();

await controller.onMessage(message("/model gpt-next"));
expect(runtime.setModel).toHaveBeenCalledWith(expect.any(String), "gpt-next");
expect(runtime.setReasoningEffort).toHaveBeenCalledWith(expect.any(String), "medium");
expect(store.listSessions("chat_id:c1")[0]).toMatchObject({
  model: "gpt-next",
  reasoningEffort: "medium",
});
expect(outbound.sendText).toHaveBeenCalledWith(
  "chat_id:c1",
  expect.stringContaining("思考强度已自动调整为 medium"),
);
```

- [ ] **Step 6: Run controller tests and verify RED**

Run: `npx vitest run tests/proxy/ProxySessionController.test.ts`

Expected: FAIL because display, validation, persistence, and fallback behavior are absent.

- [ ] **Step 7: Implement controller behavior**

Route `thinking` in `execute`. Replace no-argument model listing with:

```ts
await this.outbound.sendText(
  contextKey,
  [`当前模型：${loaded.session.model ?? "默认"}`, `当前思考强度：${loaded.session.reasoningEffort ?? "默认"}`].join("\n"),
);
```

Implement model mutation with catalog validation and one persistence write:

```ts
const models = await loaded.runtime.listModels();
const selected = models.find((item) => item.id === model);
if (!selected) throw new Error(`未知模型：${model}`);
const currentEffort = loaded.session.reasoningEffort;
const compatible = currentEffort
  ? selected.supportedReasoningEfforts.some((option) => option.value === currentEffort)
  : false;
const nextEffort = compatible ? currentEffort : selected.defaultReasoningEffort;

await loaded.runtime.setModel(loaded.record.localSessionId, model);
if (nextEffort && nextEffort !== currentEffort) {
  await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, nextEffort);
}
this.store.updateRuntimeSession(loaded.record.localSessionId, {
  model,
  reasoningEffort: nextEffort,
});
```

Implement `thinking(contextKey: string, effort?: string)` with this validation flow:

```ts
private async thinking(contextKey: string, effort?: string): Promise<void> {
  const loaded = await this.loadSession(this.requireCurrentSession(contextKey));
  const models = await loaded.runtime.listModels();
  const currentModel = models.find((item) => item.id === loaded.session.model)
    ?? models.find((item) => item.isDefault);
  if (!currentModel) throw new Error("当前运行时没有可配置思考强度的模型。");
  const supported = currentModel.supportedReasoningEfforts;

  if (!effort) {
    const lines = supported.map((option) =>
      `- ${asInlineCode(option.value)}${option.description ? `：${option.description}` : ""}`
    );
    await this.outbound.sendMarkdown(contextKey, [
      `当前思考强度：${loaded.session.reasoningEffort ?? currentModel.defaultReasoningEffort ?? "默认"}`,
      "可选强度：",
      lines.join("\n") || "无",
    ].join("\n"));
    return;
  }

  if (!supported.some((option) => option.value === effort)) {
    throw new Error(`不支持的思考强度：${effort}。支持的强度：${supported.map((option) => option.value).join("、") || "无"}`);
  }
  await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, effort);
  this.store.updateRuntimeSession(loaded.record.localSessionId, { reasoningEffort: effort });
  await this.outbound.sendText(contextKey, `思考强度已切换为 ${effort}，从下一次请求生效。`);
}
```

Pass `reasoningEffort: record.reasoningEffort` through create/resume inputs in `loadSession`, and include `session.reasoningEffort` in `persistRuntimeSession`.

Add these help lines:

```ts
"- `/model`：显示当前模型和思考强度",
"- `/model <name>`：切换模型",
"- `/thinking`：显示当前思考强度及可选值",
"- `/thinking <level>`：设置思考强度",
```

- [ ] **Step 8: Run controller and integration tests**

Run: `npx vitest run tests/commands/CommandRouter.test.ts tests/proxy/ProxySessionController.test.ts tests/integration/codex-flow.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 9: Commit the command slice**

```powershell
git add src/commands/commandTypes.ts src/commands/CommandRouter.ts src/proxy/ProxySessionController.ts tests/commands/CommandRouter.test.ts tests/proxy/ProxySessionController.test.ts
git commit -m "feat: add thinking command controls"
```

---

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Test: all tests and compiler checks

**Interfaces:**
- Consumes: final command syntax and behavior from Task 3.
- Produces: user-facing documentation and fresh completion evidence.

- [ ] **Step 1: Update command documentation**

Replace the existing model bullets and add thinking bullets in `README.md`:

```md
- `/model`：显示当前模型和思考强度。
- `/model <name>`：切换模型，从下一次请求生效；不兼容的思考强度会自动回落到新模型默认值。
- `/thinking`：显示当前思考强度及当前模型支持的可选值。
- `/thinking <level>`：设置思考强度，从下一次请求生效。
```

- [ ] **Step 2: Run formatting-neutral diff checks**

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: all Vitest files and tests PASS with zero failures.

- [ ] **Step 4: Run compiler and production build verification**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0 with no TypeScript errors.

- [ ] **Step 5: Review the final diff against the design**

Run:

```powershell
git status --short
git diff --stat HEAD~3
git log -4 --oneline
```

Expected: only the planned command/runtime/state/docs files are changed or committed; every design requirement maps to a passing test.

- [ ] **Step 6: Commit documentation**

```powershell
git add README.md src/proxy/ProxySessionController.ts
git commit -m "docs: explain model thinking controls"
```
