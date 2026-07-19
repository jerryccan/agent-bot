import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { StateStore } from "../../src/state/StateStore.js";

const tempDirectories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("StateStore runtime metadata", () => {
  test("lists all persisted user contexts in creation order", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.getOrCreateUserContext("console:local", "codex");

    expect(store.listUserContexts().map((context) => context.contextKey)).toEqual([
      "chat_id:c1",
      "console:local",
    ]);
  });

  test("persists the previous task and toggles it when the current task changes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);

    first.getOrCreateUserContext("chat_id:c1", "codex");
    first.setCurrentSession("chat_id:c1", "s1");
    first.setCurrentSession("chat_id:c1", "s2");
    expect(first.getOrCreateUserContext("chat_id:c1", "codex")).toMatchObject({
      currentSessionId: "s2",
      previousSessionId: "s1",
    });
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.getOrCreateUserContext("chat_id:c1", "codex")).toMatchObject({
      currentSessionId: "s2",
      previousSessionId: "s1",
    });
    second.setCurrentSession("chat_id:c1", "s1");
    expect(second.getOrCreateUserContext("chat_id:c1", "codex")).toMatchObject({
      currentSessionId: "s1",
      previousSessionId: "s2",
    });
  });

  test("allocates persistent fork title sequences by root title", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);

    expect(first.nextForkTitle("Inspect sessions")).toBe("Inspect sessions（分支 1）");
    expect(first.nextForkTitle("Inspect sessions（分支 1）")).toBe("Inspect sessions（分支 2）");
    expect(first.nextForkTitle("Another task")).toBe("Another task（分支 1）");
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.nextForkTitle("Inspect sessions")).toBe("Inspect sessions（分支 3）");
  });

  test("persists Codex thread settings", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.createSession({
      localSessionId: "s1",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });

    store.updateRuntimeSession("s1", {
      runtimeKind: "codex",
      remoteSessionId: "thr_1",
      title: "Show startup metadata",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });

    expect(store.getSession("s1")).toMatchObject({
      runtimeKind: "codex",
      remoteSessionId: "thr_1",
      title: "Show startup metadata",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    expect(store.findSessionByRemoteSessionId("thr_1", "chat_id:c1")?.localSessionId).toBe("s1");
    expect(store.findSessionByRemoteSessionId("thr_1", "chat_id:other")).toBeUndefined();
  });

  test("reports global task and delivery activity for CLI management", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.createSession({
      localSessionId: "running",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "running",
    });
    store.createSession({
      localSessionId: "waiting-delivery",
      contextKey: "chat_id:c2",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.updateRuntimeSession("waiting-delivery", { lastTurnId: "turn_2", lastTurnStatus: "completed" });
    store.saveTurnSnapshot("turn_2", "waiting-delivery", {
      status: "completed",
      finalResponse: "done",
    });
    store.saveTurnDelivery("turn_2", { progressMessageId: "om_progress" });
    store.claimInboundEvent("message_1", "message");

    expect(store.listAllSessions().map((session) => session.localSessionId)).toEqual(
      expect.arrayContaining(["running", "waiting-delivery"]),
    );
    expect(store.getServerActivityState()).toMatchObject({
      runningSessions: 1,
      pendingFinalDeliveries: 1,
      latestInboundAt: expect.any(String),
    });
  });

  test("stores bounded turn snapshots and final delivery state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.saveTurnSnapshot("turn_1", "s1", { status: "completed", summary: "done" });
    store.saveTurnDelivery("turn_1", { progressMessageId: "om_progress" });
    store.saveFinalDeliveryProgress("turn_1", ["om_part_1"]);
    store.markFinalDelivered("turn_1", ["om_final"]);

    expect(store.getTurnSnapshot("turn_1")).toEqual({ status: "completed", summary: "done" });
    expect(store.getTurnDelivery("turn_1")).toMatchObject({
      progressMessageId: "om_progress",
      finalMessageIds: ["om_final"],
      finalDelivered: true,
    });
  });

  test("resolves fork anchors from inbound, progress, and final message ids", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.bindMessageToTurn("om_user", "session_1", "turn_1");
    store.saveTurnSnapshot("turn_1", "session_1", { status: "completed" });
    store.saveTurnDelivery("turn_1", { progressMessageId: "om_progress" });
    store.markFinalDelivered("turn_1", ["om_final_1", "om_final_2"]);

    expect(store.findTurnAnchorByMessageId("om_user")).toEqual({
      turnId: "turn_1",
      localSessionId: "session_1",
    });
    expect(store.findTurnAnchorByMessageId("om_progress")).toEqual({
      turnId: "turn_1",
      localSessionId: "session_1",
    });
    expect(store.findTurnAnchorByMessageId("om_final_2")).toEqual({
      turnId: "turn_1",
      localSessionId: "session_1",
    });
    expect(store.findTurnAnchorByMessageId("om_unknown")).toBeUndefined();
  });

  test("reconciles ACP turns left running by a previous process", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.createSession({
      localSessionId: "acp_stale",
      contextKey: "chat_id:c1",
      agentName: "coco-yolo",
      cwd: process.cwd(),
      status: "running",
    });
    store.updateRuntimeSession("acp_stale", {
      runtimeKind: "acp",
      remoteSessionId: "remote_acp",
      lastTurnId: "turn_stale",
      lastTurnStatus: "running",
    });
    store.saveTurnSnapshot("turn_stale", "acp_stale", {
      sessionId: "acp_stale",
      turnId: "turn_stale",
      status: "tool_running",
      startedAt: Date.now() - 1_000,
      activeTool: { id: "tool", title: "bash", status: "running" },
    });

    expect(store.reconcileInterruptedAcpSessions(["coco-yolo"])).toHaveLength(1);
    expect(store.getSession("acp_stale")).toMatchObject({ status: "failed", lastTurnStatus: "failed" });
    expect(store.getTurnSnapshot("turn_stale")).toMatchObject({
      status: "failed",
      error: "acp-bot 已重启，原 ACP 进程中的执行无法继续。",
    });
    expect(store.getTurnSnapshot("turn_stale")).not.toHaveProperty("activeTool");
  });

  test("claims an inbound event only once across store restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);
    expect(first.claimInboundEvent("event_1", "message")).toBe(true);
    expect(first.claimInboundEvent("event_1", "message")).toBe(false);
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.claimInboundEvent("event_1", "message")).toBe(false);
  });

  test("persists and atomically claims message reactions bound to a turn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);
    first.saveMessageReaction("om_1", "chat_id:c1", "reaction_on_it", "OnIt");
    first.bindMessageToTurn("om_1", "session_1", "turn_1");
    first.bindMessageReaction("om_1", "session_1", "turn_1");
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.listPendingMessageReactions()).toEqual([
      expect.objectContaining({
        messageId: "om_1",
        localSessionId: "session_1",
        turnId: "turn_1",
        emojiType: "OnIt",
        status: "pending",
      }),
    ]);
    expect(second.findTurnAnchorByMessageId("om_1")).toEqual({
      localSessionId: "session_1",
      turnId: "turn_1",
    });
    expect(second.claimMessageReactionsForTurn("turn_1")).toEqual([
      expect.objectContaining({ messageId: "om_1", status: "updating" }),
    ]);
    expect(second.claimMessageReactionsForTurn("turn_1")).toEqual([]);
    second.finishMessageReaction("om_1", "reaction_done", "DONE", "completed");
    expect(second.getMessageReaction("om_1")).toMatchObject({
      reactionId: "reaction_done",
      emojiType: "DONE",
      status: "completed",
    });
  });

  test("retries a reaction replacement interrupted by process restart", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);
    first.saveMessageReaction("om_restart", "chat_id:c1", "reaction_on_it", "OnIt");
    first.bindMessageReaction("om_restart", "session_1", "turn_1");
    expect(first.claimMessageReactionsForTurn("turn_1")).toHaveLength(1);
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.getMessageReaction("om_restart")?.status).toBe("pending");
    expect(second.claimMessageReactionsForTurn("turn_1")).toHaveLength(1);
  });
});
