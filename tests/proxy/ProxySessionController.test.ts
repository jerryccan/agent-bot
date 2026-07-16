import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import type { FeishuOutbound, IncomingMessage } from "../../src/feishu/types.js";
import type { TurnPresenter } from "../../src/presentation/OutboundRouter.js";
import { OutboundRouter } from "../../src/presentation/OutboundRouter.js";
import { ProxySessionController } from "../../src/proxy/ProxySessionController.js";
import { AgentRuntimeRegistry } from "../../src/runtime/AgentRuntimeRegistry.js";
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from "../../src/runtime/types.js";
import { StateStore } from "../../src/state/StateStore.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function message(text: string): IncomingMessage {
  return { messageId: `m-${text}`, contextKey: "chat_id:c1", text };
}

function fixture() {
  const sessions = new Map<string, RuntimeSession>();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const runtime: AgentRuntime = {
    kind: "codex",
    createSession: vi.fn(async (input) => {
      const session: RuntimeSession = {
        ...input,
        remoteSessionId: "thr_1",
        runtimeKind: "codex",
        model: input.model ?? "gpt-test",
        reasoningEffort: input.reasoningEffort ?? "high",
      };
      sessions.set(input.localSessionId, session);
      return session;
    }),
    resumeSession: vi.fn(async (input) => {
      const session: RuntimeSession = {
        ...input,
        runtimeKind: "codex",
        model: input.model ?? "gpt-test",
        reasoningEffort: input.reasoningEffort ?? "high",
      };
      sessions.set(input.localSessionId, session);
      return session;
    }),
    getSession: vi.fn((id) => sessions.get(id)),
    readSessionMetadata: vi.fn(async () => ({})),
    startTurn: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId)!;
      session.activeTurnId = "turn_1";
      for (const listener of listeners) listener({ type: "turn_started", sessionId, turnId: "turn_1", startedAt: 1 });
      return "turn_1";
    }),
    steerTurn: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    setModel: vi.fn(async (sessionId, model) => {
      sessions.get(sessionId)!.model = model;
    }),
    setReasoningEffort: vi.fn(async (sessionId, effort) => {
      sessions.get(sessionId)!.reasoningEffort = effort;
    }),
    setPermissionMode: vi.fn(async () => undefined),
    respondToApproval: vi.fn(async () => undefined),
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
    onEvent: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    close: vi.fn(),
  };
  const acp = { ...runtime, kind: "acp" as const } as AgentRuntime;
  const outbound: FeishuOutbound = {
    sendText: vi.fn(async () => "text"),
    sendMarkdown: vi.fn(async () => "markdown"),
    sendInteractiveCard: vi.fn(async () => "card"),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
  const presenter: TurnPresenter = {
    registerSession: vi.fn(),
    updateSessionTitle: vi.fn(),
    unregisterSession: vi.fn(),
    startPendingTurn: vi.fn(async () => undefined),
    failPendingTurn: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => undefined),
    showDetails: vi.fn(async () => undefined),
    resumeDelivery: vi.fn(async () => undefined),
    flushAll: vi.fn(async () => undefined),
  };
  const outboundRouter = new OutboundRouter([{ matches: () => true, outbound, presenter }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-"));
  tempDirs.push(dir);
  const store = new StateStore(path.join(dir, "state.sqlite"));
  const config = {
    agents: { codex: { kind: "codex", title: "Codex", command: "codex", args: [], env: {} } },
    defaults: { agent: "codex", cwd: process.cwd() },
  } as unknown as AppConfig;
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const controller = new ProxySessionController(config, store, new AgentRuntimeRegistry({ acp, codex: runtime }), outboundRouter, logger);
  cleanups.push(() => {
    controller.close();
    store.close();
  });
  return { controller, runtime, sessions, outbound, presenter, store, listeners };
}

describe("ProxySessionController", () => {
  test("plain text creates the default Codex session and starts a turn", async () => {
    const { controller, runtime, store, presenter } = fixture();
    await controller.onMessage(message("inspect this repo"));

    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(expect.any(String), "chat_id:c1", "inspect this repo");
    expect((presenter.startPendingTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "inspect this repo");
    expect(presenter.registerSession).toHaveBeenCalledWith(expect.any(String), "chat_id:c1", "inspect this repo");
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ runtimeKind: "codex", remoteSessionId: "thr_1" });
  });

  test("creates a Desktop-compatible projectless workspace when a new Codex task omits cwd", async () => {
    const { controller, runtime } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "acp-projectless-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage(message("/new"));

    const input = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const projectlessRoot = path.join(home, "Documents", "Codex");
    const relativeCwd = path.relative(projectlessRoot, input.cwd);
    expect(relativeCwd).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]new-chat$/);
    expect(input.cwd).not.toBe(projectlessRoot);
    expect(fs.statSync(input.cwd).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(input.cwd, "work")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(input.cwd, "outputs")).isDirectory()).toBe(true);
  });

  test("keeps the first ordinary prompt as the task title fallback", async () => {
    const { controller, store } = fixture();

    await controller.onMessage(message("  inspect\n this repo  "));
    await controller.onMessage(message("also update docs"));

    expect(store.listSessions("chat_id:c1")[0]?.title).toBe("inspect this repo");
  });

  test("persists runtime title metadata and refreshes the turn presenter", async () => {
    const { controller, store, presenter, listeners } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.listSessions("chat_id:c1")[0]!.localSessionId;

    for (const listener of listeners) {
      listener({ type: "session_metadata_updated", sessionId, title: "Generated title" });
    }

    await vi.waitFor(() => expect(store.getSession(sessionId)?.title).toBe("Generated title"));
    expect(presenter.onEvent).not.toHaveBeenCalled();
    expect(presenter.updateSessionTitle).toHaveBeenCalledWith(sessionId, "Generated title");
  });

  test("ignores a duplicate inbound message id", async () => {
    const { controller, runtime } = fixture();
    const duplicate = { messageId: "same-event", contextKey: "chat_id:c1", text: "inspect" };
    await controller.onMessage(duplicate);
    await controller.onMessage(duplicate);
    expect(runtime.startTurn).toHaveBeenCalledOnce();
  });

  test("plain text steers an active turn and cancel bypasses prompt completion", async () => {
    const { controller, runtime } = fixture();
    await controller.onMessage(message("build it"));
    await controller.onMessage(message("also update docs"));
    await controller.onMessage(message("/cancel"));

    expect(runtime.steerTurn).toHaveBeenCalledWith(expect.any(String), "turn_1", "also update docs");
    expect(runtime.cancelTurn).toHaveBeenCalledWith(expect.any(String), "turn_1");
  });

  test("lazily resumes a persisted session before starting the next turn", async () => {
    const { controller, runtime, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({ localSessionId: "saved", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready" });
    store.updateRuntimeSession("saved", {
      runtimeKind: "codex",
      remoteSessionId: "thr_saved",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "saved");

    await controller.onMessage(message("continue"));
    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "saved",
      remoteSessionId: "thr_saved",
      reasoningEffort: "high",
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith("saved", "continue");
  });

  test("handles model, permissions, details, and approval actions", async () => {
    const { controller, runtime, presenter } = fixture();
    await controller.onMessage(message("start"));
    const sessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    await controller.onMessage(message("/model gpt-test"));
    await controller.onMessage(message("/permissions confirm"));
    await controller.onCardAction({ actionId: "a1", contextKey: "chat_id:c1", value: { action: "turn_details", turnId: "turn_1" } });
    await controller.onCardAction({
      actionId: "a2",
      contextKey: "chat_id:c1",
      value: { action: "approval", sessionId, requestId: "req_1", decision: "accept" },
    });

    expect(runtime.setModel).toHaveBeenCalledWith(sessionId, "gpt-test");
    expect(runtime.setPermissionMode).toHaveBeenCalledWith(sessionId, "confirm");
    expect(presenter.showDetails).toHaveBeenCalledWith("chat_id:c1", "turn_1");
    expect(runtime.respondToApproval).toHaveBeenCalledWith(sessionId, "req_1", "accept");
  });

  test("shows every supported model and marks the current model", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/model"));

    expect(runtime.listModels).toHaveBeenCalled();
    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringMatching(/当前模型：`gpt-test`[\s\S]*当前思考强度：high[\s\S]*✅ `gpt-test`（当前）[\s\S]*`gpt-next`/),
    );
  });

  test("shows and changes supported reasoning efforts", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));

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
  });

  test("rejects unsupported reasoning efforts without changing state", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/thinking extreme"));

    expect(runtime.setReasoningEffort).not.toHaveBeenCalled();
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ reasoningEffort: "high" });
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("支持的强度：low、high"),
    );
  });

  test("retains compatible effort and falls back for an incompatible model", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));

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
  });

  test("rejects an unknown model without changing runtime state", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/model missing-model"));

    expect(runtime.setModel).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("未知模型：missing-model"),
    );
  });

  test("shows a rich status summary for the current task", async () => {
    const { controller, outbound } = fixture();
    await controller.onMessage(message("inspect this repo"));

    await controller.onMessage(message("/status"));

    const markdown = (outbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string;
    expect(markdown).toMatch(/### 当前任务/);
    expect(markdown).toContain("**标题**：inspect this repo");
    expect(markdown).toContain("**状态**：执行中");
    expect(markdown).toContain("**模型 / 思考强度**：`gpt-test` / `high`");
    expect(markdown).toContain("**权限模式**：自动执行");
    expect(markdown).toContain("**任务范围**：未指定项目");
    expect(markdown).toContain("**Codex 任务 ID**：`thr_1`");
    expect(markdown).toContain("### acp-bot");
    expect(markdown).toContain("**任务统计**：共 1 个");
  });

  test("renders grouped help without repeating command entries", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/help"));

    const markdown = (outbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string;
    expect(markdown).toContain("### 任务");
    expect(markdown).toContain("### 模型与执行");
    expect(markdown).toContain("### Agent 与状态");
    expect(markdown.match(/`\/model \[name\]`/g)).toHaveLength(1);
    expect(markdown.match(/`\/thinking \[level\]`/g)).toHaveLength(1);
    expect(markdown).not.toContain("`/model`：");
    expect(markdown).not.toContain("`/model <name>`：");
  });
});
