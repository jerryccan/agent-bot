import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { RuntimeEvent, RuntimeGoal } from "../../src/runtime/types.js";
import { CodexRuntime, type AppServerClientProvider } from "../../src/codex/CodexRuntime.js";

describe("CodexRuntime", () => {
  test("sends text and local images as Codex app-server user input blocks", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    const turnId = await runtime.startTurn("s1", {
      text: "检查这张截图",
      localImagePaths: ["D:\\captures\\screen.png"],
    });
    await runtime.steerTurn("s1", turnId, {
      text: "再看这张",
      localImagePaths: ["D:\\captures\\detail.jpg"],
    });

    expect(client.requests.find((request) => request.method === "turn/start")?.params).toEqual(
      expect.objectContaining({
        input: [
          { type: "text", text: "检查这张截图", text_elements: [] },
          { type: "localImage", path: "D:\\captures\\screen.png" },
        ],
      }),
    );
    expect(client.requests.find((request) => request.method === "turn/steer")?.params).toEqual(
      expect.objectContaining({
        input: [
          { type: "text", text: "再看这张", text_elements: [] },
          { type: "localImage", path: "D:\\captures\\detail.jpg" },
        ],
      }),
    );
  });

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

  test("forks a thread through the requested completed turn", async () => {
    const client = new FakeAppServerClient();
    client.forkResult = {
      thread: { id: "thr_forked", name: "Forked task" },
      model: "gpt-test",
      reasoningEffort: "high",
    };
    const runtime = new CodexRuntime(provider(client), logger());

    const session = await runtime.forkSession({
      localSessionId: "forked_local",
      remoteSessionId: "thr_source",
      lastTurnId: "turn_anchor",
      agentName: "codex",
      cwd: process.cwd(),
      title: "Forked task（分支 1）",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });

    expect(session).toMatchObject({
      localSessionId: "forked_local",
      remoteSessionId: "thr_forked",
      title: "Forked task（分支 1）",
    });
    expect(client.requests).toContainEqual({
      method: "thread/fork",
      params: expect.objectContaining({
        threadId: "thr_source",
        lastTurnId: "turn_anchor",
        cwd: process.cwd(),
        model: "gpt-test",
        threadSource: "user",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    });
    expect(client.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thr_forked", name: "Forked task（分支 1）" },
    });
  });

  test("sets an explicit title immediately after creating a thread", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());

    const session = await runtime.createSession({
      localSessionId: "titled_local",
      agentName: "codex",
      cwd: process.cwd(),
      title: "  修复   会话列表  ",
      permissionMode: "auto",
    });

    expect(client.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thr_1", name: "修复 会话列表" },
    });
    expect(session.title).toBe("修复 会话列表");
  });

  test("renames a thread through thread/name/set", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    await runtime.createSession({
      localSessionId: "renamed_local",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await runtime.setTitle("renamed_local", "  Renamed   task  ");

    expect(client.requests).toContainEqual({
      method: "thread/name/set",
      params: { threadId: "thr_1", name: "Renamed task" },
    });
    expect(runtime.getSession("renamed_local")?.title).toBe("Renamed task");
  });

  test("manages a persisted thread goal and adopts its automatic continuation turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "goal_local",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await expect(runtime.getGoal("goal_local")).resolves.toBeUndefined();
    const goal = await runtime.setGoal("goal_local", {
      objective: "完成迁移并通过全部测试",
      status: "active",
    });
    expect(goal).toMatchObject({ objective: "完成迁移并通过全部测试", status: "active" });
    await runtime.setGoal("goal_local", { status: "paused" });

    client.emit("turn/started", {
      threadId: "thr_1",
      turn: { id: "goal_turn_1", status: "inProgress", startedAt: 42 },
    });
    expect(events).toContainEqual({
      type: "turn_started",
      sessionId: "goal_local",
      turnId: "goal_turn_1",
      startedAt: 42_000,
    });

    await expect(runtime.clearGoal("goal_local")).resolves.toBe(true);
    expect(client.requests).toContainEqual({
      method: "thread/goal/get",
      params: { threadId: "thr_1" },
    });
    expect(client.requests).toContainEqual({
      method: "thread/goal/set",
      params: { threadId: "thr_1", objective: "完成迁移并通过全部测试", status: "active" },
    });
    expect(client.requests).toContainEqual({
      method: "thread/goal/set",
      params: { threadId: "thr_1", status: "paused" },
    });
    expect(client.requests).toContainEqual({
      method: "thread/goal/clear",
      params: { threadId: "thr_1" },
    });
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
    client.emit("thread/tokenUsage/updated", {
      threadId: "thr_1",
      turnId,
      tokenUsage: {
        total: { inputTokens: 98_765, cachedInputTokens: 90_000, outputTokens: 500, totalTokens: 99_265 },
        last: { inputTokens: 12_345, cachedInputTokens: 10_000, outputTokens: 100, totalTokens: 12_445 },
        modelContextWindow: 200_000,
      },
    });
    client.emit("item/started", {
      threadId: "thr_1",
      turnId,
      item: { type: "commandExecution", id: "command_1", command: "npm test", status: "inProgress" },
    });
    client.emit("item/commandExecution/outputDelta", {
      threadId: "thr_1",
      turnId,
      itemId: "command_1",
      delta: "running tests\n",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed", durationMs: 1200 },
    });

    expect(session.remoteSessionId).toBe("thr_1");
    expect(session.reasoningEffort).toBe("medium");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_text_delta", text: "hello", turnId }));
    expect(events).toContainEqual({
      type: "token_usage_updated",
      sessionId: "s1",
      turnId,
      lastTokens: 2_445,
      cumulativeTokens: 9_265,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_started",
      turnId,
      tool: expect.objectContaining({ id: "command_1", status: "running" }),
    }));
    expect(events).toContainEqual({
      type: "tool_output_delta",
      sessionId: "s1",
      turnId,
      toolId: "command_1",
      delta: "running tests\n",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn_completed", finalResponse: "hello", durationMs: 1200 }),
    );
  });

  test("routes commentary messages to the timeline and keeps only final-answer text in the response", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    const turnId = await runtime.startTurn("s1", "explain it");

    client.emit("item/started", {
      threadId: "thr_1",
      turnId,
      item: { type: "agentMessage", id: "commentary_1", text: "", phase: "commentary" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "commentary_1",
      delta: "我先检查官方文档。",
    });
    client.emit("item/started", {
      threadId: "thr_1",
      turnId,
      item: { type: "agentMessage", id: "final_1", text: "", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId,
      itemId: "final_1",
      delta: "这是最终结论。",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: turnId, status: "completed" },
    });

    expect(events).toContainEqual({
      type: "progress",
      sessionId: "s1",
      turnId,
      activityId: "commentary:commentary_1",
      text: "我先检查官方文档。",
      append: true,
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "agent_text_delta",
      text: "我先检查官方文档。",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_text_delta",
      text: "这是最终结论。",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      finalResponse: "这是最终结论。",
    }));
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
    const log = logger();
    const runtime = new CodexRuntime(provider(client), log);
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
    expect(client.timeouts).toContainEqual({ method: "turn/steer", timeoutMs: 10_000 });
    expect(client.timeouts).toContainEqual({ method: "turn/interrupt", timeoutMs: 10_000 });
    expect(log.info).toHaveBeenCalledWith(
      { sessionId: "s1", threadId: "thr_1", turnId },
      "Codex accepted the turn interrupt request.",
    );
  });

  test("reconciles a stale active turn and recovers the latest completed result", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({
      localSessionId: "s1",
      agentName: "codex",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await runtime.startTurn("s1", "monitor it");
    client.readResult = {
      thread: {
        id: "thr_1",
        status: { type: "idle" },
        turns: [
          { id: "turn_1", status: "completed", items: [], startedAt: 10, durationMs: 100 },
          {
            id: "turn_2",
            status: "completed",
            startedAt: 20,
            durationMs: 250,
            items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "最新执行结果" }],
          },
        ],
      },
    };

    await runtime.synchronizeSession("s1");

    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();
    expect(events).toContainEqual({ type: "turn_cancelled", sessionId: "s1", turnId: "turn_1" });
    expect(events).toContainEqual({ type: "turn_started", sessionId: "s1", turnId: "turn_2", startedAt: 20_000 });
    expect(events).toContainEqual({
      type: "turn_completed",
      sessionId: "s1",
      turnId: "turn_2",
      finalResponse: "最新执行结果",
      durationMs: 250,
    });
  });

  test("tracks a live Codex turn that supersedes the locally active turn", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    await runtime.startTurn("s1", "start");

    client.emit("turn/started", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "inProgress", startedAt: 42, items: [] },
    });
    client.emit("item/started", {
      threadId: "thr_1",
      turnId: "turn_2",
      item: { type: "agentMessage", id: "final_2", phase: "final_answer" },
    });
    client.emit("item/agentMessage/delta", {
      threadId: "thr_1",
      turnId: "turn_2",
      itemId: "final_2",
      delta: "done",
    });
    client.emit("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_2", status: "completed" },
    });

    expect(events).toContainEqual({ type: "turn_cancelled", sessionId: "s1", turnId: "turn_1" });
    expect(events).toContainEqual({ type: "turn_started", sessionId: "s1", turnId: "turn_2", startedAt: 42_000 });
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_2",
      finalResponse: "done",
    }));
    expect(runtime.getSession("s1")?.activeTurnId).toBeUndefined();
  });

  test("reconciles an idle thread status notification when completion was missed", async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexRuntime(provider(client), logger());
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.createSession({ localSessionId: "s1", agentName: "codex", cwd: process.cwd(), permissionMode: "auto" });
    await runtime.startTurn("s1", "start");
    client.readResult = {
      thread: {
        id: "thr_1",
        status: { type: "idle" },
        turns: [{
          id: "turn_1",
          status: "completed",
          startedAt: 1,
          durationMs: 50,
          items: [{ type: "agentMessage", phase: "final_answer", text: "recovered" }],
        }],
      },
    };

    client.emit("thread/status/changed", { threadId: "thr_1", status: { type: "idle" } });

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_1",
      finalResponse: "recovered",
    })));
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

  test("discovers and inspects existing Codex sessions without resuming them", async () => {
    const client = new FakeAppServerClient();
    client.listResult = {
      data: [{
        id: "external_1",
        name: "Desktop task",
        preview: "first prompt",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        createdAt: 80,
        updatedAt: 100,
        recencyAt: 90,
        status: { type: "notLoaded" },
        turns: [],
      }],
      nextCursor: "next",
    };
    client.readResult = {
      thread: {
        id: "external_1",
        name: "Desktop task",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        updatedAt: 100,
        status: { type: "notLoaded" },
        turns: [{
          id: "turn_external",
          status: "completed",
          items: [
            { type: "commandExecution", status: "completed" },
            { type: "mcpToolCall", status: "failed" },
            { type: "agentMessage", phase: "final_answer", text: "done" },
          ],
        }],
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.listRemoteSessions({ searchTerm: "Desktop", limit: 10 })).resolves.toEqual({
      sessions: [expect.objectContaining({
        id: "external_1",
        title: "Desktop task",
        source: "vscode",
        createdAt: 80,
        recencyAt: 90,
        lastTurnStatus: "completed",
      })],
      nextCursor: "next",
    });
    await expect(runtime.readRemoteSession("external_1")).resolves.toEqual(expect.objectContaining({
      id: "external_1",
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
      lastTurnToolCount: 2,
      lastTurnCompletedToolCount: 1,
      lastTurnFailedToolCount: 1,
      lastTurnRunningToolCount: 0,
    }));
    expect(client.requests.filter((request) => request.method === "thread/resume")).toHaveLength(0);
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "external_1", includeTurns: true },
    });
    expect(client.requests).toContainEqual(expect.objectContaining({
      method: "thread/list",
      params: expect.objectContaining({ searchTerm: "Desktop", limit: 10 }),
    }));
  });

  test("does not treat a stale inProgress turn from an unloaded app-server as active", async () => {
    const client = new FakeAppServerClient();
    client.listResult = {
      data: [{
        id: "stale_external",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        status: { type: "notLoaded" },
        turns: [{ id: "stale_turn", status: "inProgress", items: [] }],
      }],
    };
    client.readResult = {
      thread: {
        id: "stale_external",
        cwd: "D:\\work\\desktop",
        source: "vscode",
        status: { type: "notLoaded" },
        turns: [{ id: "stale_turn", status: "inProgress", items: [] }],
      },
    };
    const runtime = new CodexRuntime(provider(client), logger());

    await expect(runtime.listRemoteSessions()).resolves.toEqual({
      sessions: [expect.objectContaining({
        id: "stale_external",
        status: "not_loaded",
        lastTurnId: "stale_turn",
        lastTurnStatus: undefined,
      })],
      nextCursor: undefined,
    });
    expect(client.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "stale_external", includeTurns: true },
    });
  });
});

class FakeAppServerClient {
  requests: Array<{ method: string; params: unknown }> = [];
  timeouts: Array<{ method: string; timeoutMs: number | undefined }> = [];
  startResult: unknown = { thread: { id: "thr_1" }, model: "gpt-test", reasoningEffort: "medium" };
  resumeResult: unknown = { thread: { id: "thr_1", turns: [] }, model: "gpt-test", reasoningEffort: "medium" };
  forkResult: unknown = { thread: { id: "thr_forked", turns: [] }, model: "gpt-test", reasoningEffort: "medium" };
  readResult: unknown = { thread: { id: "thr_1", name: null, preview: "" } };
  listResult: unknown = { data: [], nextCursor: null };
  goalResult: RuntimeGoal | null = null;
  private notificationListener?: (method: string, params: unknown) => void;
  private readonly requestHandlers = new Map<
    string,
    (params: unknown, id: string | number, method: string) => Promise<unknown>
  >();

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.requests.push({ method, params });
    this.timeouts.push({ method, timeoutMs });
    if (method === "thread/start") return this.startResult as T;
    if (method === "thread/resume") return this.resumeResult as T;
    if (method === "thread/fork") return this.forkResult as T;
    if (method === "thread/read") return this.readResult as T;
    if (method === "thread/list") return this.listResult as T;
    if (method === "thread/goal/get") return { goal: this.goalResult } as T;
    if (method === "thread/goal/set") {
      const update = params as Partial<RuntimeGoal>;
      this.goalResult = {
        threadId: "thr_1",
        objective: update.objective ?? this.goalResult?.objective ?? "",
        status: update.status ?? this.goalResult?.status ?? "active",
        tokenBudget: update.tokenBudget ?? this.goalResult?.tokenBudget ?? null,
        tokensUsed: this.goalResult?.tokensUsed ?? 0,
        timeUsedSeconds: this.goalResult?.timeUsedSeconds ?? 0,
        createdAt: this.goalResult?.createdAt ?? 1_776_272_400,
        updatedAt: 1_776_272_460,
      };
      return { goal: this.goalResult } as T;
    }
    if (method === "thread/goal/clear") {
      const cleared = this.goalResult !== null;
      this.goalResult = null;
      return { cleared } as T;
    }
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
