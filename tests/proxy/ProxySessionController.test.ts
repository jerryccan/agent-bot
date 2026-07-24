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
import type { AgentRuntime, RemoteSessionSummary, RuntimeEvent, RuntimeGoal, RuntimeSession } from "../../src/runtime/types.js";
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

function groupMessage(chatId: string, text: string): IncomingMessage {
  return {
    messageId: `m-${chatId}-${text}`,
    contextKey: `chat_id:${chatId}`,
    chatId,
    chatType: "group",
    text,
  };
}

function threadMessage(
  chatId: string,
  chatType: "p2p" | "group",
  threadId: string,
  rootMessageId: string,
  text: string,
): IncomingMessage {
  return {
    messageId: `m-${threadId}-${text}`,
    contextKey: `chat_id:${chatId}:thread_id:${threadId}`,
    chatId,
    chatType,
    replyInThread: true,
    threadContext: true,
    threadId,
    rootMessageId,
    parentMessageId: rootMessageId,
    text,
  };
}

function fixture() {
  const sessions = new Map<string, RuntimeSession>();
  const remoteSessions: RemoteSessionSummary[] = [];
  const goals = new Map<string, RuntimeGoal>();
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
      const existingRemote = remoteSessions.find((candidate) => candidate.id === session.remoteSessionId);
      if (!existingRemote) {
        remoteSessions.push({
          id: session.remoteSessionId,
          title: input.title,
          cwd: input.cwd,
          source: "acp-bot",
          status: "idle",
        });
      }
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
    forkSession: vi.fn(async (input) => {
      const remoteSessionId = `${input.remoteSessionId}_fork`;
      const session: RuntimeSession = {
        ...input,
        remoteSessionId,
        runtimeKind: "codex",
        model: input.model ?? "gpt-test",
        reasoningEffort: input.reasoningEffort ?? "high",
      };
      sessions.set(input.localSessionId, session);
      remoteSessions.push({
        id: remoteSessionId,
        title: input.title,
        cwd: input.cwd,
        source: "acp-bot",
        status: "idle",
        lastTurnId: input.lastTurnId,
        lastTurnStatus: "completed",
      });
      return session;
    }),
    getSession: vi.fn((id) => sessions.get(id)),
    readSessionMetadata: vi.fn(async () => ({})),
    listRemoteSessions: vi.fn(async ({ searchTerm, limit = 20 }: { searchTerm?: string; limit?: number } = {}) => {
      const matches = remoteSessions.filter((session) => !searchTerm || session.title?.includes(searchTerm));
      return {
        sessions: matches.slice(0, limit),
        nextCursor: matches.length > limit ? "next" : undefined,
      };
    }),
    readRemoteSession: vi.fn(async (id: string) => {
      const session = remoteSessions.find((candidate) => candidate.id === id);
      if (!session) throw new Error(`Unknown remote session: ${id}`);
      return session;
    }),
    synchronizeSession: vi.fn(async (id) => sessions.get(id)!),
    startTurn: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId)!;
      session.activeTurnId = "turn_1";
      const remote = remoteSessions.find((candidate) => candidate.id === session.remoteSessionId);
      if (remote) {
        remote.status = "active";
        remote.lastTurnId = "turn_1";
        remote.lastTurnStatus = "inProgress";
      }
      for (const listener of listeners) listener({ type: "turn_started", sessionId, turnId: "turn_1", startedAt: 1 });
      return "turn_1";
    }),
    steerTurn: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    interruptRemoteTurn: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    setTitle: vi.fn(async (sessionId, title) => {
      sessions.get(sessionId)!.title = title;
    }),
    getGoal: vi.fn(async (sessionId) => goals.get(sessionId)),
    setGoal: vi.fn(async (sessionId, update) => {
      const current = goals.get(sessionId);
      const goal: RuntimeGoal = {
        threadId: sessions.get(sessionId)!.remoteSessionId,
        objective: update.objective ?? current?.objective ?? "",
        status: update.status ?? current?.status ?? "active",
        tokenBudget: update.tokenBudget ?? current?.tokenBudget ?? null,
        tokensUsed: current?.tokensUsed ?? 0,
        timeUsedSeconds: current?.timeUsedSeconds ?? 0,
        createdAt: current?.createdAt ?? 1_776_272_400,
        updatedAt: 1_776_272_460,
      };
      goals.set(sessionId, goal);
      return goal;
    }),
    clearGoal: vi.fn(async (sessionId) => goals.delete(sessionId)),
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
    createGroup: vi.fn(async (input) => ({ chatId: "oc_new_group", name: input.name })),
    addReaction: vi.fn(async () => undefined),
    deleteReaction: vi.fn(async () => undefined),
    downloadImage: vi.fn(async (_messageId, imageKey) => path.join(process.cwd(), `${imageKey}.png`)),
    sendText: vi.fn(async () => "text"),
    sendMarkdown: vi.fn(async () => "markdown"),
    sendInteractiveCard: vi.fn(async () => "card"),
    replyText: vi.fn(async () => "thread_text"),
    replyMarkdown: vi.fn(async () => "thread_markdown"),
    replyInteractiveCard: vi.fn(async () => "thread_card"),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
  const presenter: TurnPresenter = {
    registerSession: vi.fn(),
    updateSessionTitle: vi.fn(),
    unregisterSession: vi.fn(),
    startPendingTurn: vi.fn(async () => undefined),
    failPendingTurn: vi.fn(async () => undefined),
    appendSteerMessage: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => undefined),
    showDetails: vi.fn(async () => undefined),
    showActivityPage: vi.fn(async () => undefined),
    resumeDelivery: vi.fn(async () => undefined),
    flushAll: vi.fn(async () => undefined),
  };
  const outboundRouter = new OutboundRouter([{ matches: () => true, outbound, presenter }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-"));
  tempDirs.push(dir);
  const store = new StateStore(path.join(dir, "state.sqlite"));
  const config = {
    agents: {
      codex: { kind: "codex", title: "Codex", command: "codex", args: [], env: {} },
      acp: { kind: "acp", title: "ACP", command: "acp", args: [], env: {} },
    },
    defaults: { agent: "codex", cwd: process.cwd() },
  } as unknown as AppConfig;
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const restart = vi.fn(async () => undefined);
  const shellCommandExecutor = vi.fn(async () => ({
    stdout: "README.md\nsrc\ntests\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
  }));
  const controller = new ProxySessionController(
    config,
    store,
    new AgentRuntimeRegistry({ acp, codex: runtime }),
    outboundRouter,
    logger,
    { restart, supervised: true },
    shellCommandExecutor,
  );
  cleanups.push(() => {
    controller.close();
    store.close();
  });
  return {
    controller,
    runtime,
    sessions,
    goals,
    remoteSessions,
    outbound,
    outboundRouter,
    presenter,
    store,
    listeners,
    restart,
    shellCommandExecutor,
  };
}

describe("ProxySessionController", () => {
  test("creates, displays, edits, pauses, resumes, and clears a Codex goal", async () => {
    const { controller, runtime, outbound, store, listeners, presenter } = fixture();

    await controller.onMessage(message("/goal 完成迁移并通过全部测试"));

    const currentId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    expect(runtime.setGoal).toHaveBeenCalledWith(currentId, {
      objective: "完成迁移并通过全部测试",
      status: "active",
    });
    expect(runtime.startTurn).not.toHaveBeenCalled();
    let card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("Goal 已启动");
    expect(JSON.stringify(card)).toContain("完成迁移并通过全部测试");

    await controller.onMessage(message("/goal"));
    card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("当前 Goal");
    expect(JSON.stringify(card)).toContain("执行中");

    await controller.onMessage(message("/goal pause"));
    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, { status: "paused" });
    await controller.onMessage(message("/goal resume"));
    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, { status: "active" });
    await controller.onMessage(message("/goal edit 完成迁移、文档和回归测试"));
    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, expect.objectContaining({
      objective: "完成迁移、文档和回归测试",
      status: "active",
    }));

    await controller.onMessage(message("/status"));
    card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("完成迁移、文档和回归测试");

    for (const listener of listeners) {
      listener({ type: "turn_started", sessionId: currentId, turnId: "goal_turn_1", startedAt: 42 });
    }
    await vi.waitFor(() => expect(presenter.onEvent).toHaveBeenCalledWith({
      type: "turn_started",
      sessionId: currentId,
      turnId: "goal_turn_1",
      startedAt: 42,
    }));
    expect(store.getSession(currentId)).toMatchObject({ status: "running", lastTurnId: "goal_turn_1" });

    await controller.onMessage(message("/goal clear"));
    expect(runtime.clearGoal).toHaveBeenCalledWith(currentId);
    card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("Goal 已清除");
  });

  test("pauses an active goal before stopping its Codex turn", async () => {
    const { controller, runtime, store, remoteSessions } = fixture();
    await controller.onMessage(message("/goal 持续优化测试覆盖率"));
    const currentId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    const session = runtime.getSession(currentId)!;
    session.activeTurnId = "goal_turn_active";
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "active",
      lastTurnId: "goal_turn_active",
      lastTurnStatus: "inProgress",
    });

    await controller.onMessage(message("/stop"));

    expect(runtime.setGoal).toHaveBeenLastCalledWith(currentId, { status: "paused" });
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "goal_turn_active");
  });

  test("rejects oversized goals before creating a task", async () => {
    const { controller, runtime, store, outbound } = fixture();
    await controller.onMessage(message(`/goal ${"长".repeat(4_001)}`));

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(store.listSessions("chat_id:c1")).toHaveLength(0);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("最多 4000 个字符"),
    );
  });

  test("executes bang commands in the current task directory and returns their output", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    const cwd = "D:\\work space\\shell-project";
    await controller.onMessage(message(`/new --dir "${cwd}"`));

    await controller.onMessage(message("! ls"));

    expect(shellCommandExecutor).toHaveBeenCalledWith("ls", cwd);
    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringMatching(/\*\*目录\*\*：`D:\\work space\\shell-project`[\s\S]*\*\*命令\*\*：`ls`[\s\S]*```text\nREADME\.md\nsrc\ntests\n```[\s\S]*退出码 0/),
    );
  });

  test("uses the configured default directory for bang commands without a current task", async () => {
    const { controller, shellCommandExecutor } = fixture();

    await controller.onMessage(message("! Get-ChildItem"));

    expect(shellCommandExecutor).toHaveBeenCalledWith("Get-ChildItem", process.cwd());
  });

  test("plain text creates the default Codex session and starts a turn", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    await controller.onMessage(message("inspect this repo"));

    expect(outbound.addReaction).toHaveBeenCalledWith("m-inspect this repo", "OnIt");
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "inspect this repo",
      undefined,
    );
    expect((presenter.startPendingTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect((outbound.addReaction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "inspect this repo");
    expect(presenter.registerSession).toHaveBeenCalledWith(
      expect.any(String),
      "chat_id:c1",
      "inspect this repo",
      expect.any(String),
    );
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ runtimeKind: "codex", remoteSessionId: "thr_1" });
  });

  test("records base Feishu chat types for restart notification routing", async () => {
    const { controller, store } = fixture();

    await controller.onMessage({
      ...message("private prompt"),
      chatId: "private",
      chatType: "p2p",
      contextKey: "chat_id:private:thread_id:topic",
      threadContext: true,
      threadId: "topic",
    });
    await controller.onMessage(groupMessage("group", "! ls"));
    await controller.onMessage(groupMessage("slash", "/status"));

    expect(store.listChatContexts("p2p").map((context) => context.contextKey)).toEqual(["chat_id:private"]);
    expect(store.listChatContexts("group").map((context) => context.contextKey)).toEqual([
      "chat_id:slash",
      "chat_id:group",
    ]);
    const activeContexts = store.listRecentlyActiveChatContexts(new Date(0)).map((context) => context.contextKey);
    expect(activeContexts).toEqual(expect.arrayContaining(["chat_id:group", "chat_id:private"]));
    expect(activeContexts).not.toContain("chat_id:slash");
  });

  test("downloads a pure image and starts Codex with a default text prompt plus localImage input", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage({
      messageId: "om_image_input",
      contextKey: "chat_id:c1",
      text: "",
      images: [{ imageKey: "img_input" }],
    });

    expect(outbound.downloadImage).toHaveBeenCalledWith("om_image_input", "img_input");
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), {
      text: "请分析这张图片。",
      localImagePaths: [expect.stringContaining("img_input.png")],
    });
  });

  test("keeps current tasks and stop operations isolated between groups", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store, presenter, listeners } = fixture();
    let created = 0;
    (runtime.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (input) => {
      created += 1;
      const session: RuntimeSession = {
        ...input,
        remoteSessionId: `thr_group_${created}`,
        runtimeKind: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
      };
      sessions.set(input.localSessionId, session);
      remoteSessions.push({
        id: session.remoteSessionId,
        cwd: input.cwd,
        source: "acp-bot",
        status: "idle",
      });
      return session;
    });
    (runtime.startTurn as ReturnType<typeof vi.fn>).mockImplementation(async (sessionId: string) => {
      const session = sessions.get(sessionId)!;
      const turnId = `turn_${session.remoteSessionId}`;
      session.activeTurnId = turnId;
      const remote = remoteSessions.find((candidate) => candidate.id === session.remoteSessionId)!;
      remote.status = "active";
      remote.lastTurnId = turnId;
      remote.lastTurnStatus = "inProgress";
      for (const listener of listeners) listener({ type: "turn_started", sessionId, turnId, startedAt: 1 });
      return turnId;
    });

    await controller.onMessage(groupMessage("group_1", "first group task"));
    await controller.onMessage(groupMessage("group_2", "second group task"));

    const first = store.getOrCreateUserContext("chat_id:group_1", "codex").currentSessionId;
    const second = store.getOrCreateUserContext("chat_id:group_2", "codex").currentSessionId;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      first,
      "chat_id:group_1",
      "first group task",
      undefined,
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      second,
      "chat_id:group_2",
      "second group task",
      undefined,
    );

    await controller.onMessage(groupMessage("group_1", "/sessions"));
    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:group_1",
      expect.objectContaining({ header: expect.any(Object) }),
    );

    await controller.onMessage(groupMessage("group_1", "/stop"));

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_group_1", "turn_thr_group_1");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:group_1",
      "已向 Codex 发送 Interrupt 请求：turn_thr_group_1",
    );
    expect(sessions.get(second!)?.activeTurnId).toBe("turn_thr_group_2");
    expect(store.getOrCreateUserContext("chat_id:group_2", "codex").currentSessionId).toBe(second);
  });

  test("forks a completed private-chat turn into an isolated topic task", async () => {
    const { controller, runtime, store, listeners, outbound, presenter } = fixture();
    const sourceMessage: IncomingMessage = {
      messageId: "om_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build the base task",
    };

    await controller.onMessage(sourceMessage);
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "base complete",
      });
    }

    await controller.onMessage(threadMessage("c1", "p2p", "omt_branch", "om_source", "continue differently"));

    const topicContextKey = "chat_id:c1:thread_id:omt_branch";
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    expect(topicSessionId).toBeDefined();
    expect(topicSessionId).not.toBe(sourceSessionId);
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: topicSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "build the base task（分支 1）",
    }));
    expect(store.getSession(topicSessionId!)).toMatchObject({
      contextKey: topicContextKey,
      remoteSessionId: "thr_1_fork",
      title: "build the base task（分支 1）",
      status: "running",
    });
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      topicSessionId,
      topicContextKey,
      "build the base task（分支 1）",
      { messageId: "m-omt_branch-continue differently", replyInThread: true },
    );
    expect(outbound.sendText).not.toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("continue differently"),
    );

    await controller.onCardAction({
      actionId: "action_topic_stop",
      contextKey: "chat_id:c1",
      messageId: "om_topic_status_card",
      value: {
        action: "session_stop",
        sessionId: "thr_1_fork",
        contextKey: topicContextKey,
        cardView: "status",
      },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1_fork", "turn_1");
    expect(outbound.replyText).toHaveBeenCalledWith(
      topicContextKey,
      { messageId: "om_topic_status_card", replyInThread: true },
      "已向 Codex 发送 Interrupt 请求：turn_1",
    );
  });

  test("forks a completed group-main turn into an isolated group-topic task", async () => {
    const { controller, runtime, store, listeners, presenter } = fixture();
    await controller.onMessage({
      messageId: "om_group_source",
      contextKey: "chat_id:group_fork",
      chatId: "group_fork",
      chatType: "group",
      text: "group base task",
    });
    const sourceSessionId = store.getUserContext("chat_id:group_fork")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "group base complete",
      });
    }

    await controller.onMessage(threadMessage(
      "group_fork",
      "group",
      "omt_group_branch",
      "om_group_source",
      "continue in group topic",
    ));

    const topicContextKey = "chat_id:group_fork:thread_id:omt_group_branch";
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    expect(topicSessionId).toBeDefined();
    expect(topicSessionId).not.toBe(sourceSessionId);
    expect(store.getUserContext("chat_id:group_fork")?.currentSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: topicSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "group base task（分支 1）",
    }));
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      topicSessionId,
      topicContextKey,
      "group base task（分支 1）",
      { messageId: "m-omt_group_branch-continue in group topic", replyInThread: true },
    );
  });

  test("does not fork a private-chat topic while its anchor turn is still running", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage({
      messageId: "om_running_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "long task",
    });

    await controller.onMessage(threadMessage("c1", "p2p", "omt_running", "om_running_source", "branch now"));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.replyText).toHaveBeenCalledWith(
      "chat_id:c1:thread_id:omt_running",
      { messageId: "m-omt_running-branch now", replyInThread: true },
      expect.stringContaining("轮次仍在执行"),
    );
  });

  test("forks the current completed Codex task and switches to the new branch", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners, outbound, presenter } = fixture();
    await controller.onMessage(message("build the source task"));
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(sourceSessionId).toBeDefined();
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    const sourceRuntimeSession = sessions.get(sourceSessionId!);
    if (sourceRuntimeSession) sourceRuntimeSession.activeTurnId = undefined;
    const sourceRemote = remoteSessions.find((session) => session.id === "thr_1")!;
    sourceRemote.status = "idle";
    sourceRemote.lastTurnId = "turn_1";
    sourceRemote.lastTurnStatus = "completed";

    await controller.onMessage(message("/fork"));

    const context = store.getUserContext("chat_id:c1");
    const forkedSessionId = context?.currentSessionId;
    expect(forkedSessionId).toBeDefined();
    expect(forkedSessionId).not.toBe(sourceSessionId);
    expect(context?.previousSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "build the source task（分支 1）",
      cwd: store.getSession(sourceSessionId!)?.cwd,
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      contextKey: "chat_id:c1",
      remoteSessionId: "thr_1_fork",
      title: "build the source task（分支 1）",
      status: "ready",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      forkedSessionId,
      "chat_id:c1",
      "build the source task（分支 1）",
      store.getSession(sourceSessionId!)?.cwd,
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已从当前任务创建分支并切换到新任务：build the source task（分支 1）（thr_1_fork）",
    );
  });

  test("forks an external Codex task by task ID without switching to it first", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    remoteSessions.push({
      id: "external_fork_source",
      title: "External fork source",
      cwd: "D:\\work\\external-source",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_external_done",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(message("/fork external_fork_source"));

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "external_fork_source",
      lastTurnId: "turn_external_done",
      title: "External fork source（分支 1）",
      cwd: "D:\\work\\external-source",
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      remoteSessionId: "external_fork_source_fork",
      title: "External fork source（分支 1）",
      status: "ready",
    });
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已从指定任务创建分支并切换到新任务：External fork source（分支 1）（external_fork_source_fork）",
    );
  });

  test("resolves a fork source by its latest sessions-list sequence number", async () => {
    const { controller, runtime, remoteSessions, store } = fixture();
    remoteSessions.push(
      {
        id: "fork_list_first",
        title: "First fork candidate",
        cwd: "D:\\work\\first",
        source: "cli",
        status: "idle",
        lastTurnId: "turn_first",
        lastTurnStatus: "completed",
      },
      {
        id: "fork_list_second",
        title: "Second fork candidate",
        cwd: "D:\\work\\second",
        source: "desktop",
        status: "idle",
        lastTurnId: "turn_second",
        lastTurnStatus: "completed",
      },
    );
    await controller.onMessage(message("/sessions"));

    await controller.onMessage(message("/fork 2"));

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "fork_list_second",
      lastTurnId: "turn_second",
      title: "Second fork candidate（分支 1）",
      cwd: "D:\\work\\second",
    }));
  });

  test("refuses to fork the current task while its latest turn is running", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("long-running source"));

    await controller.onMessage(message("/fork"));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("轮次仍在执行"),
    );
  });

  test("new always uses the current default agent and accepts cwd through --dir", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("/agent acp"));
    await controller.onMessage(message('/new --dir "D:\\work space\\repo"'));

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "acp",
      cwd: "D:\\work space\\repo",
    }));
    expect(store.listSessions("chat_id:c1").at(-1)).toMatchObject({
      agentName: "acp",
      cwd: "D:\\work space\\repo",
    });
  });

  test("creates a task with an explicit title and synchronizes it with the runtime", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();

    await controller.onMessage(message("/new 修复会话列表时间 --dir D:\\work"));

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "修复会话列表时间",
      cwd: "D:\\work",
    }));
    const session = store.listSessions("chat_id:c1")[0]!;
    expect(session.title).toBe("修复会话列表时间");
    expect(presenter.registerSession).toHaveBeenCalledWith(
      session.localSessionId,
      "chat_id:c1",
      "修复会话列表时间",
      "D:\\work",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("修复会话列表时间"),
    );
  });

  test("creates a Feishu group for the current user without initializing a task", async () => {
    const { controller, runtime, store, outbound, presenter } = fixture();

    await controller.onMessage({
      messageId: "new-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup 广州天气",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[codex] 广州天气",
      userOpenId: "ou_current_user",
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
    const groupContext = store.getUserContext("chat_id:oc_new_group");
    expect(groupContext).toMatchObject({ defaultAgent: "codex", currentSessionId: undefined });
    expect(store.listSessions("chat_id:oc_new_group")).toHaveLength(0);
    expect(presenter.registerSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      "群已创建。直接发送消息即可在本群开始一个新任务。",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已创建飞书群：[codex] 广州天气，并邀请你加入。",
    );
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
  });

  test("uses the local yy-mm-dd hh:mm time when newgroup omits the title", async () => {
    const { controller, runtime, outbound } = fixture();

    await controller.onMessage({
      messageId: "new-group-default-title",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(groupInput.name).toMatch(/^\[codex\] \d{2}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  test("rejects newgroup when the message does not contain a Feishu open_id", async () => {
    const { controller, runtime, outbound } = fixture();

    await controller.onMessage(message("/newgroup 广州天气"));

    expect(outbound.createGroup).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("具有 open_id 的飞书用户"),
    );
  });

  test("lists every agent through agent and marks the current default", async () => {
    const { controller, outbound } = fixture();
    await controller.onMessage(message("/agent acp"));
    await controller.onMessage({ messageId: "list-agents", contextKey: "chat_id:c1", text: "/agent" });

    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringMatching(/当前 Agent：`acp`[\s\S]*`codex`：Codex[\s\S]*✅ `acp`：ACP（当前）/),
    );
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

  test("inherits the current project directory when new omits cwd", async () => {
    const { controller, runtime } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "acp-project-"));
    tempDirs.push(project);

    await controller.onMessage(message(`/new --dir "${project}"`));
    await controller.onMessage({ messageId: "new-in-project", contextKey: "chat_id:c1", text: "/new" });

    expect((runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      cwd: project,
    });
  });

  test("creates a fresh projectless workspace when new is sent from a projectless task", async () => {
    const { controller, runtime } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "acp-projectless-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage(message("/new"));
    await controller.onMessage({ messageId: "new-projectless-again", contextKey: "chat_id:c1", text: "/new" });

    const firstCwd = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].cwd;
    const secondCwd = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].cwd;
    const projectlessRoot = path.join(home, "Documents", "Codex");
    expect(path.relative(projectlessRoot, firstCwd)).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]new-chat$/);
    expect(path.relative(projectlessRoot, secondCwd)).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]new-chat-2$/);
    expect(secondCwd).not.toBe(firstCwd);
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

  test("renames the current task and refreshes its presentation", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.listSessions("chat_id:c1")[0]!.localSessionId;

    await controller.onMessage(message("/title 修复会话列表时间"));

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "修复会话列表时间");
    expect(store.getSession(sessionId)?.title).toBe("修复会话列表时间");
    expect(presenter.updateSessionTitle).toHaveBeenCalledWith(sessionId, "修复会话列表时间");
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", "已将当前任务标题修改为：修复会话列表时间");
  });

  test("renames the group-bound current task when the Feishu group name changes", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    await controller.onMessage(groupMessage("rename_group", "old title"));
    const sessionId = store.getUserContext("chat_id:rename_group")!.currentSessionId!;
    const sentMessageCount = (outbound.sendText as ReturnType<typeof vi.fn>).mock.calls.length;

    await controller.onChatUpdated({
      chatId: "rename_group",
      beforeName: "[codex] old title",
      afterName: "[Codex] abc",
    });

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "abc");
    expect(store.getSession(sessionId)?.title).toBe("abc");
    expect(presenter.updateSessionTitle).toHaveBeenCalledWith(sessionId, "abc");
    expect(outbound.sendText).toHaveBeenCalledTimes(sentMessageCount);
  });

  test("ignores group names that do not match the current task agent or have no bound task", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(groupMessage("rename_guard", "current title"));
    const sessionId = store.getUserContext("chat_id:rename_guard")!.currentSessionId!;

    await controller.onChatUpdated({
      chatId: "rename_guard",
      beforeName: "[codex] current title",
      afterName: "[acp] should not apply",
    });
    await controller.onChatUpdated({
      chatId: "rename_guard",
      beforeName: "[acp] should not apply",
      afterName: "missing agent prefix",
    });
    await controller.onChatUpdated({
      chatId: "empty_group",
      beforeName: "[codex] old",
      afterName: "[codex] no task",
    });
    await controller.onChatUpdated({
      chatId: "rename_guard",
      beforeName: "[codex] anything",
      afterName: "[codex] current title",
    });

    expect(runtime.setTitle).not.toHaveBeenCalled();
    expect(store.getSession(sessionId)?.title).toBe("current title");
  });

  test("rejects title changes when there is no current task", async () => {
    const { controller, runtime, outbound } = fixture();

    await controller.onMessage(message("/title 尚不存在的任务"));

    expect(runtime.setTitle).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("当前没有任务"));
  });

  test("ignores a duplicate inbound message id", async () => {
    const { controller, runtime, outbound } = fixture();
    const duplicate = { messageId: "same-event", contextKey: "chat_id:c1", text: "inspect" };
    await controller.onMessage(duplicate);
    await controller.onMessage(duplicate);
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(outbound.addReaction).toHaveBeenCalledOnce();
  });

  test("continues processing when the received-message reaction fails", async () => {
    const { controller, runtime, outbound } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("missing reaction scope"));

    await controller.onMessage(message("continue despite reaction failure"));

    expect(runtime.startTurn).toHaveBeenCalledOnce();
  });

  test("replaces every received reaction with DONE when the bound turn completes", async () => {
    const { controller, sessions, store, outbound, listeners } = fixture();
    let reactionSequence = 0;
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockImplementation(async () => `reaction_${++reactionSequence}`);

    await controller.onMessage(message("build it"));
    await controller.onMessage(message("also update docs"));
    const session = store.listSessions("chat_id:c1")[0]!;
    expect(store.getMessageReaction("m-build it")).toMatchObject({ turnId: "turn_1", status: "pending" });
    expect(store.getMessageReaction("m-also update docs")).toMatchObject({ turnId: "turn_1", status: "pending" });

    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId: session.localSessionId, turnId: "turn_1", finalResponse: "done" });
    }

    await vi.waitFor(() => expect(store.getMessageReaction("m-build it")?.status).toBe("completed"));
    expect(store.getMessageReaction("m-also update docs")).toMatchObject({ emojiType: "DONE", status: "completed" });
    expect(outbound.addReaction).toHaveBeenCalledWith("m-build it", "DONE");
    expect(outbound.addReaction).toHaveBeenCalledWith("m-also update docs", "DONE");
    expect(outbound.deleteReaction).toHaveBeenCalledWith("m-build it", "reaction_1");
    expect(outbound.deleteReaction).toHaveBeenCalledWith("m-also update docs", "reaction_2");
  });

  test("keeps a completed turn active until its final response has been delivered", async () => {
    const { controller, sessions, store, listeners, presenter } = fixture();
    let releaseFinalDelivery!: () => void;
    const finalDelivery = new Promise<void>((resolve) => { releaseFinalDelivery = resolve; });
    (presenter.onEvent as ReturnType<typeof vi.fn>).mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "turn_completed") await finalDelivery;
    });

    await controller.onMessage(message("build it safely"));
    const session = store.listSessions("chat_id:c1")[0]!;
    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId: session.localSessionId, turnId: "turn_1", finalResponse: "done" });
    }

    await vi.waitFor(() => expect(presenter.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "turn_completed",
      turnId: "turn_1",
    })));
    expect(store.getServerActivityState().runningSessions).toBe(1);
    expect(store.getSession(session.localSessionId)).toMatchObject({
      status: "running",
      lastTurnStatus: "completed",
    });

    releaseFinalDelivery();
    await vi.waitFor(() => expect(store.getSession(session.localSessionId)?.status).toBe("ready"));
    expect(store.getServerActivityState().runningSessions).toBe(0);
  });

  test("uses CrossMark for the original prompt when its turn is cancelled", async () => {
    const { controller, sessions, store, outbound, listeners } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("reaction_on_it")
      .mockResolvedValueOnce("reaction_cancelled");

    await controller.onMessage(message("long task"));
    const session = store.listSessions("chat_id:c1")[0]!;
    sessions.get(session.localSessionId)!.activeTurnId = undefined;
    for (const listener of listeners) {
      listener({ type: "turn_cancelled", sessionId: session.localSessionId, turnId: "turn_1" });
    }

    await vi.waitFor(() => expect(store.getMessageReaction("m-long task")?.status).toBe("cancelled"));
    expect(outbound.addReaction).toHaveBeenLastCalledWith("m-long task", "CrossMark");
    expect(outbound.deleteReaction).toHaveBeenCalledWith("m-long task", "reaction_on_it");
  });

  test("plain text steers an active turn, inserts it into the thinking card, and stop bypasses prompt completion", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    await controller.onMessage(message("build it"));
    await controller.onMessage(message("also update docs"));
    await controller.onMessage(message("/stop"));

    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    expect(runtime.steerTurn).toHaveBeenCalledWith(expect.any(String), "turn_1", "also update docs");
    expect(presenter.appendSteerMessage).toHaveBeenCalledWith(
      sessionId,
      "turn_1",
      "also update docs",
      "m-also update docs",
    );
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已向 Codex 发送 Interrupt 请求：turn_1",
    );
  });

  test("reads a missing local turn from the current Codex task before interrupting", async () => {
    const { controller, runtime, sessions, store, outbound } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    sessions.get(sessionId)!.activeTurnId = undefined;

    await controller.onMessage({ messageId: "stop-synchronized", contextKey: "chat_id:c1", text: "/stop" });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已向 Codex 发送 Interrupt 请求：turn_1",
    );
  });

  test("interrupts the active turn of the current task even when another client started it", async () => {
    const { controller, runtime, sessions, remoteSessions, store, outbound } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "active",
      lastTurnId: "turn_from_another_client",
      lastTurnStatus: "inProgress",
    });

    await controller.onMessage({ messageId: "stop-different-turn", contextKey: "chat_id:c1", text: "/stop" });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_from_another_client");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已向 Codex 发送 Interrupt 请求：turn_from_another_client",
    );
  });

  test("interrupts the current externally created task without loading it locally", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    remoteSessions.push({
      id: "external_current",
      title: "External task",
      cwd: "D:\\work\\external",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_old",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/switch external_current"));
    const currentSessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId!;
    expect(runtime.getSession(currentSessionId)).toBeUndefined();
    Object.assign(remoteSessions.find((remote) => remote.id === "external_current")!, {
      status: "active",
      lastTurnId: "turn_external_active",
      lastTurnStatus: "inProgress",
    });

    await controller.onMessage({ messageId: "stop-external-current", contextKey: "chat_id:c1", text: "/stop" });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("external_current", "turn_external_active");
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "已向 Codex 发送 Interrupt 请求：turn_external_active",
    );
  });

  test("read-only commands bypass a blocked prompt queue", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("build it"));
    let releaseSteer!: () => void;
    (runtime.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSteer = resolve; }),
    );

    const blockedPrompt = controller.onMessage(message("also update docs"));
    await vi.waitFor(() => expect(runtime.steerTurn).toHaveBeenCalled());
    await controller.onMessage(message("/help"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.objectContaining({ header: expect.objectContaining({ title: expect.objectContaining({ content: "Codex 使用帮助" }) }) }),
    );
    releaseSteer();
    await blockedPrompt;
  });

  test("/nosteer can enqueue while a normal steer request is blocked", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    let releaseSteer!: () => void;
    (runtime.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSteer = resolve; }),
    );

    const blockedPrompt = controller.onMessage(message("also update docs"));
    await vi.waitFor(() => expect(runtime.steerTurn).toHaveBeenCalled());
    await controller.onMessage(message("/nosteer run tests afterwards"));

    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual([
      "run tests afterwards",
    ]);
    expect(presenter.appendSteerMessage).not.toHaveBeenCalledWith(
      sessionId,
      expect.any(String),
      "run tests afterwards",
      expect.any(String),
    );
    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.objectContaining({ header: expect.objectContaining({ title: expect.objectContaining({ content: "排队 Prompt · 1" }) }) }),
    );
    releaseSteer();
    await blockedPrompt;
  });

  test("restart bypasses a blocked prompt queue", async () => {
    const { controller, runtime, restart } = fixture();
    await controller.onMessage(message("build it"));
    let releaseSteer!: () => void;
    (runtime.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSteer = resolve; }),
    );

    const blockedPrompt = controller.onMessage(message("also update docs"));
    await vi.waitFor(() => expect(runtime.steerTurn).toHaveBeenCalled());
    await controller.onMessage(message("/restart"));

    expect(restart).toHaveBeenCalledWith("chat_id:c1");
    releaseSteer();
    await blockedPrompt;
  });

  test("lazily resumes a persisted session before starting the next turn", async () => {
    const { controller, runtime, store, remoteSessions } = fixture();
    remoteSessions.push({
      id: "thr_saved",
      cwd: process.cwd(),
      source: "acp-bot",
      status: "idle",
      lastTurnId: "turn_saved",
      lastTurnStatus: "completed",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({ localSessionId: "saved", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready" });
    store.updateRuntimeSession("saved", {
      runtimeKind: "codex",
      remoteSessionId: "thr_saved",
      lastTurnId: "turn_saved",
      lastTurnStatus: "completed",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "saved");

    await controller.onMessage(message("continue"));
    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "saved",
      remoteSessionId: "thr_saved",
      reasoningEffort: "high",
      activeTurnId: undefined,
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith("saved", "continue");
  });

  test("restores and reconciles a persisted running turn before handling a new prompt", async () => {
    const { controller, runtime, store, remoteSessions, outbound } = fixture();
    remoteSessions.push({
      id: "thr_running",
      cwd: process.cwd(),
      source: "acp-bot",
      status: "active",
      lastTurnId: "turn_saved",
      lastTurnStatus: "inProgress",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "running",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("running", {
      runtimeKind: "codex",
      remoteSessionId: "thr_running",
      lastTurnId: "turn_saved",
      lastTurnStatus: "running",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "running");

    await controller.onMessage(message("latest progress"));

    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "running",
      remoteSessionId: "thr_running",
      activeTurnId: "turn_saved",
    }));
    expect((outbound.sendText as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
    expect(runtime.steerTurn).toHaveBeenCalledWith("running", "turn_saved", "latest progress");
  });

  test("continues a restarted task when restoring the previous final answer fails", async () => {
    const { controller, runtime, store, remoteSessions, presenter } = fixture();
    remoteSessions.push({
      id: "thr_restored",
      cwd: process.cwd(),
      source: "acp-bot",
      status: "idle",
      lastTurnId: "turn_previous",
      lastTurnStatus: "completed",
    });
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "restored",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("restored", {
      runtimeKind: "codex",
      remoteSessionId: "thr_restored",
      lastTurnId: "turn_previous",
      lastTurnStatus: "completed",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "restored");
    (presenter.resumeDelivery as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("invalid persisted image card"),
    );

    await controller.onMessage(message("continue after restart"));

    expect(presenter.resumeDelivery).toHaveBeenCalledWith("restored", "chat_id:c1", "turn_previous");
    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "restored",
      remoteSessionId: "thr_restored",
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith("restored", "continue after restart");
  });

  test("starts the first turn of a new Codex thread before it is materialized", async () => {
    const { controller, runtime } = fixture();
    await controller.onMessage(message("/new"));
    (runtime.readRemoteSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(
        "thread/read failed: thread thr_1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );

    await controller.onMessage(message("hello from the first turn"));

    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "hello from the first turn");
    expect(runtime.synchronizeSession).not.toHaveBeenCalled();
  });

  test("recreates an empty Codex thread after restart instead of resuming a missing rollout", async () => {
    const { controller, runtime, store, remoteSessions } = fixture();
    remoteSessions.push({
      id: "thr_without_rollout",
      cwd: process.cwd(),
      source: "acp-bot",
      status: "not_loaded",
    });
    (runtime.resumeSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("thread/resume failed: no rollout found for thread id thr_without_rollout"),
    );
    (runtime.readRemoteSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("thread/read failed: thread not loaded: thr_without_rollout"),
    );
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({
      localSessionId: "empty",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("empty", {
      runtimeKind: "codex",
      remoteSessionId: "thr_without_rollout",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    store.setCurrentSession("chat_id:c1", "empty");

    await controller.onMessage(message("run a local command"));

    expect(runtime.resumeSession).toHaveBeenCalledOnce();
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: "empty",
      cwd: process.cwd(),
      model: "gpt-test",
      reasoningEffort: "high",
    }));
    expect(runtime.startTurn).toHaveBeenCalledWith("empty", "run a local command");
    expect(store.getSession("empty")?.remoteSessionId).toBe("thr_1");
  });

  test("lists all Codex tasks through one unified view", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    store.createSession({
      localSessionId: "legacy_acp",
      contextKey: "chat_id:c1",
      agentName: "acp",
      cwd: "D:\\work\\acp",
      status: "running",
    });
    store.updateRuntimeSession("legacy_acp", {
      runtimeKind: "acp",
      remoteSessionId: "remote_acp",
      title: "Legacy ACP task",
    });
    remoteSessions.push({
      id: "external_1",
      title: "Desktop investigation",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "not_loaded",
      updatedAt: 946_684_800,
      recencyAt: 1_893_456_000,
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(message("/sessions Desktop"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Desktop investigation");
    expect(serialized).toContain("external_1");
    expect(serialized).toContain("2030");
    expect(serialized).not.toContain("2000");
    expect(serialized).not.toContain("最后更新：");
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"action":"session_switch","sessionId":"external_1","searchTerm":"Desktop","visibleCount":"5"');
    expect(serialized).toContain("<font color='blue'>Fork</font>");
    expect(serialized).toContain('"action":"session_fork","sessionId":"external_1","searchTerm":"Desktop","visibleCount":"5"');
    expect(serialized).toContain("<font color='blue'>Status</font>");
    expect(serialized).toContain('"action":"session_status","sessionId":"external_1"');
    expect(serialized).not.toContain("Legacy ACP task");
    expect(serialized).not.toContain("remote_acp");
    expect(serialized).toContain("/switch [序号或任务 ID]");
    expect(serialized).not.toContain("已接入");
    expect(serialized).not.toContain("其他 Codex 任务");
  });

  test("marks active external Codex sessions and sorts them first", async () => {
    const { controller, remoteSessions, outbound } = fixture();
    remoteSessions.push(
      { id: "idle_1", title: "Idle task", cwd: "D:\\work", source: "cli", status: "idle" },
      {
        id: "active_1",
        title: "Running task",
        cwd: "D:\\work",
        source: "vscode",
        status: "active",
        lastTurnStatus: "inProgress",
      },
    );

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("任务（1 个活跃）");
    expect(serialized).toContain("🟢 **活跃**");
    expect(serialized).toContain("外部执行中");
    expect(serialized).toContain("<font color='red'>Stop</font>");
    expect(serialized).toContain('"action":"session_stop","sessionId":"active_1","visibleCount":"5"');
    expect(serialized.indexOf("active_1")).toBeLessThan(serialized.indexOf("idle_1"));
  });

  test("stops an active external task from the sessions card and changes its button to Switch", async () => {
    const { controller, remoteSessions, runtime, outbound } = fixture();
    remoteSessions.push({
      id: "active_external",
      title: "External build",
      cwd: "D:\\work\\external",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_external",
      lastTurnStatus: "inProgress",
    });
    const action = {
      actionId: "stop-card-active",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_stop", sessionId: "active_external" },
    };

    await controller.onCardAction(action);
    await controller.onCardAction(action);

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledOnce();
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("active_external", "turn_external");
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", "已向 Codex 发送 Interrupt 请求：turn_external");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(updatedCard);
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"action":"session_switch","sessionId":"active_external","visibleCount":"5"');
    expect(serialized).not.toContain('"action":"session_stop","sessionId":"active_external","visibleCount":"5"');
  });

  test("forks a completed task from the sessions card and refreshes the current task", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    remoteSessions.push({
      id: "card_fork_source",
      title: "Card fork source",
      cwd: "D:\\work\\card-fork-source",
      source: "desktop",
      status: "idle",
      lastTurnId: "turn_card_fork_source",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "fork-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_fork",
        sessionId: "card_fork_source",
        visibleCount: "5",
        contextKey: "chat_id:c1",
      },
    });

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "card_fork_source",
      lastTurnId: "turn_card_fork_source",
      title: "Card fork source（分支 1）",
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      remoteSessionId: "card_fork_source_fork",
      title: "Card fork source（分支 1）",
    });
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(updatedCard)).toContain("Card fork source（分支 1）");
  });

  test("loads five more tasks into the same sessions card on demand", async () => {
    const { controller, remoteSessions, runtime, outbound } = fixture();
    for (let index = 1; index <= 7; index += 1) {
      remoteSessions.push({
        id: `task_${index}`,
        title: `Task ${index}`,
        cwd: `D:\\work\\task-${index}`,
        source: "vscode",
        status: "idle",
        updatedAt: 100 - index,
      });
    }

    await controller.onMessage(message("/sessions"));

    const initialCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const initial = JSON.stringify(initialCard);
    expect(initial).toContain("task_5");
    expect(initial).not.toContain("task_6");
    expect(initial).toContain('"content":"更多任务"');
    expect(initial).toContain('"action":"session_more","visibleCount":"5"');

    await controller.onCardAction({
      actionId: "sessions-more",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_more", visibleCount: "5" },
    });

    expect(runtime.listRemoteSessions).toHaveBeenLastCalledWith({ searchTerm: undefined, limit: 10 });
    const expandedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const expanded = JSON.stringify(expandedCard);
    expect(expanded).toContain("task_6");
    expect(expanded).toContain("task_7");
    expect(expanded).not.toContain('"content":"更多任务"');
  });

  test("stops an external task even when another context has a local route for it", async () => {
    const { controller, remoteSessions, runtime, store } = fixture();
    store.createSession({
      localSessionId: "other_context_route",
      contextKey: "chat_id:c2",
      agentName: "codex",
      cwd: "D:\\work\\external",
      status: "ready",
    });
    store.updateRuntimeSession("other_context_route", {
      runtimeKind: "codex",
      remoteSessionId: "shared_external",
    });
    remoteSessions.push({
      id: "shared_external",
      title: "External build",
      cwd: "D:\\work\\external",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_shared",
      lastTurnStatus: "inProgress",
    });

    await controller.onCardAction({
      actionId: "stop-card-cross-context",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_stop", sessionId: "shared_external" },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("shared_external", "turn_shared");
  });

  test("uses the remote terminal state instead of a stale local running state", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    store.createSession({
      localSessionId: "stale_running",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\stale",
      status: "running",
    });
    store.updateRuntimeSession("stale_running", {
      runtimeKind: "codex",
      remoteSessionId: "remote_completed",
      lastTurnId: "turn_completed",
      lastTurnStatus: "running",
    });
    remoteSessions.push({
      id: "remote_completed",
      title: "Completed elsewhere",
      cwd: "D:\\work\\stale",
      source: "vscode",
      status: "not_loaded",
      lastTurnId: "turn_completed",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("remote_completed");
    expect(serialized).toContain("未加载");
    expect(serialized).not.toContain("个活跃");
  });

  test("always lists the current task before other active tasks", async () => {
    const { controller, remoteSessions, outbound } = fixture();
    await controller.onMessage(message("/new"));
    remoteSessions.push({
      id: "active_external",
      title: "Running elsewhere",
      cwd: "D:\\work",
      source: "vscode",
      status: "active",
      lastTurnStatus: "inProgress",
      updatedAt: Date.now() + 1_000,
    });

    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized.indexOf("thr_1")).toBeLessThan(serialized.indexOf("active_external"));
    expect(serialized).not.toContain('"action":"session_switch","sessionId":"thr_1"');
    expect(serialized).not.toContain('"action":"session_stop","sessionId":"thr_1"');
    expect(serialized).toContain('"action":"session_fork","sessionId":"thr_1"');
    expect(serialized).toContain('"action":"session_status","sessionId":"thr_1"');
    expect(serialized).toContain('"action":"session_status","sessionId":"active_external"');
  });

  test("switches by the one-based order from the last sessions list", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    remoteSessions.push({
      id: "external_second",
      title: "Second task",
      cwd: "D:\\work\\second",
      source: "vscode",
      status: "idle",
      updatedAt: Date.now(),
    });

    await controller.onMessage(message("/sessions"));
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("**1.**");
    expect(serialized).toContain("**2.**");
    await controller.onMessage(message("/switch 2"));

    const context = store.getOrCreateUserContext("chat_id:c1", "codex");
    expect(context.currentSessionId).toBeDefined();
    const currentId = context.currentSessionId;
    expect(store.getSession(currentId!)?.remoteSessionId).toBe("external_second");
  });

  test("switches from a sessions card callback and refreshes the current marker", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push({
      id: "external_card_switch",
      title: "Card target",
      cwd: "D:\\work\\card-target",
      source: "vscode",
      status: "idle",
    });

    await controller.onCardAction({
      actionId: "switch-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_switch", sessionId: "external_card_switch" },
    });

    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("已切换到任务"));
    const context = store.getOrCreateUserContext("chat_id:c1", "codex");
    expect(context.currentSessionId).toBeDefined();
    const currentId = context.currentSessionId;
    expect(store.getSession(currentId!)?.remoteSessionId).toBe("external_card_switch");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(updatedCard)).toContain("✅");
  });

  test("shows task status from a sessions card without switching tasks", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push({
      id: "status_target",
      title: "Status target",
      cwd: "D:\\work\\status-target",
      source: "vscode",
      status: "idle",
      lastTurnId: "turn_status",
      lastTurnStatus: "completed",
      finalResponse: "Status result",
    });

    await controller.onCardAction({
      actionId: "sessions-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_status", sessionId: "status_target" },
    });

    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBeUndefined();
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Codex 状态：Status target");
    expect(serialized).toContain("status_target");
    expect(serialized).toContain("Status result");
    expect(serialized).toContain('"element_id":"status_execution_details"');
    expect(serialized).toContain('"expanded":false');
    expect(serialized.indexOf("最终结果")).toBeLessThan(serialized.indexOf('"element_id":"status_execution_details"'));
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"action":"session_switch","sessionId":"status_target","cardView":"status"');
  });

  test("stops an active external task from its status card and changes the action to Switch", async () => {
    const { controller, remoteSessions, runtime, outbound } = fixture();
    remoteSessions.push({
      id: "active_status_target",
      title: "Active status target",
      cwd: "D:\\work\\active-status",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_active_status",
      lastTurnStatus: "inProgress",
    });

    await controller.onCardAction({
      actionId: "show-active-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_status", sessionId: "active_status_target" },
    });
    const statusCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(JSON.stringify(statusCard)).toContain(
      '"action":"session_stop","sessionId":"active_status_target","cardView":"status"',
    );

    await controller.onCardAction({
      actionId: "stop-from-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_status",
      value: { action: "session_stop", sessionId: "active_status_target", cardView: "status" },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("active_status_target", "turn_active_status");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_status", expect.any(Object));
    const updatedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updatedCard);
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain(
      '"action":"session_switch","sessionId":"active_status_target","cardView":"status"',
    );
    expect(serialized).not.toContain(
      '"action":"session_stop","sessionId":"active_status_target","cardView":"status"',
    );
  });

  test("shows Stop on the current running task status card", async () => {
    const { controller, outbound } = fixture();
    await controller.onMessage(message("keep running"));
    await controller.onMessage(message("/status"));

    const statusCard = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(statusCard);
    expect(serialized).toContain("<font color='red'>Stop</font>");
    expect(serialized).toContain('"element_id":"status_execution_details"');
    expect(serialized).toContain('"expanded":false');
    expect(serialized.indexOf("最终结果")).toBeLessThan(serialized.indexOf('"element_id":"status_execution_details"'));
    expect(serialized).toContain(
      '"action":"session_stop","sessionId":"thr_1","cardView":"status"',
    );
    expect(serialized).not.toContain('"action":"session_switch","sessionId":"thr_1","cardView":"status"');
  });

  test("switches back to a bot-owned task while its turn is still running", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    await controller.onMessage(message("keep running"));
    const runningTask = store.listSessions("chat_id:c1")[0]!;

    store.createSession({
      localSessionId: "local_idle",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "D:\\work\\idle",
      status: "ready",
    });
    store.updateRuntimeSession("local_idle", {
      runtimeKind: "codex",
      remoteSessionId: "remote_idle",
      title: "Idle target",
    });
    remoteSessions.push({
      id: "remote_idle",
      title: "Idle target",
      cwd: "D:\\work\\idle",
      source: "vscode",
      status: "idle",
    });

    await controller.onMessage(message("/switch remote_idle"));
    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('"action":"session_switch","sessionId":"thr_1","visibleCount":"5"');
    expect(serialized).not.toContain('"action":"session_stop","sessionId":"thr_1","visibleCount":"5"');

    await controller.onCardAction({
      actionId: "switch-back-running-bot-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_switch", sessionId: "thr_1", visibleCount: "5" },
    });

    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(runningTask.localSessionId);
    expect(runtime.interruptRemoteTurn).not.toHaveBeenCalled();
  });

  test("does not switch back when the active turn was triggered outside acp-bot", async () => {
    const { controller, remoteSessions, outbound, store } = fixture();
    remoteSessions.push(
      {
        id: "external_origin",
        title: "External origin",
        cwd: "D:\\work\\external-origin",
        source: "vscode",
        status: "idle",
      },
      {
        id: "idle_target",
        title: "Idle target",
        cwd: "D:\\work\\idle-target",
        source: "vscode",
        status: "idle",
      },
    );

    await controller.onMessage({
      messageId: "switch-back-external-turn",
      contextKey: "chat_id:c1",
      text: "/switch external_origin",
    });
    const external = remoteSessions.find((session) => session.id === "external_origin")!;
    external.status = "active";
    external.lastTurnId = "external_turn";
    external.lastTurnStatus = "inProgress";
    await controller.onMessage(message("/switch idle_target"));
    const idleTask = store.findSessionByRemoteSessionId("idle_target")!;
    await controller.onMessage(message("/sessions"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('"action":"session_stop","sessionId":"external_origin","visibleCount":"5"');
    expect(serialized).not.toContain('"action":"session_switch","sessionId":"external_origin","visibleCount":"5"');

    await controller.onMessage(message("/switch external_origin"));

    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(idleTask.localSessionId);
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("不会接管或追加消息"));
  });

  test("rejects a switch position that is outside the last sessions list", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/sessions"));
    await controller.onMessage(message("/switch 1"));

    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("任务序号超出范围"));
  });

  test("switches to the previous task without an argument and supports toggling back", async () => {
    const { controller, remoteSessions, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    for (const [localSessionId, remoteSessionId] of [["local_1", "remote_1"], ["local_2", "remote_2"]] as const) {
      store.createSession({
        localSessionId,
        contextKey: "chat_id:c1",
        agentName: "codex",
        cwd: `D:\\work\\${localSessionId}`,
        status: "ready",
      });
      store.updateRuntimeSession(localSessionId, { runtimeKind: "codex", remoteSessionId, title: localSessionId });
      remoteSessions.push({ id: remoteSessionId, title: localSessionId, cwd: `D:\\work\\${localSessionId}`, source: "vscode", status: "idle" });
    }
    store.setCurrentSession("chat_id:c1", "local_1");
    store.setCurrentSession("chat_id:c1", "local_2");

    await controller.onMessage(message("/switch"));
    expect(store.getOrCreateUserContext("chat_id:c1", "codex")).toMatchObject({
      currentSessionId: "local_1",
      previousSessionId: "local_2",
    });

    await controller.onMessage({ messageId: "switch-back", contextKey: "chat_id:c1", text: "/switch" });
    expect(store.getOrCreateUserContext("chat_id:c1", "codex")).toMatchObject({
      currentSessionId: "local_2",
      previousSessionId: "local_1",
    });
  });

  test("explains when switch has no previous task", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/switch"));

    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("没有可切换的上一个任务"));
  });

  test("switches to an idle Codex task without resuming it", async () => {
    const { controller, runtime, remoteSessions, store } = fixture();
    remoteSessions.push({
      id: "external_1",
      title: "Desktop task",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "not_loaded",
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(message("/switch external_1"));

    const current = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId;
    expect(current).toBeTruthy();
    expect(store.getSession(current!)).toMatchObject({
      remoteSessionId: "external_1",
      cwd: "D:\\work\\desktop",
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
    });
    expect(runtime.resumeSession).not.toHaveBeenCalled();
  });

  test("links another chat context to the same canonical Codex task", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    store.getOrCreateUserContext("chat_id:other", "codex");
    store.createSession({
      localSessionId: "other_local",
      contextKey: "chat_id:other",
      agentName: "codex",
      cwd: "D:\\work\\shared",
      status: "ready",
    });
    store.updateRuntimeSession("other_local", {
      runtimeKind: "codex",
      remoteSessionId: "shared_remote",
      title: "Shared Codex task",
      lastTurnId: "turn_shared",
      lastTurnStatus: "completed",
    });
    remoteSessions.push({
      id: "shared_remote",
      title: "Shared Codex task",
      cwd: "D:\\work\\shared",
      source: "acp-bot",
      status: "idle",
      lastTurnId: "turn_shared",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(groupMessage("group_switch", "/switch shared_remote"));

    const current = store.getUserContext("chat_id:group_switch")?.currentSessionId;
    expect(current).toBeDefined();
    expect(current).toBe("other_local");
    expect(store.getSessionForContext(current!, "chat_id:group_switch")).toMatchObject({
      contextKey: "chat_id:group_switch",
      remoteSessionId: "shared_remote",
      status: "ready",
    });
    expect(store.listAllSessions().filter((session) => session.remoteSessionId === "shared_remote"))
      .toHaveLength(1);
    expect(store.findSessionByRemoteSessionId("shared_remote", "chat_id:other")?.localSessionId)
      .toBe("other_local");
    expect(store.findSessionByRemoteSessionId("shared_remote", "chat_id:group_switch")?.localSessionId)
      .toBe(current);
    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:group_switch",
      expect.stringContaining("已切换到任务：Shared Codex task"),
    );

    await controller.onMessage(groupMessage("group_switch", "/fork"));

    const forked = store.getUserContext("chat_id:group_switch")?.currentSessionId;
    expect(forked).toBeDefined();
    expect(forked).not.toBe("other_local");
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "shared_remote",
      lastTurnId: "turn_shared",
      localSessionId: forked,
    }));
    expect(store.getSession(forked!)).toMatchObject({
      remoteSessionId: "shared_remote_fork",
      contextKey: "chat_id:group_switch",
    });
    expect(store.listAllSessions().filter((session) => session.remoteSessionId === "shared_remote"))
      .toHaveLength(1);
  });

  test("queues a prompt from another chat instead of steering its active turn", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("first chat turn"));

    const task = store.listSessions("chat_id:c1")[0]!;
    store.saveTurnSnapshot("turn_1", task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: "turn_1",
      status: "running",
      startedAt: 1,
      plan: [],
      activities: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    }, "chat_id:c1");

    await controller.onMessage(groupMessage("second", "/switch thr_1"));
    await controller.onMessage(groupMessage("second", "second chat turn"));

    expect(store.getUserContext("chat_id:second")?.currentSessionId).toBe(task.localSessionId);
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
  });

  test("queues multiple /nosteer prompts, cancels one, and starts the rest in FIFO order", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store, listeners } = fixture();
    await controller.onMessage(message("active turn"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onMessage({ messageId: "nosteer-1", contextKey: "chat_id:c1", text: "/nosteer run tests" });
    await controller.onMessage({ messageId: "nosteer-2", contextKey: "chat_id:c1", text: "/nosteer update docs" });
    await controller.onMessage({ messageId: "nosteer-3", contextKey: "chat_id:c1", text: "/nosteer report result" });

    expect(runtime.steerTurn).not.toHaveBeenCalled();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual([
      "run tests",
      "update docs",
      "report result",
    ]);
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(outbound.updateInteractiveCard).toHaveBeenCalledTimes(2);
    let card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("排队 Prompt · 3");
    expect(JSON.stringify(card).match(/Cancel/g)).toHaveLength(3);

    const cancelled = store.listQueuedPrompts(sessionId)[1]!;
    await controller.onCardAction({
      actionId: "cancel-nosteer-2",
      contextKey: "chat_id:c1",
      messageId: "card",
      value: {
        action: "queued_prompt_cancel",
        promptId: cancelled.promptId,
        sessionId,
        contextKey: "chat_id:c1",
      },
    });
    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual([
      "run tests",
      "report result",
    ]);
    card = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(card)).toContain("排队 Prompt · 2");
    expect(JSON.stringify(card)).not.toContain("update docs");

    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "idle",
      lastTurnStatus: "completed",
    });
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId, turnId: "turn_1", finalResponse: "done" });
    }
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledTimes(2));
    expect((runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toBe("run tests");
    expect(store.listQueuedPrompts(sessionId).map((prompt) => prompt.text)).toEqual(["report result"]);

    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions.find((remote) => remote.id === "thr_1")!, {
      status: "idle",
      lastTurnStatus: "completed",
    });
    for (const listener of listeners) {
      listener({ type: "turn_completed", sessionId, turnId: "turn_1", finalResponse: "done again" });
    }
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledTimes(3));
    expect((runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toBe("report result");
    expect(store.countQueuedPrompts(sessionId)).toBe(0);
  });

  test("refuses to switch or resume a task that is running in another Codex client", async () => {
    const { controller, runtime, remoteSessions, store, outbound } = fixture();
    const external: RemoteSessionSummary = {
      id: "external_active",
      title: "Running elsewhere",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "active",
      lastTurnId: "turn_external",
      lastTurnStatus: "inProgress",
    };
    remoteSessions.push(external);

    await controller.onMessage(message("/switch external_active"));

    expect(store.findSessionByRemoteSessionId("external_active")).toBeUndefined();
    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("正在外部 Codex 中执行"));

    external.status = "idle";
    external.lastTurnStatus = "completed";
    await controller.onMessage({ messageId: "switch-after-idle", contextKey: "chat_id:c1", text: "/switch external_active" });
    external.status = "active";
    external.lastTurnId = "turn_new_external";
    external.lastTurnStatus = "inProgress";
    await controller.onMessage(message("continue from feishu"));

    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", expect.stringContaining("不会接管或追加消息"));
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

  test("switches the thinking card to an in-place activity history page", async () => {
    const { controller, presenter, store } = fixture();
    store.saveTurnSnapshot("turn_history", "s1", {
      sessionId: "s1",
      turnId: "turn_history",
      status: "completed",
      startedAt: 1,
      assistantText: "",
      plan: [],
      activities: [{ kind: "assistant", id: "commentary:1", text: "saved assistant text" }],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    });

    await controller.onCardAction({
      actionId: "activity-history-page",
      contextKey: "chat_id:c1",
      messageId: "om_thinking_card",
      value: { action: "activity_history", turnId: "turn_history", page: "0" },
    });

    expect(presenter.showActivityPage).toHaveBeenCalledWith(
      "chat_id:c1",
      "turn_history",
      0,
      "om_thinking_card",
    );

    await controller.onCardAction({
      actionId: "activity-history-latest",
      contextKey: "chat_id:c1",
      messageId: "om_thinking_card",
      value: { action: "activity_history", turnId: "turn_history", page: "latest" },
    });
    expect(presenter.showActivityPage).toHaveBeenLastCalledWith(
      "chat_id:c1",
      "turn_history",
      "latest",
      "om_thinking_card",
    );
  });

  test("stops the task identified by a thinking-card callback", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("start stoppable task"));
    const sessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    await controller.onCardAction({
      actionId: "stop-thinking-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_thinking_card",
      value: { action: "turn_cancel", sessionId, turnId: "turn_1" },
    });

    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", "已向 Codex 发送 Interrupt 请求：turn_1");
  });

  test("supports local CLI task stop and title controls", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("start task for CLI"));
    const localSessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    await expect(controller.controlSetTaskTitle(localSessionId, "CLI title")).resolves.toContain("CLI title");
    expect(runtime.setTitle).toHaveBeenCalledWith(localSessionId, "CLI title");
    expect(store.getSession(localSessionId)?.title).toBe("CLI title");

    await expect(controller.controlStopTask(localSessionId)).resolves.toContain("CLI title");
    expect(runtime.interruptRemoteTurn).toHaveBeenCalledWith("thr_1", "turn_1");
  });

  test("sends a CLI prompt to the task's existing response context without switching that context", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, presenter, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task for targeted CLI prompt"));
    const localSessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const runtimeSession = sessions.get(localSessionId)!;
    runtimeSession.activeTurnId = undefined;
    const remote = remoteSessions.find((candidate) => candidate.id === runtimeSession.remoteSessionId)!;
    remote.status = "idle";
    remote.lastTurnStatus = "completed";
    store.updateSession(localSessionId, { status: "ready" });
    store.saveTurnSnapshot("turn_latest", localSessionId, {}, "chat_id:latest");
    store.updateRuntimeSession(localSessionId, {
      lastTurnId: "turn_latest",
      lastTurnStatus: "completed",
    });
    store.attachSessionToContext("chat_id:latest", localSessionId);
    store.getOrCreateUserContext("chat_id:latest", "codex");
    store.createSession({
      localSessionId: "other_current_task",
      contextKey: "chat_id:latest",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.setCurrentSession("chat_id:latest", "other_current_task");

    await expect(controller.controlSendTaskPrompt(localSessionId, "continue from CLI"))
      .resolves.toContain("已通过机器人向原会话发送 Prompt");

    expect(outbound.sendText).toHaveBeenLastCalledWith("chat_id:latest", "continue from CLI");
    expect(runtime.startTurn).toHaveBeenLastCalledWith(localSessionId, "continue from CLI");
    expect((outbound.sendText as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1))
      .toBeLessThan((runtime.startTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!);
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      localSessionId,
      "chat_id:latest",
      "start task for targeted CLI prompt",
      expect.any(String),
    );
    expect(presenter.startPendingTurn).toHaveBeenLastCalledWith(
      localSessionId,
      "chat_id:latest",
      "start task for targeted CLI prompt",
      undefined,
    );
    expect(store.getUserContext("chat_id:latest")?.currentSessionId).toBe("other_current_task");
  });

  test("uses the live task route when an active turn context has not been persisted yet", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, outboundRouter, presenter, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task before route race"));
    const localSessionId = (runtime.startTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const runtimeSession = sessions.get(localSessionId)!;
    runtimeSession.activeTurnId = "turn_racing";
    const remote = remoteSessions.find((candidate) => candidate.id === runtimeSession.remoteSessionId)!;
    remote.status = "active";
    remote.lastTurnId = "turn_racing";
    remote.lastTurnStatus = "inProgress";
    store.updateRuntimeSession(localSessionId, {
      lastTurnId: "turn_racing",
      lastTurnStatus: "running",
    });
    store.attachSessionToContext("chat_id:latest", localSessionId);
    outboundRouter.registerSession(localSessionId, "chat_id:latest", "start task before route race", process.cwd());

    await controller.controlSendTaskPrompt(localSessionId, "steer from CLI");

    expect(outbound.sendText).toHaveBeenLastCalledWith("chat_id:latest", "steer from CLI");
    expect(runtime.steerTurn).toHaveBeenCalledWith(localSessionId, "turn_racing", "steer from CLI");
    expect((outbound.sendText as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1))
      .toBeLessThan((runtime.steerTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!);
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      localSessionId,
      "chat_id:latest",
      "start task before route race",
      expect.any(String),
    );
  });

  test("posts a CLI prompt inside the task's existing thread and anchors the new turn to that post", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, presenter, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task before threaded CLI prompt"));
    const localSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    sessions.get(localSessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions[0]!, { status: "idle", lastTurnStatus: "completed" });
    store.updateSession(localSessionId, { status: "ready" });
    const threadContextKey = "chat_id:group:thread_id:omt_thread";
    store.saveTurnSnapshot("turn_thread", localSessionId, {
      sessionId: localSessionId,
      turnId: "turn_thread",
      status: "completed",
      replyTarget: { messageId: "om_previous", replyInThread: true },
    }, threadContextKey);
    store.updateRuntimeSession(localSessionId, {
      lastTurnId: "turn_thread",
      lastTurnStatus: "completed",
    });
    store.attachSessionToContext(threadContextKey, localSessionId);
    (outbound.replyText as ReturnType<typeof vi.fn>).mockResolvedValueOnce("om_cli_prompt");

    await controller.controlSendTaskPrompt(localSessionId, "continue in this thread");

    expect(outbound.replyText).toHaveBeenCalledWith(
      threadContextKey,
      { messageId: "om_previous", replyInThread: true },
      "continue in this thread",
    );
    expect(runtime.startTurn).toHaveBeenLastCalledWith(localSessionId, "continue in this thread");
    expect(presenter.startPendingTurn).toHaveBeenLastCalledWith(
      localSessionId,
      threadContextKey,
      "start task before threaded CLI prompt",
      { messageId: "om_cli_prompt", replyInThread: true },
    );
  });

  test("does not start or steer a CLI prompt when posting it to the task route fails", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(groupMessage("origin", "start task before failed CLI post"));
    const localSessionId = store.getUserContext("chat_id:origin")!.currentSessionId!;
    (outbound.sendText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Feishu unavailable"));

    await expect(controller.controlSendTaskPrompt(localSessionId, "must be visible first"))
      .rejects.toThrow("Feishu unavailable");

    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
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
    const { controller, outbound, remoteSessions, store } = fixture();
    await controller.onMessage(message("inspect this repo"));
    Object.assign(remoteSessions[0]!, {
      createdAt: 1_776_272_400,
      updatedAt: 1_776_272_460,
      recencyAt: 1_785_000_000,
    });
    const cardsBeforeStatus = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.length;

    await controller.onMessage(message("/status"));

    const task = store.listSessions("chat_id:c1")[0]!;
    const live = await controller.controlGetTaskStatus(task.localSessionId);
    expect(live.session.createdAt).toBe(new Date(1_776_272_400_000).toISOString());
    expect(live.session.updatedAt).toBe(new Date(1_785_000_000_000).toISOString());
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(cardsBeforeStatus + 1);
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Codex 状态" } } });
    expect(serialized).toContain("当前任务");
    expect(serialized).toContain("**标题**：`inspect this repo`");
    expect(serialized).toContain("**工作目录**：");
    expect(serialized).toContain("**模型 / 思考强度**：`gpt-test` / `high`");
    expect(serialized).toContain("**状态 / 最近结果**：执行中 / 执行中");
    expect(serialized).toContain("**权限 / 任务范围**：自动执行 / 未指定项目");
    expect(serialized).toContain("**Agent**：`Codex`");
    expect(serialized).not.toContain("Agent / 运行时");
    expect(serialized).toContain("**Codex 任务 ID**：`thr_1`");
    expect(serialized).toContain("**创建时间 / 最近活动**：");
    expect(serialized).not.toContain("**创建 / 更新**：");
    expect(serialized).toContain("acp-bot");
    expect(serialized).toContain("**默认 Agent / 保活**：`codex` / 已启用");
    expect(serialized).not.toContain("任务统计");
    expect(serialized).not.toContain("###");
  });

  test("shows the remote active turn for the current externally executing task", async () => {
    const { controller, outbound, remoteSessions, store } = fixture();
    remoteSessions.push({
      id: "external_current_status",
      title: "External current task",
      cwd: "D:\\work\\external-status",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_old",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/switch external_current_status"));
    const current = store.listSessions("chat_id:c1").find(
      (session) => session.remoteSessionId === "external_current_status",
    )!;
    store.saveTurnSnapshot("turn_old", current.localSessionId, {
      sessionId: current.localSessionId,
      turnId: "turn_old",
      status: "completed",
      startedAt: 1,
      plan: [],
      activities: [{
        kind: "tool",
        id: "stale_tool",
        tool: { id: "stale_tool", title: "stale local tool", kind: "command", status: "completed" },
      }],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
      finalResponse: "stale local result",
    });
    Object.assign(remoteSessions.find((remote) => remote.id === "external_current_status")!, {
      status: "active",
      lastTurnId: "turn_external_active",
      lastTurnStatus: "inProgress",
      lastActivity: "Running external integration tests",
      finalResponse: undefined,
    });

    await controller.onMessage(message("/status"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("**状态 / 最近结果**：外部执行中 / 执行中");
    expect(serialized).toContain("**当前执行 / 排队消息**：`turn_external_active` / 0 条");
    expect(serialized).toContain("**回合 ID**：turn_external_active");
    expect(serialized).toContain("Running external integration tests");
    expect(serialized).toContain("任务仍在执行，尚无最终结果");
    expect(serialized).not.toContain("turn_old");
    expect(serialized).not.toContain("stale local tool");
    expect(serialized).not.toContain("stale local result");
  });

  test("shows the latest externally completed turn instead of a stale local snapshot", async () => {
    const { controller, outbound, remoteSessions, store } = fixture();
    remoteSessions.push({
      id: "external_completed_status",
      title: "External completed task",
      cwd: "D:\\work\\external-completed",
      source: "cli",
      status: "idle",
      lastTurnId: "turn_local_old",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/switch external_completed_status"));
    const current = store.listSessions("chat_id:c1").find(
      (session) => session.remoteSessionId === "external_completed_status",
    )!;
    store.updateRuntimeSession(current.localSessionId, {
      lastTurnId: "turn_local_old",
      lastTurnStatus: "completed",
    });
    store.saveTurnSnapshot("turn_local_old", current.localSessionId, {
      sessionId: current.localSessionId,
      turnId: "turn_local_old",
      status: "completed",
      startedAt: 1,
      plan: [],
      activities: [{ kind: "reasoning", id: "old_reasoning", text: "stale local step" }],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
      finalResponse: "stale local result",
    });
    Object.assign(remoteSessions.find((remote) => remote.id === "external_completed_status")!, {
      status: "idle",
      lastTurnId: "turn_external_latest",
      lastTurnStatus: "completed",
      lastActivity: "Latest external step",
      finalResponse: "latest external result",
      lastTurnToolCount: 7,
      lastTurnCompletedToolCount: 7,
      lastTurnFailedToolCount: 0,
      lastTurnRunningToolCount: 0,
      updatedAt: 1_785_000_000,
    });

    const live = await controller.controlGetTaskStatus(current.localSessionId);
    expect(live.session).toMatchObject({
      lastTurnId: "turn_external_latest",
      lastTurnStatus: "completed",
      status: "ready",
    });
    expect(live.snapshot).toBeUndefined();
    expect(live.remote?.finalResponse).toBe("latest external result");

    await controller.onMessage(message("/status"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("**回合 ID**：turn_external_latest");
    expect(serialized).toContain("Latest external step");
    expect(serialized).toContain("**工具执行**：完成 7，失败 0");
    expect(serialized).toContain("latest external result");
    expect(serialized).not.toContain("turn_local_old");
    expect(serialized).not.toContain("stale local step");
    expect(serialized).not.toContain("stale local result");
  });

  test("shows execution step and final result for a specified local task without switching", async () => {
    const { controller, outbound, store, sessions, remoteSessions } = fixture();
    await controller.onMessage(message("inspect this repo"));
    const task = store.listSessions("chat_id:c1")[0]!;
    sessions.get(task.localSessionId)!.activeTurnId = undefined;
    store.updateSession(task.localSessionId, { status: "ready" });
    store.updateRuntimeSession(task.localSessionId, { lastTurnId: "turn_1", lastTurnStatus: "completed" });
    Object.assign(remoteSessions.find((remote) => remote.id === task.remoteSessionId)!, {
      status: "idle",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
      lastTurnToolCount: 37,
      lastTurnCompletedToolCount: 35,
      lastTurnFailedToolCount: 2,
      lastTurnRunningToolCount: 0,
    });
    store.saveTurnSnapshot("turn_1", task.localSessionId, {
      sessionId: task.localSessionId,
      turnId: "turn_1",
      taskTitle: "inspect this repo",
      status: "completed",
      startedAt: 1_000,
      completedAt: 3_500,
      durationMs: 2_500,
      assistantText: "",
      plan: [],
      activities: [
        { kind: "tool", id: "tool_1", tool: { id: "tool_1", title: "npm test", kind: "command", status: "completed" } },
        { kind: "reasoning", id: "reasoning_1", text: "整理测试结果" },
      ],
      completedTools: [{ id: "tool_1", title: "npm test", kind: "command", status: "completed" }],
      failedTools: [],
      fileSummary: [],
      finalResponse: "全部检查完成，测试通过。",
    });

    await controller.onMessage(message(`/status ${task.localSessionId}`));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Codex 状态：inspect this repo" } } });
    expect(serialized).toContain("指定任务");
    expect(serialized).toContain("执行详情");
    expect(serialized).toContain("**当前 / 最后步骤**：整理测试结果");
    expect(serialized).toContain("**工具执行**：完成 35，失败 2");
    expect(serialized).toContain("**耗时**：2.5s");
    expect(serialized).toContain("最终结果");
    expect(serialized).toContain("全部检查完成，测试通过。");
    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(task.localSessionId);
  });

  test("reads detailed status for any Codex task without switching to it", async () => {
    const { controller, outbound, remoteSessions, runtime, store } = fixture();
    remoteSessions.push({
      id: "external_status",
      title: "Desktop build",
      cwd: "D:\\work\\desktop",
      source: "vscode",
      status: "active",
      createdAt: 1_776_272_400,
      updatedAt: 1_776_272_460,
      recencyAt: 1_785_000_000,
      lastTurnId: "turn_external",
      lastTurnStatus: "inProgress",
      lastActivity: "Running the integration tests",
    });

    await controller.onMessage(message("/status external_status"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("🟢 外部执行中");
    expect(serialized).toContain("Running the integration tests");
    expect(serialized).toContain("**状态 / 当前任务**：🟢 外部执行中 / 未切换");
    expect(serialized).toContain("**创建时间 / 最近活动**：");
    expect(serialized).not.toContain("时间未知");
    expect(serialized).not.toContain("**来源**");
    expect(serialized).toContain("任务仍在执行，尚无最终结果");
    expect(runtime.resumeSession).not.toHaveBeenCalled();
    expect(store.findSessionByRemoteSessionId("external_status")).toBeUndefined();
  });

  test("reads task status by the one-based order from the last sessions list", async () => {
    const { controller, outbound, remoteSessions, store } = fixture();
    await controller.onMessage(message("/new"));
    const currentSessionId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId;
    remoteSessions.push({
      id: "status_second",
      title: "Second status task",
      cwd: "D:\\work\\status-second",
      source: "vscode",
      status: "idle",
      lastTurnId: "turn_status_second",
      lastTurnStatus: "completed",
      lastActivity: "Finished the second task",
      finalResponse: "Second task result",
      updatedAt: Date.now(),
    });

    await controller.onMessage(message("/sessions"));
    await controller.onMessage(message("/status 2"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Codex 状态：Second status task" } } });
    expect(serialized).toContain("Second task result");
    expect(store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId).toBe(currentSessionId);
  });

  test("renders grouped help without repeating command entries", async () => {
    const { controller, outbound } = fixture();

    await controller.onMessage(message("/help"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(outbound.sendMarkdown).not.toHaveBeenCalled();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Codex 使用帮助" } } });
    expect(serialized).toContain("**任务管理**");
    expect(serialized).toContain("**执行设置**");
    expect(serialized).toContain("**Agent**");
    expect(serialized).toContain("**系统**");
    expect(serialized.match(/\/model \[name\]/g)).toHaveLength(1);
    expect(serialized.match(/\/thinking \[level\]/g)).toHaveLength(1);
    expect(serialized.match(/\/restart/g)).toHaveLength(1);
    expect(serialized.match(/\/status \[序号或任务 ID\]/g)).toHaveLength(1);
    expect(serialized.match(/\/fork \[序号或任务 ID\]/g)).toHaveLength(1);
    expect(serialized.match(/\/newgroup/g)).toHaveLength(1);
    expect(serialized.match(/\/stop/g)).toHaveLength(1);
    expect(serialized.match(/\/nosteer/g)).toHaveLength(1);
    expect(serialized.match(/\/agent \[name\]/g)).toHaveLength(1);
    expect(serialized).not.toContain("/attach");
    expect(serialized).not.toContain("/detach");
    expect(serialized).not.toContain("/cancel");
    expect(serialized).not.toContain("/close");
    expect(serialized).toContain("/switch [序号或任务 ID]");
    expect(serialized).not.toContain("/agents");
    expect(serialized).not.toContain("<id>");
    expect(serialized).not.toContain("<name>");
    expect(serialized).not.toContain("###");
    expect(serialized).not.toContain("`");
  });
});
