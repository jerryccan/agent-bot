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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-startup-"));
  directories.push(directory);
  const store = new StateStore(path.join(directory, "state.sqlite"));
  stores.push(store);
  return store;
}

function createOutbound(sendInteractiveCard: FeishuOutbound["sendInteractiveCard"]): FeishuOutbound {
  return {
    sendText: vi.fn(async () => "text"),
    sendMarkdown: vi.fn(async () => "markdown"),
    sendInteractiveCard,
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
  defaultAgentName: "codex",
  defaultAgentTitle: "Codex",
  cwd: "D:\\dev\\acp-bot",
};

describe("StartupNotifier", () => {
  test("sends startup cards to every private chat and only groups active in the previous three minutes", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:private", "codex");
    store.getOrCreateUserContext("chat_id:recent-group", "codex");
    store.getOrCreateUserContext("chat_id:boundary-group", "codex");
    store.getOrCreateUserContext("chat_id:stale-group", "codex");
    store.getOrCreateUserContext("console:local", "codex");
    store.recordChatContext("chat_id:private", "p2p");
    markActive(store, "chat_id:recent-group", "group", "2026-07-15T05:44:59.000Z");
    markActive(store, "chat_id:boundary-group", "group", "2026-07-15T05:42:00.000Z");
    markActive(store, "chat_id:stale-group", "group", "2026-07-15T05:41:59.999Z");
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
    const logger = { warn: vi.fn() };
    const notifier = new StartupNotifier(store, createOutbound(sendInteractiveCard), new CardRenderer(), logger, options);

    await notifier.notify(new Date("2026-07-15T05:45:00.000Z"), "用户执行 /restart 命令");

    expect(sendInteractiveCard).toHaveBeenCalledTimes(3);
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:private", expect.any(Object));
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:recent-group", expect.any(Object));
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:boundary-group", expect.any(Object));
    expect(sendInteractiveCard).not.toHaveBeenCalledWith("chat_id:stale-group", expect.any(Object));
    const privateCard = sendInteractiveCard.mock.calls.find(([contextKey]) => contextKey === "chat_id:private")?.[1];
    expect(privateCard).toMatchObject({
      schema: "2.0",
      header: { template: "green" },
      body: { elements: expect.any(Array) },
    });
    expect(JSON.stringify(privateCard)).toContain("thread_1");
    expect(JSON.stringify(privateCard)).not.toContain("sess_1");
    expect(JSON.stringify(privateCard)).toContain("Current task title");
    expect(JSON.stringify(privateCard)).toContain("gpt-test");
    expect(JSON.stringify(privateCard)).toContain("high");
    expect(JSON.stringify(privateCard)).toContain("执行前确认");
    expect(JSON.stringify(privateCard)).toContain("用户执行 /restart 命令");
    expect(JSON.stringify(privateCard)).toContain("D:\\\\dev\\\\session-project");
    expect(JSON.stringify(privateCard)).not.toContain("未指定项目");
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
    expect(serialized).not.toContain("D:\\\\dev\\\\acp-bot");
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
});
