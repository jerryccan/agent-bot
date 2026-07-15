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

const options = {
  defaultAgentName: "codex",
  defaultAgentTitle: "Codex",
  cwd: "D:\\dev\\acp-bot",
};

describe("StartupNotifier", () => {
  test("sends one session-aware card to each persisted Feishu chat and skips console contexts", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.getOrCreateUserContext("console:local", "codex");
    store.createSession({
      localSessionId: "sess_1",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: options.cwd,
      status: "running",
    });
    store.updateRuntimeSession("sess_1", { runtimeKind: "codex", remoteSessionId: "thread_1", lastTurnStatus: "running" });
    store.setCurrentSession("chat_id:c1", "sess_1");
    const sendInteractiveCard = vi.fn(async () => "om_startup");
    const logger = { warn: vi.fn() };
    const notifier = new StartupNotifier(store, createOutbound(sendInteractiveCard), new CardRenderer(), logger, options);

    await notifier.notify(new Date("2026-07-15T05:45:00.000Z"));

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:c1", expect.any(Object));
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("sess_1");
  });

  test("isolates a failed chat delivery and continues notifying other chats", async () => {
    const store = createStore();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.getOrCreateUserContext("chat_id:c2", "codex");
    const sendInteractiveCard = vi.fn(async (contextKey: string) => {
      if (contextKey === "chat_id:c1") throw new Error("delivery failed");
      return "om_startup";
    });
    const logger = { warn: vi.fn() };
    const notifier = new StartupNotifier(store, createOutbound(sendInteractiveCard), new CardRenderer(), logger, options);

    await expect(notifier.notify(new Date("2026-07-15T05:45:00.000Z"))).resolves.toBeUndefined();

    expect(sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:c2", expect.any(Object));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contextKey: "chat_id:c1" }),
      "Failed to send startup status notification.",
    );
  });
});
