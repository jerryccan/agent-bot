import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import { StartupNotifier } from "../../src/startup/StartupNotifier.js";
import { StateStore } from "../../src/state/StateStore.js";

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createStore(): StateStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-startup-"));
  directories.push(directory);
  const store = new StateStore(path.join(directory, "state.sqlite"));
  stores.push(store);
  return store;
}

function createOutbound(
  sendInteractiveCard: FeishuOutbound["sendInteractiveCard"],
  replyInteractiveCard?: FeishuOutbound["replyInteractiveCard"],
): FeishuOutbound {
  return {
    sendText: vi.fn(async () => "text"),
    sendMarkdown: vi.fn(async () => "markdown"),
    sendInteractiveCard,
    ...(replyInteractiveCard ? { replyInteractiveCard } : {}),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
}

function markActive(
  store: StateStore,
  contextKey: string,
  chatType: "p2p" | "group" = "p2p",
  activeAt = "2026-07-15T05:44:00.000Z",
): void {
  store.recordChatContext(contextKey, chatType);
  store.markChatActive(contextKey, new Date(activeAt));
}

const options = {
  agentBotVersion: "1.2.3",
  defaultAgentName: "codex",
  defaultAgentTitle: "Codex",
  cwd: "D:\\dev\\agent-bot",
  defaultUserOpenId: "ou_initializer",
};

describe("StartupNotifier", () => {
  test("sends startup cards to every private chat, recent groups, and all safe-restart groups", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:private", "codex");
    store.getOrCreateUserContext("chat_id:recent-group", "codex");
    store.getOrCreateUserContext("chat_id:boundary-group", "codex");
    store.getOrCreateUserContext("chat_id:stale-group", "codex");
    store.getOrCreateUserContext("chat_id:scheduled-group", "codex");
    store.getOrCreateUserContext("chat_id:topic-parent", "codex");
    store.getOrCreateUserContext("chat_id:group:thread_id:topic", "codex");
    store.getOrCreateUserContext("console:local", "codex");
    store.recordChatContext("chat_id:private", "p2p");
    markActive(store, "chat_id:recent-group", "group", "2026-07-15T05:44:59.000Z");
    markActive(store, "chat_id:boundary-group", "group", "2026-07-15T05:44:00.000Z");
    markActive(store, "chat_id:stale-group", "group", "2026-07-15T05:43:59.999Z");
    markActive(store, "chat_id:scheduled-group", "group", "2026-07-15T05:00:00.000Z");
    markActive(store, "chat_id:topic-parent", "group", "2026-07-15T05:44:59.000Z");
    markActive(store, "chat_id:group:thread_id:topic", "group", "2026-07-15T05:44:59.000Z");
    store.createSession({
      localSessionId: "sess_1",
      contextKey: "chat_id:private",
      agentName: "codex",
      cwd: "D:\\dev\\session-project",
      status: "running",
    });
    store.updateRuntimeSession("sess_1", {
      runtimeKind: "codex",
      remoteSessionId: "thread_1",
      title: "Current task title",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "confirm",
      lastTurnStatus: "running",
    });
    store.setCurrentSession("chat_id:private", "sess_1");
    const sendInteractiveCard = vi.fn(async (_contextKey: string, _card: Record<string, unknown>) => "om_startup");
    const replyInteractiveCard = vi.fn(async () => "om_topic_startup");
    const logger = { warn: vi.fn() };
    const notifier = new StartupNotifier(
      store,
      createOutbound(sendInteractiveCard, replyInteractiveCard),
      new CardRenderer(),
      logger,
      options,
    );

    await notifier.notify(
      new Date("2026-07-15T05:45:00.000Z"),
      "用户执行 /restart 命令",
      [
        { contextKey: "chat_id:scheduled-group" },
        {
          contextKey: "chat_id:topic-parent:thread_id:topic",
          replyMessageId: "om_topic_request",
        },
      ],
    );

    expect(sendInteractiveCard).toHaveBeenCalledTimes(4);
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:private", expect.any(Object));
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:recent-group", expect.any(Object));
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:boundary-group", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:stale-group", expect.any(Object));
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:scheduled-group", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:topic-parent", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith(
      "chat_id:topic-parent:thread_id:topic",
      expect.any(Object),
    );
    expect(replyInteractiveCard).toHaveBeenCalledOnce();
    expect(replyInteractiveCard).toHaveBeenCalledWith(
      "chat_id:topic-parent:thread_id:topic",
      { messageId: "om_topic_request", replyInThread: true },
      expect.any(Object),
    );
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:group:thread_id:topic", expect.any(Object));
    const privateCard = sendInteractiveCard.mock.calls.find(([contextKey]) => contextKey === "chat_id:private")?.[1];
    expect(privateCard).toMatchObject({
      schema: "2.0",
      header: { template: "green" },
      body: { elements: expect.any(Array) },
    });
    expect(JSON.stringify(privateCard)).toContain("thread_1");
    expect(JSON.stringify(privateCard)).not.toContain("sess_1");
    expect(JSON.stringify(privateCard)).toContain("Current task title");
    expect(JSON.stringify(privateCard)).toContain("1.2.3");
    expect(JSON.stringify(privateCard)).toContain("gpt-test");
    expect(JSON.stringify(privateCard)).toContain("high");
    expect(JSON.stringify(privateCard)).toContain("执行前确认");
    expect(JSON.stringify(privateCard)).toContain("用户执行 /restart 命令");
    expect(JSON.stringify(privateCard)).toContain("D:\\\\dev\\\\session-project");
    expect(JSON.stringify(privateCard)).not.toContain("未指定项目");
  });

  test("keeps a parent-group startup card when the parent also requested the restart", async () => {
    const store = createStore();
    markActive(store, "chat_id:parent", "group", "2026-07-15T05:44:59.000Z");
    store.getOrCreateUserContext("chat_id:parent", "codex");
    store.getOrCreateUserContext("chat_id:parent:thread_id:topic", "codex");
    const sendInteractiveCard = vi.fn(async () => "om_group_startup");
    const replyInteractiveCard = vi.fn(async () => "om_topic_startup");
    const notifier = new StartupNotifier(
      store,
      createOutbound(sendInteractiveCard, replyInteractiveCard),
      new CardRenderer(),
      { warn: vi.fn() },
      options,
    );

    await notifier.notify(
      new Date("2026-07-15T05:45:00.000Z"),
      "two requesters",
      [
        { contextKey: "chat_id:parent" },
        {
          contextKey: "chat_id:parent:thread_id:topic",
          replyMessageId: "om_topic_request",
        },
      ],
    );

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:parent", expect.any(Object));
    expect(replyInteractiveCard).toHaveBeenCalledOnce();
  });

  test("renders a current projectless task from the session workspace instead of the global default", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    markActive(store, "chat_id:c1");
    store.createSession({
      localSessionId: "sess_1",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: "C:\\Users\\Admin\\Documents\\Codex\\2026-07-24\\new-chat",
      status: "ready",
    });
    store.setCurrentSession("chat_id:c1", "sess_1");
    const sendInteractiveCard = vi.fn(async (_contextKey: string, _card: Record<string, unknown>) => "om_startup");
    const notifier = new StartupNotifier(
      store,
      createOutbound(sendInteractiveCard),
      new CardRenderer(),
      { warn: vi.fn() },
      options,
    );

    await notifier.notify(new Date("2026-07-15T05:45:00.000Z"), "Supervisor 启动");

    const serialized = JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1]);
    expect(serialized).toContain("未指定项目");
    expect(serialized).not.toContain("D:\\\\dev\\\\agent-bot");
  });

  test("continues startup delivery when legacy metadata hydration fails", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    markActive(store, "chat_id:c1");
    store.createSession({
      localSessionId: "sess_1",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: options.cwd,
      status: "ready",
    });
    store.updateRuntimeSession("sess_1", { runtimeKind: "codex", remoteSessionId: "thread_1" });
    store.setCurrentSession("chat_id:c1", "sess_1");
    const sendInteractiveCard = vi.fn(async () => "om_startup");
    const logger = { warn: vi.fn() };
    const hydrator = { hydrate: vi.fn(async () => { throw new Error("read failed"); }) };
    const notifier = new StartupNotifier(
      store,
      createOutbound(sendInteractiveCard),
      new CardRenderer(),
      logger,
      options,
      hydrator,
    );

    await expect(notifier.notify(
      new Date("2026-07-15T05:45:00.000Z"),
      "Supervisor 启动",
    )).resolves.toBeUndefined();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_1" }),
      "Failed to hydrate startup task metadata.",
    );
  });

  test("isolates a failed chat delivery and continues notifying other chats", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.getOrCreateUserContext("chat_id:c2", "codex");
    markActive(store, "chat_id:c1", "p2p");
    markActive(store, "chat_id:c2", "group");
    const sendInteractiveCard = vi.fn(async (contextKey: string, _card: Record<string, unknown>) => {
      if (contextKey === "chat_id:c1") throw new Error("delivery failed");
      return "om_startup";
    });
    const logger = { warn: vi.fn() };
    const notifier = new StartupNotifier(store, createOutbound(sendInteractiveCard), new CardRenderer(), logger, options);

    await expect(notifier.notify(
      new Date("2026-07-15T05:45:00.000Z"),
      "Supervisor 启动",
    )).resolves.toBeUndefined();

    expect(sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:c2", expect.any(Object));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contextKey: "chat_id:c1" }),
      "Failed to send startup status notification.",
    );
  });

  test("fails startup when every notification delivery fails", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.getOrCreateUserContext("chat_id:c2", "codex");
    markActive(store, "chat_id:c1", "p2p");
    markActive(store, "chat_id:c2", "group");
    const sendInteractiveCard = vi.fn(async () => { throw new Error("delivery failed"); });
    const notifier = new StartupNotifier(
      store,
      createOutbound(sendInteractiveCard),
      new CardRenderer(),
      { warn: vi.fn() },
      options,
    );

    await expect(notifier.notify(
      new Date("2026-07-15T05:45:00.000Z"),
      "Supervisor 启动",
    )).rejects.toThrow("Failed to send any startup status notification.");

    expect(sendInteractiveCard).toHaveBeenCalledTimes(2);
  });

  test("sends the first startup notification privately to the initializing user", async () => {
    const store = createStore();
    const sendInteractiveCard = vi.fn(async () => "om_startup");
    const notifier = new StartupNotifier(
      store,
      createOutbound(sendInteractiveCard),
      new CardRenderer(),
      { warn: vi.fn() },
      options,
    );

    await expect(notifier.notify(
      new Date("2026-07-15T05:45:00.000Z"),
      "首次启动",
    )).resolves.toBeUndefined();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("open_id:ou_initializer", expect.any(Object));
  });

  test("allows first startup when neither a known chat nor an initializing user is available", async () => {
    const store = createStore();
    const sendInteractiveCard = vi.fn(async () => "om_startup");
    const notifier = new StartupNotifier(
      store,
      createOutbound(sendInteractiveCard),
      new CardRenderer(),
      { warn: vi.fn() },
      {
        agentBotVersion: options.agentBotVersion,
        defaultAgentName: options.defaultAgentName,
        defaultAgentTitle: options.defaultAgentTitle,
        cwd: options.cwd,
      },
    );

    await expect(notifier.notify(
      new Date("2026-07-15T05:45:00.000Z"),
      "首次启动",
    )).resolves.toBeUndefined();

    expect(sendInteractiveCard).not.toHaveBeenCalled();
  });
});
