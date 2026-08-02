import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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

  test("persists a project binding on a taskless chat context", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const projectCwd = path.join(directory, "project");
    const first = new StateStore(dbPath);
    stores.push(first);

    first.getOrCreateUserContext("chat_id:new_group", "codex");
    first.setBoundProjectCwd("chat_id:new_group", projectCwd);
    expect(first.getUserContext("chat_id:new_group")).toMatchObject({
      currentSessionId: undefined,
      boundProjectCwd: projectCwd,
    });
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.getUserContext("chat_id:new_group")?.boundProjectCwd).toBe(projectCwd);
  });

  test("persists Feishu chat types independently from task contexts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.recordChatContext("chat_id:private", "p2p");
    store.recordChatContext("chat_id:group", "group");
    store.markChatActive("chat_id:private", new Date("2026-07-20T12:00:00.000Z"));

    expect(store.listChatContexts("p2p")).toMatchObject([
      { contextKey: "chat_id:private", chatType: "p2p" },
    ]);
    expect(store.listChatContexts("group")).toMatchObject([
      { contextKey: "chat_id:group", chatType: "group" },
    ]);
    expect(store.listRecentlyActiveChatContexts(new Date("2026-07-20T00:00:00.000Z"))).toMatchObject([
      { contextKey: "chat_id:private", chatType: "p2p", lastActivityAt: "2026-07-20T12:00:00.000Z" },
    ]);
  });

  test("adds activity tracking to an existing chat context table", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE chat_contexts (
        context_key TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO chat_contexts VALUES (
        'chat_id:private', 'p2p',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = new StateStore(dbPath);
    stores.push(store);
    store.markChatActive("chat_id:private", new Date("2026-07-20T12:00:00.000Z"));

    expect(store.listRecentlyActiveChatContexts(new Date("2026-07-20T00:00:00.000Z"))).toMatchObject([
      { contextKey: "chat_id:private", lastActivityAt: "2026-07-20T12:00:00.000Z" },
    ]);
  });

  test("persists the previous task and toggles it when the current task changes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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

  test("persists queued prompts in FIFO order and cancels individual entries", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-queue-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);

    first.enqueuePrompt({
      promptId: "prompt_1",
      localSessionId: "session_1",
      contextKey: "chat_id:c1",
      text: "first",
      messageId: "message_1",
    });
    first.enqueuePrompt({
      promptId: "prompt_2",
      localSessionId: "session_1",
      contextKey: "chat_id:c1",
      text: "second",
      localImagePaths: ["D:\\images\\one.png"],
      replyMessageId: "reply_2",
    });
    first.enqueuePrompt({
      promptId: "prompt_other",
      localSessionId: "session_2",
      contextKey: "chat_id:c2",
      text: "other",
    });

    expect(first.listQueuedPromptSessionIds()).toEqual(["session_1", "session_2"]);
    expect(first.countQueuedPrompts("session_1")).toBe(2);
    expect(first.listQueuedPrompts("session_1").map((prompt) => prompt.promptId)).toEqual([
      "prompt_1",
      "prompt_2",
    ]);
    expect(first.cancelQueuedPrompt("prompt_1", "session_2")).toBeUndefined();
    expect(first.cancelQueuedPrompt("prompt_1", "session_1")).toMatchObject({
      text: "first",
      messageId: "message_1",
    });
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.takeNextQueuedPrompt("session_1")).toMatchObject({
      promptId: "prompt_2",
      localImagePaths: ["D:\\images\\one.png"],
      replyMessageId: "reply_2",
    });
    expect(second.countQueuedPrompts("session_1")).toBe(0);
    expect(second.takeNextQueuedPrompt("session_1")).toBeUndefined();
  });

  test("persists Codex thread settings", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });

    expect(store.getSession("s1")).toMatchObject({
      runtimeKind: "codex",
      remoteSessionId: "thr_1",
      title: "Show startup metadata",
      modelProvider: "azure",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    expect(store.findSessionByRemoteSessionId("thr_1", "chat_id:c1")?.localSessionId).toBe("s1");
    expect(store.findSessionByRemoteSessionId("thr_1", "chat_id:other")).toBeUndefined();
  });

  test("allows different Agents to persist the same remote task id without merging", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    for (const [localSessionId, agentName] of [["codex_task", "codex"], ["traex_task", "traex"]] as const) {
      store.createSession({
        localSessionId,
        contextKey: "chat_id:c1",
        agentName,
        cwd: process.cwd(),
        status: "ready",
      });
      store.updateRuntimeSession(localSessionId, {
        runtimeKind: "codex",
        remoteSessionId: "shared_remote",
      });
    }

    expect(store.findSessionByRemoteSessionId("shared_remote", undefined, "codex")?.localSessionId)
      .toBe("codex_task");
    expect(store.findSessionByRemoteSessionId("shared_remote", undefined, "traex")?.localSessionId)
      .toBe("traex_task");
    expect(store.listAllSessions().filter((session) => session.remoteSessionId === "shared_remote"))
      .toHaveLength(2);
  });

  test("migrates duplicate remote tasks into one canonical task with multiple context links", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE user_contexts (
        context_key TEXT PRIMARY KEY,
        default_agent TEXT NOT NULL,
        current_session_id TEXT,
        previous_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        local_session_id TEXT PRIMARY KEY,
        context_key TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        acp_session_id TEXT,
        runtime_kind TEXT,
        remote_session_id TEXT,
        title TEXT,
        model TEXT,
        reasoning_effort TEXT,
        permission_mode TEXT,
        last_turn_id TEXT,
        last_turn_status TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE turn_snapshots (
        turn_id TEXT PRIMARY KEY,
        local_session_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions VALUES
        ('canonical', 'chat_id:first', 'codex', 'D:\\work', NULL, 'codex', 'shared_remote', 'Shared', 'gpt', 'high', 'auto', 'turn_old', 'cancelled', 'ready', '2026-07-17T00:00:00.000Z', '2026-07-17T01:00:00.000Z'),
        ('duplicate', 'chat_id:second', 'codex', 'D:\\work', NULL, 'codex', 'shared_remote', 'Shared', 'gpt', 'xhigh', 'auto', 'turn_new', 'failed', 'failed', '2026-07-18T00:00:00.000Z', '2026-07-18T01:00:00.000Z');
      INSERT INTO user_contexts VALUES
        ('chat_id:first', 'codex', 'canonical', NULL, '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z'),
        ('chat_id:second', 'codex', 'duplicate', NULL, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
      INSERT INTO turn_snapshots VALUES
        ('turn_old', 'canonical', '{"sessionId":"canonical","turnId":"turn_old","status":"cancelled"}', '2026-07-17T01:00:00.000Z'),
        ('turn_new', 'duplicate', '{"sessionId":"duplicate","turnId":"turn_new","status":"failed"}', '2026-07-18T01:00:00.000Z');
    `);
    legacy.close();

    const store = new StateStore(dbPath);
    stores.push(store);

    expect(store.listAllSessions().filter((session) => session.remoteSessionId === "shared_remote"))
      .toHaveLength(1);
    expect(store.getSession("canonical")).toMatchObject({
      remoteSessionId: "shared_remote",
      lastTurnId: "turn_new",
      lastTurnStatus: "failed",
      status: "failed",
      reasoningEffort: "xhigh",
    });
    expect(store.getSession("duplicate")).toBeUndefined();
    expect(store.getUserContext("chat_id:second")?.currentSessionId).toBe("canonical");
    expect(store.getSessionForContext("canonical", "chat_id:first")).toBeDefined();
    expect(store.getSessionForContext("canonical", "chat_id:second")).toBeDefined();
    expect(store.getTurnSnapshot("turn_new")).toMatchObject({ sessionId: "canonical", status: "failed" });
    expect(store.getTurnContextKey("turn_old")).toBe("chat_id:first");
    expect(store.getTurnContextKey("turn_new")).toBe("chat_id:second");

    store.createSession({
      localSessionId: "another",
      contextKey: "chat_id:third",
      agentName: "codex",
      cwd: "D:\\work",
      status: "ready",
    });
    expect(() => store.updateRuntimeSession("another", { remoteSessionId: "shared_remote" })).toThrow();
  });

  test("reports global task and delivery activity for CLI management", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
    store.createSession({
      localSessionId: "queued",
      contextKey: "chat_id:c3",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });
    store.enqueuePrompt({
      promptId: "queued_prompt",
      localSessionId: "queued",
      contextKey: "chat_id:c3",
      text: "run after restart blocker",
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
      runningSessions: 2,
      pendingFinalDeliveries: 1,
      latestInboundAt: expect.any(String),
    });
  });

  test("stores bounded turn snapshots and final delivery state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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

  test("finds the latest completed turn owned by a session in one context", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.saveTurnSnapshot("turn_anchor", "source", {
      status: "completed",
      completedAt: 500,
    }, "chat_id:c1");
    store.saveTurnSnapshot("turn_topic_running", "topic", {
      status: "running",
      startedAt: 600,
    }, "chat_id:c1:thread_id:t1");
    store.saveTurnSnapshot("turn_topic_old", "topic", {
      status: "completed",
      completedAt: 200,
    }, "chat_id:c1:thread_id:t1");
    store.saveTurnSnapshot("turn_topic_latest", "topic", {
      status: "completed",
      completedAt: 400,
    }, "chat_id:c1:thread_id:t1");
    store.saveTurnSnapshot("turn_other_topic", "topic", {
      status: "completed",
      completedAt: 700,
    }, "chat_id:c1:thread_id:t2");

    expect(store.findLatestCompletedTurnId("topic", "chat_id:c1:thread_id:t1"))
      .toBe("turn_topic_latest");
    expect(store.findLatestCompletedTurnId("source", "chat_id:c1:thread_id:t1"))
      .toBeUndefined();
  });

  test("atomically promotes a pending turn snapshot and progress delivery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.saveTurnSnapshot("pending_1", "s1", { turnId: "pending_1", status: "starting" }, "chat_id:c1");
    store.saveTurnDelivery("pending_1", { progressMessageId: "om_progress" });
    store.promotePendingTurn(
      "pending_1",
      "turn_1",
      "s1",
      { turnId: "turn_1", status: "running" },
      "chat_id:c1",
    );

    expect(store.getTurnSnapshot("pending_1")).toBeUndefined();
    expect(store.getTurnDelivery("pending_1")).toBeUndefined();
    expect(store.getTurnSnapshot("turn_1")).toEqual({ turnId: "turn_1", status: "running" });
    expect(store.getTurnDelivery("turn_1")).toMatchObject({
      progressMessageId: "om_progress",
      finalDelivered: false,
    });
  });

  test("resolves fork anchors from inbound, progress, and final message ids", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
      error: "Agent Bot 已重启，原 ACP 进程中的执行无法继续。",
    });
    expect(store.getTurnSnapshot("turn_stale")).not.toHaveProperty("activeTool");
  });

  test("claims an inbound event only once across store restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
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
