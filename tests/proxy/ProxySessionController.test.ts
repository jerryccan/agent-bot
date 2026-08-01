import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { generateGroupAvatarPng, resolveGroupAvatarProjectName } from "../../src/feishu/GroupAvatarGenerator.js";
import type { FeishuOutbound, IncomingMessage } from "../../src/feishu/types.js";
import type { TurnPresenter } from "../../src/presentation/OutboundRouter.js";
import { OutboundRouter } from "../../src/presentation/OutboundRouter.js";
import { ProxySessionController } from "../../src/proxy/ProxySessionController.js";
import { AgentRuntimeRegistry } from "../../src/runtime/AgentRuntimeRegistry.js";
import type { AgentRuntime, RemoteSessionSummary, RuntimeEvent, RuntimeGoal, RuntimeSession } from "../../src/runtime/types.js";
import { StateStore } from "../../src/state/StateStore.js";

vi.mock("../../src/feishu/GroupAvatarGenerator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/feishu/GroupAvatarGenerator.js")>();
  return {
    ...actual,
    generateGroupAvatarPng: vi.fn(() => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])),
  };
});

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
  let nextRemoteSessionNumber = 1;
  const goals = new Map<string, RuntimeGoal>();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const runtime: AgentRuntime = {
    kind: "codex",
    createSession: vi.fn(async (input) => {
      const session: RuntimeSession = {
        ...input,
        remoteSessionId: `thr_${nextRemoteSessionNumber++}`,
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
          source: "agent-bot",
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
        source: "agent-bot",
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
    inspectRemoteSessionActivity: vi.fn(async (id: string) => {
      const session = remoteSessions.find((candidate) => candidate.id === id);
      if (!session) throw new Error(`Unknown remote session: ${id}`);
      const active = session.status === "active" || session.lastTurnStatus === "inProgress";
      return {
        active,
        ...(active && session.lastTurnId ? { activeTurnId: session.lastTurnId } : {}),
      };
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
        supportedReasoningEfforts: [
          { value: "medium", description: "Balanced" },
          { value: "xhigh", description: "Deep" },
        ],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-controller-"));
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
  const cancelSafeRestart = vi.fn(async () => true);
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
    { restart, supervised: true, cancelSafeRestart },
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
    cancelSafeRestart,
    shellCommandExecutor,
  };
}

describe("ProxySessionController", () => {
  test("cancels a safe restart from its card action once", async () => {
    const { controller, cancelSafeRestart, outbound } = fixture();
    const action = {
      actionId: "cancel-safe-restart",
      contextKey: "chat_id:c1",
      messageId: "om_restart",
      value: {
        action: "safe_restart_cancel",
        scheduleId: "7",
      },
    };

    await controller.onCardAction(action);
    await controller.onCardAction(action);

    expect(cancelSafeRestart).toHaveBeenCalledOnce();
    expect(cancelSafeRestart).toHaveBeenCalledWith(7);
    expect(outbound.sendText).not.toHaveBeenCalled();
  });

  test("reports a stale safe restart card without affecting another schedule", async () => {
    const { controller, cancelSafeRestart, outbound } = fixture();
    cancelSafeRestart.mockResolvedValueOnce(false);

    await controller.onCardAction({
      actionId: "cancel-stale-safe-restart",
      contextKey: "chat_id:c1",
      messageId: "om_restart_old",
      value: {
        action: "safe_restart_cancel",
        scheduleId: "3",
      },
    });

    expect(cancelSafeRestart).toHaveBeenCalledWith(3);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "该安全重启计划已失效，请查看最新状态卡片。",
    );
  });

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
    const cwd = path.resolve("test-workspaces", "work space", "shell-project");
    await controller.onMessage(message(`/new --dir "${cwd}"`));

    await controller.onMessage(message("! ls"));

    expect(shellCommandExecutor).toHaveBeenCalledWith("ls", cwd);
    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("```text\n$  ls\nREADME.md\nsrc\ntests\n```"),
    );
    const markdown = (outbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(markdown).toContain(`\`${cwd}\` · 退出码 0`);
    expect(markdown).not.toContain("**目录**");
    expect(markdown).not.toContain("**命令**");
  });

  test("uses the configured default directory for bang commands without a current task", async () => {
    const { controller, shellCommandExecutor } = fixture();

    await controller.onMessage(message("！ Get-ChildItem"));

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
      "inspect this repo",
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

  test("waits for the received reaction before chat persistence, image download, and command execution", async () => {
    const { controller, runtime, outbound, store } = fixture();
    let releaseReaction!: (reactionId: string) => void;
    const reactionVisible = new Promise<string>((resolve) => { releaseReaction = resolve; });
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockReturnValueOnce(reactionVisible);
    const recordChatContext = vi.spyOn(store, "recordChatContext");
    const incoming = {
      ...groupMessage("reaction_barrier", "/sessions"),
      images: [{ imageKey: "img_barrier" }],
    };

    const processing = controller.onMessage(incoming);
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledWith(
      incoming.messageId,
      "OnIt",
    ));

    expect(recordChatContext).not.toHaveBeenCalled();
    expect(outbound.downloadImage).not.toHaveBeenCalled();
    expect(runtime.listRemoteSessions).not.toHaveBeenCalled();

    releaseReaction("reaction_visible");
    await processing;

    expect(recordChatContext).toHaveBeenCalledWith("chat_id:reaction_barrier", "group");
    expect(outbound.downloadImage).toHaveBeenCalledWith(incoming.messageId, "img_barrier");
    expect(runtime.listRemoteSessions).toHaveBeenCalled();
  });

  test("waits for the received reaction before shell execution", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    let releaseReaction!: (reactionId: string) => void;
    const reactionVisible = new Promise<string>((resolve) => { releaseReaction = resolve; });
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockReturnValueOnce(reactionVisible);

    const processing = controller.onMessage(message("! Get-ChildItem"));
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledOnce());

    expect(shellCommandExecutor).not.toHaveBeenCalled();

    releaseReaction("reaction_visible");
    await processing;

    expect(shellCommandExecutor).toHaveBeenCalledWith("Get-ChildItem", process.cwd());
  });

  test("acknowledges a queued message before the previous slow operation completes", async () => {
    const { controller, outbound, shellCommandExecutor } = fixture();
    let finishFirstCommand!: () => void;
    const firstCommand = new Promise<void>((resolve) => { finishFirstCommand = resolve; });
    (shellCommandExecutor as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        await firstCommand;
        return {
          stdout: "first complete",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
        };
      });

    const first = controller.onMessage(message("! first-slow-command"));
    await vi.waitFor(() => expect(shellCommandExecutor).toHaveBeenCalledTimes(1));

    const second = controller.onMessage(message("! second-queued-command"));
    await vi.waitFor(() => expect(outbound.addReaction).toHaveBeenCalledTimes(2));

    expect(outbound.addReaction).toHaveBeenNthCalledWith(
      2,
      "m-! second-queued-command",
      "OnIt",
    );
    expect(shellCommandExecutor).toHaveBeenCalledTimes(1);

    finishFirstCommand();
    await Promise.all([first, second]);
    expect(shellCommandExecutor).toHaveBeenCalledTimes(2);
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

  test("rejects unknown slash commands without sending text or images to the model", async () => {
    const { controller, runtime, outbound, store } = fixture();

    await controller.onMessage(message("/does-not-exist hello"));
    await controller.onMessage({
      messageId: "om_unknown_slash_image",
      contextKey: "chat_id:c1",
      text: "  /missing-with-image",
      images: [{ imageKey: "img_unused" }],
    });

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
    expect(store.listSessions("chat_id:c1")).toHaveLength(0);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "未知命令：/does-not-exist。发送 /help 查看可用命令。",
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "未知命令：/missing-with-image。发送 /help 查看可用命令。",
    );
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
        source: "agent-bot",
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
      "first group task",
    );
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(
      second,
      "chat_id:group_2",
      "second group task",
      undefined,
      "second group task",
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
      "continue differently",
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
      "continue in group topic",
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

  test("forkgroup in an unbound topic forks the original turn without creating a topic task", async () => {
    const { controller, runtime, store, listeners } = fixture();
    await controller.onMessage({
      messageId: "om_forkgroup_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build forkgroup source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    await vi.waitFor(() => {
      expect(store.findTurnAnchorByMessageId("om_forkgroup_source")?.turnId).toBe("turn_1");
    });
    (runtime.forkSession as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage({
      ...threadMessage("c1", "p2p", "omt_forkgroup_unbound", "om_forkgroup_source", "/forkgroup"),
      userId: "ou_current_user",
    });

    expect(runtime.forkSession).toHaveBeenCalledOnce();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
    }));
    expect(store.getUserContext("chat_id:c1:thread_id:omt_forkgroup_unbound")?.currentSessionId)
      .toBeUndefined();
    expect(store.getUserContext("chat_id:oc_new_group")?.currentSessionId).toBeDefined();
  });

  test("forkgroup in a bound topic with no completed topic turn falls back to the original turn", async () => {
    const { controller, runtime, sessions, store, listeners } = fixture();
    await controller.onMessage({
      messageId: "om_bound_forkgroup_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build bound forkgroup source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    await vi.waitFor(() => {
      expect(store.findTurnAnchorByMessageId("om_bound_forkgroup_source")?.turnId).toBe("turn_1");
    });

    const topicContextKey = "chat_id:c1:thread_id:omt_forkgroup_bound";
    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_forkgroup_bound",
      "om_bound_forkgroup_source",
      "/sessions",
    ));
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    expect(topicSessionId).toBeDefined();
    store.saveTurnSnapshot("turn_topic_running", topicSessionId!, {
      sessionId: topicSessionId,
      turnId: "turn_topic_running",
      status: "running",
      startedAt: 10,
    }, topicContextKey);
    store.updateSession(topicSessionId!, { status: "running" });
    store.updateRuntimeSession(topicSessionId!, {
      lastTurnId: "turn_topic_running",
      lastTurnStatus: "running",
    });
    sessions.get(topicSessionId!)!.activeTurnId = "turn_topic_running";
    (runtime.forkSession as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage({
      ...threadMessage("c1", "p2p", "omt_forkgroup_bound", "om_bound_forkgroup_source", "/forkgroup"),
      userId: "ou_current_user",
    });

    expect(runtime.forkSession).toHaveBeenCalledOnce();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
    }));
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBe(topicSessionId);
  });

  test("forkgroup in a bound topic forks its latest completed turn while a later turn is running", async () => {
    const { controller, runtime, sessions, store, listeners } = fixture();
    await controller.onMessage({
      messageId: "om_progressed_forkgroup_source",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      text: "build progressed forkgroup source",
    });
    const sourceSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    for (const listener of listeners) {
      listener({
        type: "turn_completed",
        sessionId: sourceSessionId!,
        turnId: "turn_1",
        finalResponse: "source complete",
      });
    }
    await vi.waitFor(() => {
      expect(store.findTurnAnchorByMessageId("om_progressed_forkgroup_source")?.turnId).toBe("turn_1");
    });

    const topicContextKey = "chat_id:c1:thread_id:omt_forkgroup_progressed";
    await controller.onMessage(threadMessage(
      "c1",
      "p2p",
      "omt_forkgroup_progressed",
      "om_progressed_forkgroup_source",
      "/sessions",
    ));
    const topicSessionId = store.getUserContext(topicContextKey)?.currentSessionId;
    const topicSession = store.getSession(topicSessionId!);
    expect(topicSession?.remoteSessionId).toBe("thr_1_fork");
    store.saveTurnSnapshot("turn_topic_completed", topicSessionId!, {
      sessionId: topicSessionId,
      turnId: "turn_topic_completed",
      status: "completed",
      startedAt: 20,
      completedAt: 30,
    }, topicContextKey);
    store.saveTurnSnapshot("turn_topic_running", topicSessionId!, {
      sessionId: topicSessionId,
      turnId: "turn_topic_running",
      status: "running",
      startedAt: 40,
    }, topicContextKey);
    store.updateSession(topicSessionId!, { status: "running" });
    store.updateRuntimeSession(topicSessionId!, {
      lastTurnId: "turn_topic_running",
      lastTurnStatus: "running",
    });
    sessions.get(topicSessionId!)!.activeTurnId = "turn_topic_running";
    (runtime.forkSession as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage({
      ...threadMessage(
        "c1",
        "p2p",
        "omt_forkgroup_progressed",
        "om_progressed_forkgroup_source",
        "/forkgroup",
      ),
      userId: "ou_current_user",
    });

    expect(runtime.forkSession).toHaveBeenCalledOnce();
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: "thr_1_fork",
      lastTurnId: "turn_topic_completed",
    }));
    expect(store.getUserContext(topicContextKey)?.currentSessionId).toBe(topicSessionId);
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

  test("forks the current task's latest completed turn into a new Feishu group", async () => {
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

    await controller.onMessage({
      messageId: "fork-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup 并行修复",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: expect.stringMatching(/^\[codex\] \[(?:.{1,15})\] 并行修复$/u),
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(groupSessionId).toBeDefined();
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBe(sourceSessionId);
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessionId,
      remoteSessionId: "thr_1",
      lastTurnId: "turn_1",
      title: "并行修复",
      cwd: store.getSession(sourceSessionId!)?.cwd,
    }));
    expect(store.getSession(groupSessionId!)).toMatchObject({
      contextKey: "chat_id:oc_new_group",
      remoteSessionId: "thr_1_fork",
      title: "并行修复",
      status: "ready",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    expect(presenter.registerSession).toHaveBeenLastCalledWith(
      groupSessionId,
      "chat_id:oc_new_group",
      "并行修复",
      store.getSession(sourceSessionId!)?.cwd,
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      expect.stringMatching(/^已从当前任务最新轮次创建分支。\n当前任务：并行修复（thr_1_fork）\n当前 Project 目录：.+$/),
    );
    expect((outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls)
      .not.toContainEqual(["chat_id:oc_new_group", expect.anything()]);
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringMatching(/^已将当前任务 Fork 到飞书群：.+；新群当前任务为 并行修复（thr_1_fork）。$/),
    );
  });

  test("uses the same generated branch title for forkgroup as fork", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners, outbound } = fixture();
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

    await controller.onMessage({
      messageId: "fork-group-default-title",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: expect.stringMatching(/^\[codex\] \[(?:.{1,15})\] build the source task（分支 1）$/u),
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "build the source task（分支 1）",
    }));
  });

  test("truncates a long generated forkgroup name without changing the fork task title", async () => {
    const { controller, runtime, sessions, remoteSessions, store, listeners, outbound } = fixture();
    const longSourceTitle = "修复一个特别长的源任务标题用于验证 forkgroup 群名不会超过飞书限制";
    await controller.onMessage(message(longSourceTitle));
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

    await controller.onMessage({
      messageId: "fork-group-long-name",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(Array.from(groupInput.name)).toHaveLength(60);
    expect(groupInput.name).not.toMatch(/ \(\d{2}-\d{2}\)$/);
    expect(groupInput.name).toContain("...");
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      title: `${longSourceTitle}（分支 1）`,
    }));
  });

  test("does not create a group when the current task has no completed turn to fork", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("long-running source"));

    await controller.onMessage({
      messageId: "fork-group-too-early",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/forkgroup",
    });

    expect(outbound.createGroup).not.toHaveBeenCalled();
    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("还没有已完成轮次"),
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

  test("refuses to fork a running task that has no completed turn yet", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("long-running source"));

    await controller.onMessage(message("/fork"));

    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("还没有已完成轮次"),
    );
  });

  test("new always uses the current default agent and accepts cwd through --dir", async () => {
    const { controller, runtime, store } = fixture();
    const cwd = path.resolve("test-workspaces", "work space", "repo");
    await controller.onMessage(message("/agent acp"));
    await controller.onMessage(message(`/new --dir "${cwd}"`));

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "acp",
      cwd,
    }));
    expect(store.listSessions("chat_id:c1").at(-1)).toMatchObject({
      agentName: "acp",
      cwd,
    });
  });

  test("rejects --nodir when the current default agent is not Codex", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("/agent acp"));

    await controller.onMessage(message("/new --nodir"));

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      "/new --nodir 仅支持 Codex Agent。",
    );
  });

  test("creates a task with an explicit title and synchronizes it with the runtime", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    const cwd = path.resolve("test-workspaces", "work");

    await controller.onMessage(message(`/new 修复会话列表时间 --dir "${cwd}"`));

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "修复会话列表时间",
      cwd,
    }));
    const session = store.listSessions("chat_id:c1")[0]!;
    expect(session.title).toBe("修复会话列表时间");
    expect(presenter.registerSession).toHaveBeenCalledWith(
      session.localSessionId,
      "chat_id:c1",
      "修复会话列表时间",
      cwd,
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("修复会话列表时间"),
    );
  });

  test("creates a Feishu group with a bound task without sending a sessions card", async () => {
    const { controller, runtime, store, outbound, presenter } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage({
      messageId: "new-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup 广州天气",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[codex] [Projectless] 广州天气",
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
    const groupContext = store.getUserContext("chat_id:oc_new_group");
    const groupSessions = store.listSessions("chat_id:oc_new_group");
    expect(groupSessions).toHaveLength(1);
    expect(groupContext).toMatchObject({
      defaultAgent: "codex",
      currentSessionId: groupSessions[0]!.localSessionId,
    });
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessions[0]!.localSessionId,
      title: "广州天气",
      model: undefined,
      reasoningEffort: undefined,
      permissionMode: "auto",
    }));
    expect(presenter.registerSession).toHaveBeenCalledWith(
      groupSessions[0]!.localSessionId,
      "chat_id:oc_new_group",
      "广州天气",
      expect.any(String),
    );
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      "群和新任务已创建。\n当前任务：广州天气（thr_1）\n当前 Project 目录：未绑定（Projectless）\n当前模型：gpt-test\n思考强度：high",
    );
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringMatching(
        /^已创建飞书群：\[codex\] \[Projectless\] 广州天气，并创建新任务 广州天气（thr_1）。$/,
      ),
    );
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
  });

  test("binds a new group task to the source project and reuses it for the first prompt", async () => {
    const { controller, runtime, store, outbound } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    tempDirs.push(project);
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Project room",
    });

    const groupContext = store.getUserContext("chat_id:oc_new_group");
    expect(groupContext).toMatchObject({
      currentSessionId: expect.any(String),
      boundProjectCwd: project,
    });
    expect((outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]?.avatarPng)
      .toEqual(generateGroupAvatarPng(resolveGroupAvatarProjectName(project, "Project room"), project));
    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: project,
      title: "Project room",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    }));
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      `群和新任务已创建。\n当前任务：Project room（thr_2）\n当前 Project 目录：${project}\n当前模型：gpt-test\n思考强度：high`,
    );

    const createCount = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls.length;
    await controller.onMessage(groupMessage("oc_new_group", "inspect this project"));

    expect(runtime.createSession).toHaveBeenCalledTimes(createCount);
    expect(runtime.startTurn).toHaveBeenCalledWith(
      groupContext!.currentSessionId,
      "inspect this project",
    );
  });

  test("inherits model, reasoning effort, and permission mode from the source task", async () => {
    const { controller, runtime, store } = fixture();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    tempDirs.push(project);
    await controller.onMessage(message(`/new --dir "${project}"`));
    const sourceSessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    const source = store.getSession(sourceSessionId)!;
    store.updateRuntimeSession(source.localSessionId, {
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });

    await controller.onMessage({
      messageId: "new-inherited-settings-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Inherited settings",
    });

    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: project,
      title: "Inherited settings",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")!.currentSessionId!;
    expect(store.getSession(groupSessionId)).toMatchObject({
      cwd: project,
      title: "Inherited settings",
      model: "gpt-next",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    });
  });

  test("lets an explicit directory override a new group's bound project", async () => {
    const { controller, runtime } = fixture();
    const sourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-source-project-"));
    const explicitProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-explicit-project-"));
    tempDirs.push(sourceProject, explicitProject);
    await controller.onMessage(message(`/new --dir "${sourceProject}"`));
    await controller.onMessage({
      messageId: "new-project-group-override",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Override room",
    });

    await controller.onMessage(groupMessage("oc_new_group", `/new --dir "${explicitProject}"`));

    expect(runtime.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: explicitProject,
    }));
  });

  test("uses the local mm-dd date when newgroup omits the title", async () => {
    const { controller, runtime, outbound } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage({
      messageId: "new-group-default-title",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(groupInput.name).toMatch(
      /^\[codex\] \[Projectless\] 新任务 \(\d{2}-\d{2}\)$/,
    );
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "新任务",
      model: undefined,
      reasoningEffort: undefined,
      permissionMode: "auto",
    }));
  });

  test("reports a new task creation failure inside the already-created group", async () => {
    const { controller, runtime, outbound } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-newgroup-home-"));
    tempDirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    (runtime.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("thread/start failed"));

    await controller.onMessage({
      messageId: "new-group-task-failure",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Broken task",
    });

    expect(outbound.createGroup).toHaveBeenCalledOnce();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:oc_new_group",
      "群已创建，但新任务创建失败：thread/start failed",
    );
    expect(outbound.sendText).toHaveBeenCalledWith("chat_id:c1", "thread/start failed");
  });

  test("uses a tilde for a project directory inside the user home directory", async () => {
    const { controller, outbound } = fixture();
    await controller.onMessage(message(`/new --dir "${os.homedir()}"`));

    await controller.onMessage({
      messageId: "new-home-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup Home project",
    });

    expect(outbound.createGroup).toHaveBeenCalledWith({
      name: "[codex] [~] Home project",
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    });
  });

  test("keeps readable trailing directories in the generated group name", async () => {
    const { controller, outbound } = fixture();
    const project = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-long-project-")),
      "dev",
      "agent-bot",
    );
    fs.mkdirSync(project, { recursive: true });
    tempDirs.push(path.dirname(path.dirname(project)));
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-long-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(groupInput.name).toMatch(/^\[codex\] \[[^\]]+\] 新任务 \(\d{2}-\d{2}\)$/);
    const projectDisplay = /^\[codex\] \[([^\]]+)\]/.exec(groupInput.name)?.[1];
    expect(projectDisplay).toBe(`dev${path.sep}agent-bot`);
  });

  test("falls back to the leaf directory when the trailing pair is too long for a group name", async () => {
    const { controller, outbound } = fixture();
    const project = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-long-project-")),
      "a-very-long-middle-directory-name",
      "project-tail",
    );
    fs.mkdirSync(project, { recursive: true });
    tempDirs.push(path.dirname(path.dirname(project)));
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-long-leaf-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const projectDisplay = /^\[codex\] \[([^\]]+)\]/.exec(groupInput.name)?.[1];
    expect(projectDisplay).toBe("project-tail");
  });

  test("truncates the tail when the leaf directory is too long for a group name", async () => {
    const { controller, outbound } = fixture();
    const project = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-long-project-")),
      "dev",
      "a-very-long-project-tail",
    );
    fs.mkdirSync(project, { recursive: true });
    tempDirs.push(path.dirname(path.dirname(project)));
    await controller.onMessage(message(`/new --dir "${project}"`));

    await controller.onMessage({
      messageId: "new-overlong-leaf-project-group",
      contextKey: "chat_id:c1",
      chatId: "c1",
      chatType: "p2p",
      userId: "ou_current_user",
      text: "/newgroup",
    });

    const groupInput = (outbound.createGroup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const projectDisplay = /^\[codex\] \[([^\]]+)\]/.exec(groupInput.name)?.[1];
    expect(projectDisplay).toBe("a-very-long-...");
    expect(Array.from(projectDisplay ?? "")).toHaveLength(15);
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-projectless-home-"));
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
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-project-"));
    tempDirs.push(project);

    await controller.onMessage(message(`/new --dir "${project}"`));
    await controller.onMessage({ messageId: "new-in-project", contextKey: "chat_id:c1", text: "/new" });

    expect((runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      cwd: project,
    });
  });

  test("forces a fresh projectless workspace with /new --nodir from a project task", async () => {
    const { controller, runtime } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-projectless-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-project-"));
    tempDirs.push(home, project);
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await controller.onMessage(message(`/new --dir "${project}"`));
    await controller.onMessage({
      messageId: "new-forced-projectless",
      contextKey: "chat_id:c1",
      text: "/new Detached task --nodir",
    });

    const input = (runtime.createSession as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    const projectlessRoot = path.join(home, "Documents", "Codex");
    expect(path.relative(projectlessRoot, input.cwd)).toMatch(
      /^\d{4}-\d{2}-\d{2}[\\/]detached-task$/,
    );
    expect(input.cwd).not.toBe(project);
    expect(fs.statSync(path.join(input.cwd, "work")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(input.cwd, "outputs")).isDirectory()).toBe(true);
  });

  test("creates a fresh projectless workspace when new is sent from a projectless task", async () => {
    const { controller, runtime } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-projectless-home-"));
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
      beforeName: "[codex] [dev\\agent-bot] old title",
      afterName: "[Codex] [dev\\agent-bot] abc",
    });

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "abc");
    expect(store.getSession(sessionId)?.title).toBe("abc");
    expect(presenter.updateSessionTitle).toHaveBeenCalledWith(sessionId, "abc");
    expect(outbound.sendText).toHaveBeenCalledTimes(sentMessageCount);
  });

  test("keeps supporting group names without a project prefix when renaming a task", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(groupMessage("rename_legacy_group", "old title"));
    const sessionId = store.getUserContext("chat_id:rename_legacy_group")!.currentSessionId!;

    await controller.onChatUpdated({
      chatId: "rename_legacy_group",
      beforeName: "[codex] old title",
      afterName: "[Codex] legacy title",
    });

    expect(runtime.setTitle).toHaveBeenCalledWith(sessionId, "legacy title");
    expect(store.getSession(sessionId)?.title).toBe("legacy title");
  });

  test("ignores a group name containing only agent and project prefixes", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(groupMessage("rename_prefix_only", "current title"));
    const sessionId = store.getUserContext("chat_id:rename_prefix_only")!.currentSessionId!;

    await controller.onChatUpdated({
      chatId: "rename_prefix_only",
      beforeName: "[codex] [dev\\agent-bot] current title",
      afterName: "[codex] [dev\\agent-bot]",
    });

    expect(runtime.setTitle).not.toHaveBeenCalled();
    expect(store.getSession(sessionId)?.title).toBe("current title");
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

  test("does not apply a stale cancelled reaction after the same turn is active again", async () => {
    const { controller, store, outbound, listeners, presenter } = fixture();
    (outbound.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue("reaction_on_it");
    let releaseCancelledPresentation!: () => void;
    const cancelledPresentation = new Promise<void>((resolve) => { releaseCancelledPresentation = resolve; });
    (presenter.onEvent as ReturnType<typeof vi.fn>).mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "turn_cancelled") await cancelledPresentation;
    });

    await controller.onMessage(message("keep running"));
    const session = store.listSessions("chat_id:c1")[0]!;
    for (const listener of listeners) {
      listener({ type: "turn_cancelled", sessionId: session.localSessionId, turnId: "turn_1" });
    }
    await vi.waitFor(() => expect(presenter.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "turn_cancelled",
      turnId: "turn_1",
    })));
    for (const listener of listeners) {
      listener({
        type: "turn_started",
        sessionId: session.localSessionId,
        turnId: "turn_1",
        startedAt: Date.now(),
      });
    }
    releaseCancelledPresentation();

    await vi.waitFor(() => expect(store.getSession(session.localSessionId)?.lastTurnStatus).toBe("running"));
    expect(store.getMessageReaction("m-keep running")).toMatchObject({ status: "pending", emojiType: "OnIt" });
    expect(outbound.addReaction).not.toHaveBeenCalledWith("m-keep running", "CrossMark");
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
      expect.objectContaining({ header: expect.objectContaining({ title: expect.objectContaining({ content: "Agent Bot 使用帮助" }) }) }),
    );
    releaseSteer();
    await blockedPrompt;
  });

  test("/queue can enqueue while a normal steer request is blocked", async () => {
    const { controller, runtime, outbound, presenter, store } = fixture();
    await controller.onMessage(message("build it"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    let releaseSteer!: () => void;
    (runtime.steerTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSteer = resolve; }),
    );

    const blockedPrompt = controller.onMessage(message("also update docs"));
    await vi.waitFor(() => expect(runtime.steerTurn).toHaveBeenCalled());
    await controller.onMessage(message("/queue run tests afterwards"));

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
      source: "agent-bot",
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
      source: "agent-bot",
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
      source: "agent-bot",
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
    (runtime.inspectRemoteSessionActivity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(
        "thread/read failed: thread thr_1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );

    await controller.onMessage(message("hello from the first turn"));

    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "hello from the first turn");
    expect(runtime.synchronizeSession).not.toHaveBeenCalled();
  });

  test("starts a prompt on a completed large task without reading or synchronizing its full history", async () => {
    const { controller, runtime, sessions, remoteSessions, store } = fixture();
    await controller.onMessage(message("first prompt"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    sessions.get(sessionId)!.activeTurnId = undefined;
    Object.assign(remoteSessions[0]!, {
      status: "idle",
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    store.updateSession(sessionId, { status: "ready" });
    store.updateRuntimeSession(sessionId, {
      lastTurnId: "turn_1",
      lastTurnStatus: "completed",
    });
    (runtime.readRemoteSession as ReturnType<typeof vi.fn>).mockClear();
    (runtime.inspectRemoteSessionActivity as ReturnType<typeof vi.fn>).mockClear();
    (runtime.synchronizeSession as ReturnType<typeof vi.fn>).mockClear();
    (runtime.startTurn as ReturnType<typeof vi.fn>).mockClear();

    await controller.onMessage(message("continue without loading 300 MB of history"));

    expect(runtime.inspectRemoteSessionActivity).toHaveBeenCalledWith("thr_1");
    expect(runtime.readRemoteSession).not.toHaveBeenCalled();
    expect(runtime.synchronizeSession).not.toHaveBeenCalled();
    expect(runtime.startTurn).toHaveBeenCalledWith(
      sessionId,
      "continue without loading 300 MB of history",
    );
  });

  test("recreates an empty Codex thread after restart instead of resuming a missing rollout", async () => {
    const { controller, runtime, store, remoteSessions } = fixture();
    remoteSessions.push({
      id: "thr_without_rollout",
      cwd: process.cwd(),
      source: "agent-bot",
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
    expect(serialized).toContain("<font color='blue'>New</font>");
    expect(serialized).toContain('"action":"session_new","sessionId":"external_1","searchTerm":"Desktop","visibleCount":"5"');
    expect(serialized).toContain("<font color='blue'>NewGroup</font>");
    expect(serialized).toContain('"action":"session_new_group","sessionId":"external_1","searchTerm":"Desktop","visibleCount":"5"');
    expect(serialized).toContain("<font color='blue'>Fork</font>");
    expect(serialized).toContain('"action":"session_fork","sessionId":"external_1","searchTerm":"Desktop","visibleCount":"5"');
    expect(serialized).toContain("<font color='blue'>ForkGroup</font>");
    expect(serialized).toContain('"action":"session_fork_group","sessionId":"external_1","searchTerm":"Desktop","visibleCount":"5"');
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

  test("creates and switches to a new task in the selected sessions-card project", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "card-new-source");
    remoteSessions.push({
      id: "card_new_source",
      title: "Card new source",
      cwd,
      source: "desktop",
      status: "active",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      lastTurnId: "turn_card_new_source",
      lastTurnStatus: "inProgress",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "new-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_new",
        sessionId: "card_new_source",
        visibleCount: "5",
        contextKey: "chat_id:c1",
      },
    });

    const createdSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: createdSessionId,
      agentName: "codex",
      cwd,
      title: undefined,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
    expect(store.getSession(createdSessionId!)).toMatchObject({
      remoteSessionId: "thr_1",
      cwd,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      status: "ready",
    });
    expect(runtime.interruptRemoteTurn).not.toHaveBeenCalled();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("已创建 Codex 任务"),
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("creates a new group and task in the selected sessions-card project", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "card-new-group-source");
    remoteSessions.push({
      id: "card_new_group_source",
      title: "Card new group source",
      cwd,
      source: "desktop",
      status: "idle",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      lastTurnId: "turn_card_new_group_source",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "new-group-card-task",
      contextKey: "chat_id:c1",
      userId: "ou_current_user",
      messageId: "om_sessions",
      value: {
        action: "session_new_group",
        sessionId: "card_new_group_source",
        visibleCount: "5",
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^\[codex\] \[[^\]]+\] 新任务 \(\d{2}-\d{2}\)$/u),
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    }));
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessionId,
      agentName: "codex",
      cwd,
      title: "新任务",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
    }));
    expect(store.getSession(groupSessionId!)).toMatchObject({
      contextKey: "chat_id:oc_new_group",
      cwd,
      title: "新任务",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "confirm",
      status: "ready",
    });
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("forks a selected sessions-card task into a new group", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "card-fork-group-source");
    remoteSessions.push({
      id: "card_fork_group_source",
      title: "Card fork group source",
      cwd,
      source: "desktop",
      status: "idle",
      lastTurnId: "turn_card_fork_group_source",
      lastTurnStatus: "completed",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "fork-group-card-task",
      contextKey: "chat_id:c1",
      userId: "ou_current_user",
      messageId: "om_sessions",
      value: {
        action: "session_fork_group",
        sessionId: "card_fork_group_source",
        visibleCount: "5",
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringContaining("Card fork group source（分支 1）"),
      userOpenId: "ou_current_user",
      avatarPng: expect.any(Uint8Array),
    }));
    const groupSessionId = store.getUserContext("chat_id:oc_new_group")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: groupSessionId,
      remoteSessionId: "card_fork_group_source",
      lastTurnId: "turn_card_fork_group_source",
      cwd,
      title: "Card fork group source（分支 1）",
    }));
    expect(store.getSession(groupSessionId!)).toMatchObject({
      contextKey: "chat_id:oc_new_group",
      remoteSessionId: "card_fork_group_source_fork",
      lastTurnId: "turn_card_fork_group_source",
      lastTurnStatus: "completed",
      status: "ready",
    });
    expect(store.getUserContext("chat_id:c1")?.currentSessionId).toBeUndefined();
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("已将指定任务 Fork 到飞书群"),
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("inherits locally tracked execution settings when the remote task omits them", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    const cwd = path.resolve("test-workspaces", "locally-tracked-source");
    store.createSession({
      localSessionId: "local_card_new_source",
      contextKey: "chat_id:source",
      agentName: "codex",
      cwd,
      status: "ready",
    });
    store.updateRuntimeSession("local_card_new_source", {
      runtimeKind: "codex",
      remoteSessionId: "locally_tracked_source",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    remoteSessions.push({
      id: "locally_tracked_source",
      cwd,
      source: "agent-bot",
      status: "idle",
    });

    await controller.onCardAction({
      actionId: "new-locally-tracked-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_new",
        sessionId: "locally_tracked_source",
        visibleCount: "5",
        contextKey: "chat_id:c1",
      },
    });

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      permissionMode: "auto",
    }));
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
  });

  test("forks an active task from its latest completed turn through the sessions card", async () => {
    const { controller, remoteSessions, runtime, outbound, store } = fixture();
    remoteSessions.push({
      id: "active_card_fork_source",
      title: "Active card fork source",
      cwd: "D:\\work\\active-card-fork-source",
      source: "desktop",
      status: "active",
      lastTurnId: "turn_still_running",
      lastCompletedTurnId: "turn_latest_completed",
      lastTurnStatus: "inProgress",
    });
    await controller.onMessage(message("/sessions"));

    await controller.onCardAction({
      actionId: "fork-active-card-task",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: {
        action: "session_fork",
        sessionId: "active_card_fork_source",
        visibleCount: "5",
        contextKey: "chat_id:c1",
      },
    });

    const forkedSessionId = store.getUserContext("chat_id:c1")?.currentSessionId;
    expect(runtime.forkSession).toHaveBeenCalledWith(expect.objectContaining({
      localSessionId: forkedSessionId,
      remoteSessionId: "active_card_fork_source",
      lastTurnId: "turn_latest_completed",
      title: "Active card fork source（分支 1）",
    }));
    expect(store.getSession(forkedSessionId!)).toMatchObject({
      remoteSessionId: "active_card_fork_source_fork",
      status: "ready",
      lastTurnId: "turn_latest_completed",
      lastTurnStatus: "completed",
    });
    expect(outbound.sendText).toHaveBeenCalledWith(
      "chat_id:c1",
      expect.stringContaining("已从指定任务最近已完成轮次创建分支"),
    );
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_sessions", expect.any(Object));
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
    expect(initial).toContain('"content":"More"');
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
    expect(expanded).not.toContain('"content":"More"');
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
    expect(serialized).toContain("<font color='blue'>Refresh</font>");
    expect(serialized).toContain('"action":"session_status_refresh","sessionId":"status_target","cardView":"status"');
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"action":"session_switch","sessionId":"status_target","cardView":"status"');
  });

  test("refreshes a status card in place with the latest task state", async () => {
    const { controller, remoteSessions, outbound } = fixture();
    remoteSessions.push({
      id: "refresh_status_target",
      title: "Refresh status target",
      cwd: "D:\\work\\refresh-status",
      source: "vscode",
      status: "idle",
      lastTurnId: "turn_before_refresh",
      lastTurnStatus: "completed",
      finalResponse: "Result before refresh",
    });

    await controller.onCardAction({
      actionId: "show-refreshable-status",
      contextKey: "chat_id:c1",
      messageId: "om_sessions",
      value: { action: "session_status", sessionId: "refresh_status_target" },
    });
    Object.assign(remoteSessions[0]!, {
      status: "active",
      lastTurnId: "turn_after_refresh",
      lastTurnStatus: "inProgress",
      lastActivity: "Running after refresh",
      finalResponse: undefined,
    });

    await controller.onCardAction({
      actionId: "refresh-task-status",
      contextKey: "chat_id:c1",
      messageId: "om_status",
      value: {
        action: "session_status_refresh",
        sessionId: "refresh_status_target",
        cardView: "status",
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_status", expect.any(Object));
    const refreshedCard = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(refreshedCard);
    expect(serialized).toContain("turn_after_refresh");
    expect(serialized).toContain("Running after refresh");
    expect(serialized).toContain('"action":"session_status_refresh","sessionId":"refresh_status_target"');
    expect(serialized).toContain('"action":"session_stop","sessionId":"refresh_status_target"');
    expect(serialized).not.toContain("Result before refresh");
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
    expect(serialized).toContain('"action":"session_status_refresh","sessionId":"thr_1","cardView":"status"');
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

  test("does not switch back when the active turn was triggered outside agent-bot", async () => {
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
      source: "agent-bot",
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

  test("queues multiple /queue and /nosteer prompts, cancels one, and starts the rest in FIFO order", async () => {
    const { controller, runtime, sessions, remoteSessions, outbound, store, listeners } = fixture();
    await controller.onMessage(message("active turn"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onMessage({ messageId: "nosteer-1", contextKey: "chat_id:c1", text: "/queue run tests" });
    await controller.onMessage({ messageId: "nosteer-2", contextKey: "chat_id:c1", text: "/queue update docs" });
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
      .resolves.toContain("Prompt was posted to the original chat");

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
      "continue from CLI",
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
      "continue in this thread",
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

  test("shows every supported model with link-style switch actions and marks the current model", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/model"));

    expect(runtime.listModels).toHaveBeenCalled();
    expect(outbound.sendInteractiveCard).toHaveBeenCalled();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    expect(serialized).toContain("当前模型");
    expect(serialized).toContain("思考强度");
    expect(serialized).toContain("gpt-test");
    expect(serialized).toContain("gpt-next");
    expect(serialized).not.toContain("GPT Test");
    expect(serialized).not.toContain("GPT Next");
    expect(serialized).toContain("✅ 当前");
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain('"tag":"interactive_container"');
    expect(serialized).not.toContain('"tag":"button"');
    expect(serialized).toContain(`"action":"model_select","sessionId":"${sessionId}"`);
    expect(serialized).toContain('"model":"gpt-next"');
    const modelRows = ((card as { body?: { elements?: Array<Record<string, unknown>> } })?.body?.elements ?? [])
      .filter((element) => element.tag === "column_set");
    expect(modelRows).toHaveLength(2);
    for (const row of modelRows) {
      expect(row).toMatchObject({ flex_mode: "none" });
      const columns = row.columns as Array<Record<string, unknown>>;
      expect(columns).toHaveLength(2);
      expect(columns[0]).toMatchObject({ width: "weighted" });
      expect(columns[1]).toMatchObject({ width: "auto" });
    }
  });

  test("switches the model from a card callback and advances the card to reasoning selection", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onCardAction({
      actionId: "select-model-next",
      contextKey: "chat_id:c1",
      messageId: "om_model",
      value: {
        action: "model_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
      },
    });

    expect(runtime.setModel).toHaveBeenCalledWith(sessionId, "gpt-next");
    expect(runtime.setReasoningEffort).toHaveBeenCalledWith(sessionId, "medium");
    expect(store.getSession(sessionId)).toMatchObject({
      model: "gpt-next",
      reasoningEffort: "medium",
    });
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_model", expect.any(Object));
    const updated = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updated);
    expect(serialized).toContain("思考模式");
    expect(serialized).toContain("模型已切换为 `gpt-next`，请选择思考模式");
    expect(serialized).toContain("gpt-next");
    expect(serialized).toContain("medium");
    expect(serialized).toContain("xhigh");
    expect(serialized).toContain("✅ 当前");
    expect(serialized).toContain("<font color='blue'>Switch</font>");
    expect(serialized).toContain("<font color='blue'>Back</font>");
    expect(serialized).toContain('"action":"model_open"');
    expect(serialized).toContain('"action":"reasoning_select"');
    expect(serialized).toContain('"model":"gpt-next","effort":"xhigh"');
    expect(serialized).not.toContain('"action":"model_select"');
    const bodyElements = (updated as { body?: { elements?: Array<Record<string, unknown>> } })?.body?.elements ?? [];
    expect(bodyElements.at(-2)).toMatchObject({ tag: "hr" });
    expect(JSON.stringify(bodyElements.at(-1))).toContain('"action":"model_open"');
  });

  test("switches reasoning from the follow-up card and updates it in place", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;
    await controller.onMessage(message("/model gpt-next"));
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await controller.onCardAction({
      actionId: "select-reasoning-xhigh",
      contextKey: "chat_id:c1",
      messageId: "om_model",
      value: {
        action: "reasoning_select",
        sessionId,
        contextKey: "chat_id:c1",
        model: "gpt-next",
        effort: "xhigh",
      },
    });

    expect(runtime.setReasoningEffort).toHaveBeenLastCalledWith(sessionId, "xhigh");
    expect(store.getSession(sessionId)).toMatchObject({ reasoningEffort: "xhigh" });
    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_model", expect.any(Object));
    const updated = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updated);
    expect(serialized).toContain("思考模式已切换为 `xhigh`，从下一次请求生效");
    expect(serialized).toContain("✅ 当前");
    expect(serialized).toContain('"effort":"medium"');
  });

  test("returns from reasoning selection to the model selector in place", async () => {
    const { controller, outbound, store } = fixture();
    await controller.onMessage(message("/new"));
    const sessionId = store.getUserContext("chat_id:c1")!.currentSessionId!;

    await controller.onCardAction({
      actionId: "return-to-models",
      contextKey: "chat_id:c1",
      messageId: "om_model",
      value: {
        action: "model_open",
        sessionId,
        contextKey: "chat_id:c1",
      },
    });

    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith("om_model", expect.any(Object));
    const updated = (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(updated);
    expect(serialized).toContain('"content":"模型"');
    expect(serialized).toContain("当前模型");
    expect(serialized).toContain('"action":"model_select"');
    expect(serialized).not.toContain('"action":"model_open"');
    expect(serialized).not.toContain('"action":"reasoning_select"');
  });

  test("shows supported reasoning efforts as an interactive card and keeps direct changes compatible", async () => {
    const { controller, runtime, outbound, store } = fixture();
    await controller.onMessage(message("/new"));

    await controller.onMessage(message("/thinking"));
    expect(outbound.sendInteractiveCard).toHaveBeenCalled();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("当前思考模式");
    expect(serialized).toContain("high");
    expect(serialized).toContain("low");
    expect(serialized).not.toContain("Fast");
    expect(serialized).not.toContain("Deep");
    expect(serialized).toContain("<font color='blue'>Back</font>");
    expect(serialized).toContain('"action":"reasoning_select"');

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
    expect(serialized).toContain("Agent Bot");
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
    expect(card).toMatchObject({ header: { title: { content: "Agent Bot 使用帮助" } } });
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
    expect(serialized.match(/\/queue/g)).toHaveLength(1);
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
