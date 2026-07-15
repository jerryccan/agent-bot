import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { RuntimeEvent } from "../../src/runtime/types.js";
import { CodexRuntime, type AppServerClientProvider } from "../../src/codex/CodexRuntime.js";

describe("CodexRuntime", () => {
  test("adds DPI-aware Windows screenshot instructions to every thread lifecycle request", async () => {
    const client = new FakeAppServerClient();
    let disconnect: ((error: Error) => void) | undefined;
    const runtime = new CodexRuntime({
      getClient: async () => client,
      close: vi.fn(),
      onDisconnect: (listener) => {
        disconnect = listener;
        return () => { disconnect = undefined; };
      },
    }, logger());

    await runtime.createSession({
      localSessionId: "created",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.resumeSession({
      localSessionId: "restored",
      remoteSessionId: "thr_restored",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("created", "first");
    disconnect?.(new Error("process exited"));
    await runtime.startTurn("created", "second");

    const lifecycleRequests = client.requests.filter(
      (request) => request.method === "thread/start" || request.method === "thread/resume",
    );
    expect(lifecycleRequests).toHaveLength(3);
    for (const request of lifecycleRequests) {
      expect(request.params).toEqual(expect.objectContaining({
        developerInstructions: expect.stringContaining("SetProcessDpiAwarenessContext"),
      }));
      const instructions = (request.params as { developerInstructions: string }).developerInstructions;
      expect(instructions).toContain("-4");
      expect(instructions).toContain("specific window");
      expect(instructions).toContain("DwmGetWindowAttribute");
      expect(instructions).toContain("DWMWA_EXTENDED_FRAME_BOUNDS");
      expect(instructions).toContain("GetWindowRect");
      expect(instructions).toContain("UI Automation");
      expect(instructions).toContain("bitmap dimensions");
    }
  });

  test("starts generated Codex task directories with projectless workspace metadata", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const workspaceRoot = path.join(os.homedir(), "Documents", "Codex");
    const cwd = path.join(workspaceRoot, "2026-07-15", "new-chat");

    await runtime.createSession({
      localSessionId: "projectless",
      agentName: "codex",
      cwd,
      permissionMode: "auto",
    });

    const request = client.requests.find((item) => item.method === "thread/start");
    expect(request?.params).toEqual(expect.objectContaining({
      cwd,
      threadSource: "user",
      developerInstructions: expect.stringMatching(/Projectless Chat[\s\S]*outputs/),
    }));
    expect(request?.params).not.toHaveProperty("runtimeWorkspaceRoots");
  });

  test("creates a thread and emits active turn deltas and completion", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    const session = await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const turnId = await runtime.startTurn("s1", "inspect the repo");
    expect(client.requests.find((request) => request.method === "turn/start")?.params).toEqual(
      expect.objectContaining({ effort: "medium", summary: "auto" }),
    );
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "item_1",
      delta: "hello",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed", durationMs: 1200 },
    });

    expect(session.remoteSessionId).toBe("thr_1");
    expect(session.reasoningEffort).toBe("medium");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_text_delta", text: "hello", turnId }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn_completed", finalResponse: "hello", durationMs: 1200 }),
    );
  });

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

  test("resume ignores history and historical notifications", async () => {
    const client = new FakeAppServerClient();
    client.resumeResult = {
      thread: {
        id: "thr_1",
        turns: [{ id: "old", items: [{ type: "agentMessage", id: "old_i", text: "already sent" }] }],
      },
      model: "gpt-test",
    };
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    await runtime.resumeSession({
      localSessionId: "s1",
      remoteSessionId: "thr_1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "old",
      itemId: "old_i",
      delta: "already sent",
    });

    expect(events).toEqual([]);
  });

  test("steers and interrupts the active turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const turnId = await runtime.startTurn("s1", "build it");

    await runtime.steerTurn("s1", turnId, "also update docs");
    await runtime.cancelTurn("s1", turnId);

    expect(client.requests).toContainEqual(
      expect.objectContaining({ method: "turn/steer", params: expect.objectContaining({ expectedTurnId: turnId }) }),
    );
    expect(client.requests).toContainEqual(
      expect.objectContaining({ method: "turn/interrupt", params: { threadId: "thr_1", turnId } }),
    );
  });

  test("auto approvals accept immediately and confirm approvals wait for a response", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const auto = await client.invokeRequest("item/commandExecution/requestApproval", 7, {
      threadId: "thr_1",
      turnId: "turn_1",
      command: "npm test",
    });
    expect(auto).toEqual({ decision: "accept" });

    await runtime.setPermissionMode("s1", "confirm");
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    const pending = client.invokeRequest("item/commandExecution/requestApproval", 8, {
      threadId: "thr_1",
      turnId: "turn_1",
      command: "npm test",
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "approval_requested")).toBe(true));
    await runtime.respondToApproval("s1", "8", "acceptForSession");
    await expect(pending).resolves.toEqual({ decision: "acceptForSession" });
  });

  test("fails an active turn on App Server exit and resumes the thread before the next turn", async () => {
    const client = new FakeAppServerClient();
    let disconnect: ((error: Error) => void) | undefined;
    const runtime = new CodexRuntime({
      getClient: async () => client,
      close: vi.fn(),
      onDisconnect: (listener) => {
        disconnect = listener;
        return () => { disconnect = undefined; };
      },
    }, logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    await runtime.startTurn("s1", "first");

    disconnect?.(new Error("process exited"));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_failed", message: expect.stringContaining("process exited") }));
    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();

    await runtime.startTurn("s1", "second");
    const methods = client.requests.map((request) => request.method);
    expect(methods.slice(-2)).toEqual(["thread/resume", "turn/start"]);
  });

  test("prefers a generated thread name and falls back to the thread preview", async () => {
    const client = new FakeAppServerClient();
    client.startResult = {
      thread: { id: "thr_1", name: "Generated title", preview: "First prompt" },
      model: "gpt-test",
      reasoningEffort: "medium",
    };
    client.resumeResult = {
      thread: { id: "thr_2", name: null, preview: "Restored first prompt", turns: [] },
      model: "gpt-test",
      reasoningEffort: "medium",
    };
    const runtime = new CodexRuntime(provider(client), logger());

    const created = await runtime.createSession({
      localSessionId: "created",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const resumed = await runtime.resumeSession({
      localSessionId: "resumed",
      remoteSessionId: "thr_2",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    expect(created.title).toBe("Generated title");
    expect(resumed.title).toBe("Restored first prompt");
  });

  test("updates task metadata from a thread name notification without an active turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      title: "Prompt fallback",
      permissionMode: "auto",
    });

    client.emit("thread/name/updated", { threadId: "thr_1", threadName: "Updated title" });
    client.emit("thread/name/updated", { threadId: "thr_1", threadName: "   " });

    expect(runtime.getSession("s1")?.title).toBe("Updated title");
    expect(events).toContainEqual({
      type: "session_metadata_updated",
      sessionId: "s1",
      title: "Updated title",
    });
    expect(events.filter((event) => event.type === "session_metadata_updated")).toHaveLength(1);
  });

  test("reads title-only metadata without loading thread turns", async () => {
    const client = new FakeAppServerClient();
    client.readResult = { thread: { id: "thr_1", name: null, preview: "  Legacy\n task  " } };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.readSessionMetadata("thr_1")).resolves.toEqual({ title: "Legacy task" });
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "thr_1", includeTurns: false },
    });
  });
});

class FakeAppServerClient {
  requests: Array<{ method: string; params: unknown }> = [];
  startResult: unknown = { thread: { id: "thr_1" }, model: "gpt-test", reasoningEffort: "medium" };
  resumeResult: unknown = { thread: { id: "thr_1", turns: [] }, model: "gpt-test", reasoningEffort: "medium" };
  readResult: unknown = { thread: { id: "thr_1", name: null, preview: "" } };
  private notificationListener?: (method: string, params: unknown) => void;
  private readonly requestHandlers = new Map<
    string,
    (params: unknown, id: string | number, method: string) => Promise<unknown>
  >();

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") return this.startResult as T;
    if (method === "thread/resume") return this.resumeResult as T;
    if (method === "thread/read") return this.readResult as T;
    if (method === "turn/start") return { turn: { id: "turn_1", status: "inProgress" } } as T;
    if (method === "model/list") return { data: [{
      id: "gpt-test",
      displayName: "GPT Test",
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" },
      ],
      defaultReasoningEffort: "medium",
    }] } as T;
    return {} as T;
  }

  notify(): void {}

  registerRequestHandler(
    method: string,
    handler: (params: unknown, id: string | number, method: string) => Promise<unknown>,
  ): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListener = listener;
    return () => {
      this.notificationListener = undefined;
    };
  }

  emit(method: string, params: unknown): void {
    this.notificationListener?.(method, params);
  }

  invokeRequest(method: string, id: string | number, params: unknown): Promise<unknown> {
    const handler = this.requestHandlers.get(method);
    if (!handler) throw new Error(`Missing request handler: ${method}`);
    return handler(params, id, method);
  }
}

function provider(client: FakeAppServerClient): AppServerClientProvider {
  return { getClient: async () => client, close: vi.fn() };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}
