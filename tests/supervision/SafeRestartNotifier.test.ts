import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import { StateStore } from "../../src/state/StateStore.js";
import { SafeRestartNotifier } from "../../src/supervision/SafeRestartNotifier.js";

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SafeRestartNotifier", () => {
  test("sends and updates one card only in persisted private chats", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-notifier-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    store.recordChatContext("chat_id:group", "group");
    store.createSession({
      localSessionId: "session_1",
      contextKey: "chat_id:group",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("session_1", { remoteSessionId: "thread_1", title: "Running build" });
    const sendInteractiveCard = vi.fn(async (_contextKey: string, _card: Record<string, unknown>) => "om_restart");
    const updateInteractiveCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => undefined);
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard,
      updateInteractiveCard,
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    notifier.update({
      scheduleId: 1,
      reason: "new build",
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(sendInteractiveCard).toHaveBeenCalledWith("chat_id:private", expect.any(Object));
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("Running build");
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("thread_1");

    store.updateSession("session_1", { status: "ready" });
    notifier.update({
      scheduleId: 1,
      reason: "new build",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 9_500,
    });
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(updateInteractiveCard).toHaveBeenCalledWith("om_restart", expect.any(Object));
    expect(JSON.stringify(updateInteractiveCard.mock.calls.at(-1)?.[1])).toContain("10s");

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 9_100,
    });
    expect(updateInteractiveCard).toHaveBeenCalledOnce();

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 8_900,
    });
    expect(updateInteractiveCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateInteractiveCard.mock.calls.at(-1)?.[1])).toContain("9s");
  });

  test("serializes changed countdown cards instead of coalescing intermediate updates", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-countdown-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");

    let releaseFirstUpdate: (() => void) | undefined;
    const updateInteractiveCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => {
      if (updateInteractiveCard.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstUpdate = resolve;
        });
      }
    });
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard: vi.fn(async () => "om_restart"),
      updateInteractiveCard,
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "countdown",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 15_000,
    });
    const first = notifier.update({
      scheduleId: 1,
      reason: "countdown",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 14_000,
    });
    await vi.waitFor(() => expect(updateInteractiveCard).toHaveBeenCalledOnce());
    const second = notifier.update({
      scheduleId: 1,
      reason: "countdown",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 13_000,
    });

    expect(updateInteractiveCard).toHaveBeenCalledOnce();
    releaseFirstUpdate?.();
    await Promise.all([first, second]);

    expect(updateInteractiveCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateInteractiveCard.mock.calls[0]?.[1])).toContain("14s");
    expect(JSON.stringify(updateInteractiveCard.mock.calls[1]?.[1])).toContain("13s");
  });

  test("delays the initial card and publishes the latest status received during the delay", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-delay-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    const sendInteractiveCard = vi.fn(async (
      _contextKey: string,
      _card: Record<string, unknown>,
    ) => "om_restart");
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard,
      updateInteractiveCard: vi.fn(async () => undefined),
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 3_000 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 12_000,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sendInteractiveCard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain("12s");
  });

  test("flushes a delayed initial card immediately before restart", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-delay-flush-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    const sendInteractiveCard = vi.fn(async (
      _contextKey: string,
      _card: Record<string, unknown>,
    ) => "om_restart");
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard,
      updateInteractiveCard: vi.fn(async () => undefined),
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 3_000 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "new build",
      phase: "restarting",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 0,
    });
    await notifier.flush();

    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendInteractiveCard).toHaveBeenCalledOnce();
  });

  test("updates the existing card after cancellation and ignores late status updates", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-cancel-"));
    directories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.recordChatContext("chat_id:private", "p2p");
    const updateInteractiveCard = vi.fn(async (
      _messageId: string,
      _card: Record<string, unknown>,
    ) => undefined);
    const outbound: FeishuOutbound = {
      sendText: vi.fn(async () => "text"),
      sendMarkdown: vi.fn(async () => "markdown"),
      sendInteractiveCard: vi.fn(async () => "om_restart"),
      updateInteractiveCard,
    };
    const notifier = new SafeRestartNotifier(
      store,
      outbound,
      new CardRenderer(),
      { warn: vi.fn() },
      { initialCardDelayMs: 0 },
    );

    await notifier.update({
      scheduleId: 1,
      reason: "cancel this",
      phase: "waiting_tasks",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });
    await notifier.update({
      scheduleId: 1,
      reason: "cancel this",
      phase: "cancelled",
      activity: { runningSessions: 1, pendingFinalDeliveries: 0 },
    });

    expect(updateInteractiveCard).toHaveBeenCalledOnce();
    const cancelledCard = updateInteractiveCard.mock.calls[0]?.[1];
    expect(JSON.stringify(cancelledCard)).toContain("已取消");
    expect(JSON.stringify(cancelledCard)).not.toContain(">Cancel</font>");

    await notifier.update({
      scheduleId: 1,
      reason: "cancel this",
      phase: "countdown",
      activity: { runningSessions: 0, pendingFinalDeliveries: 0 },
      remainingMs: 5_000,
    });
    expect(updateInteractiveCard).toHaveBeenCalledOnce();
  });
});
