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
  test("persists Goal card deliveries across store restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);

    first.saveGoalCardDelivery("session-1", "chat_id:c1", "message-1");
    first.saveGoalCardDelivery("session-1", "chat_id:c2", "message-2");
    expect(first.getGoalCardDelivery("session-1", "chat_id:c1")).toMatchObject({
      localSessionId: "session-1",
      contextKey: "chat_id:c1",
      messageId: "message-1",
    });
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.listGoalCardDeliveries("session-1")).toMatchObject([
      { contextKey: "chat_id:c1", messageId: "message-1" },
      { contextKey: "chat_id:c2", messageId: "message-2" },
    ]);
  });

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

  test("persists the group mention requirement across store restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);

    first.recordChatContext("chat_id:group", "group");
    first.setChatRequiresMention("chat_id:group", true);
    expect(first.chatRequiresMention("chat_id:group")).toBe(true);
    expect(first.getChatContext("chat_id:group")).toMatchObject({
      chatType: "group",
      requiresMention: true,
    });
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.chatRequiresMention("chat_id:group")).toBe(true);
    second.setChatRequiresMention("chat_id:group", false);
    expect(second.chatRequiresMention("chat_id:group")).toBe(false);
  });

  test("removes a dissolved group and all of its topic bindings", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    const group = "chat_id:oc_group_with_underscore";
    const topic = `${group}:thread_id:omt_topic`;

    store.recordChatContext(group, "group");
    store.getOrCreateUserContext(group, "codex");
    store.getOrCreateUserContext(topic, "codex");
    store.createSession({
      localSessionId: "group_task",
      contextKey: group,
      agentName: "codex",
      cwd: directory,
      status: "ready",
    });
    store.createSession({
      localSessionId: "topic_task",
      contextKey: topic,
      agentName: "codex",
      cwd: directory,
      status: "ready",
    });
    store.recordChatContext("chat_id:oc_other", "group");

    expect(store.removeChatContext(group).sort()).toEqual(["group_task", "topic_task"]);

    expect(store.getChatContext(group)).toBeUndefined();
    expect(store.getUserContext(group)).toBeUndefined();
    expect(store.getUserContext(topic)).toBeUndefined();
    expect(store.listSessions(group)).toEqual([]);
    expect(store.listSessions(topic)).toEqual([]);
    expect(store.getChatContext("chat_id:oc_other")).toBeDefined();
    expect(store.getSession("group_task")).toBeDefined();
    expect(store.getSession("topic_task")).toBeDefined();
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
      {
        contextKey: "chat_id:private",
        requiresMention: false,
        lastActivityAt: "2026-07-20T12:00:00.000Z",
      },
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

  test("archives a task and clears every current or previous context reference", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.getOrCreateUserContext("chat_id:first", "codex");
    store.getOrCreateUserContext("chat_id:second", "codex");
    store.createSession({
      localSessionId: "archived",
      contextKey: "chat_id:first",
      agentName: "codex",
      cwd: directory,
      status: "ready",
    });
    store.createSession({
      localSessionId: "remaining",
      contextKey: "chat_id:second",
      agentName: "codex",
      cwd: directory,
      status: "ready",
    });
    store.setCurrentSession("chat_id:first", "archived");
    store.attachSessionToContext("chat_id:second", "archived");
    store.setCurrentSession("chat_id:second", "archived");
    store.setCurrentSession("chat_id:second", "remaining");

    store.archiveSession("archived");

    expect(store.getSession("archived")?.status).toBe("closed");
    expect(store.getUserContext("chat_id:first")?.currentSessionId).toBeUndefined();
    expect(store.getUserContext("chat_id:second")).toMatchObject({
      currentSessionId: "remaining",
      previousSessionId: undefined,
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
      displayPrompt: "Second display title",
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
      displayPrompt: "Second display title",
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

  test("keeps the first App Server thread origin recorded for a turn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);

    first.saveTurnRuntimeOrigin("turn_1", "session_1", "codex", "thread_original");
    first.saveTurnRuntimeOrigin("turn_1", "session_1", "codex", "thread_rebound");
    expect(first.getTurnRuntimeOrigin("turn_1")).toMatchObject({
      turnId: "turn_1",
      localSessionId: "session_1",
      agentName: "codex",
      remoteSessionId: "thread_original",
    });

    first.close();
    stores.pop();
    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.getTurnRuntimeOrigin("turn_1")?.remoteSessionId).toBe("thread_original");
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

  test("pages completed turn snapshots by completion time within one task context", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    for (let index = 1; index <= 12; index += 1) {
      store.saveTurnSnapshot(`turn_${index}`, "session_1", {
        turnId: `turn_${index}`,
        status: "completed",
        completedAt: index * 1_000,
      }, "chat_id:c1");
    }
    store.saveTurnSnapshot("turn_running", "session_1", {
      turnId: "turn_running",
      status: "running",
      startedAt: 99_000,
    }, "chat_id:c1");
    store.saveTurnSnapshot("turn_other_context", "session_1", {
      turnId: "turn_other_context",
      status: "completed",
      completedAt: 100_000,
    }, "chat_id:c2");

    expect(store.countCompletedTurnSnapshots("session_1", "chat_id:c1")).toBe(12);
    expect(store.listCompletedTurnSnapshots("session_1", "chat_id:c1", 10).map((turn) => turn.turnId))
      .toEqual(["turn_12", "turn_11", "turn_10", "turn_9", "turn_8", "turn_7", "turn_6", "turn_5", "turn_4", "turn_3"]);
    expect(store.listCompletedTurnSnapshots("session_1", "chat_id:c1", 10, 10).map((turn) => turn.turnId))
      .toEqual(["turn_2", "turn_1"]);
  });

  test("backfills Reset branches with their selected parent turn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    const now = Date.now();
    const saveCompleted = (turnId: string, startedAt: number) => store.saveTurnSnapshot(turnId, "session_1", {
      turnId,
      status: "completed",
      startedAt,
      completedAt: startedAt + 100,
    }, "chat_id:c1");

    saveCompleted("turn_8", now - 4_000);
    saveCompleted("turn_7", now - 3_000);
    saveCompleted("turn_6", now - 2_000);
    store.audit("chat_id:c1", "session_reset_to_turn", {
      localSessionId: "session_1",
      resetTurnId: "turn_8",
      forkedRemoteSessionId: "thread_reset",
    });
    store.saveTurnParent("turn_5", "session_1");
    saveCompleted("turn_5", now + 1_000);

    expect(store.listCompletedTurnGraph("session_1", "chat_id:c1").map((turn) => ({
      turnId: turn.turnId,
      parentTurnId: turn.parentTurnId,
    }))).toEqual([
      { turnId: "turn_5", parentTurnId: "turn_8" },
      { turnId: "turn_6", parentTurnId: "turn_7" },
      { turnId: "turn_7", parentTurnId: "turn_8" },
      { turnId: "turn_8", parentTurnId: undefined },
    ]);
  });

  test("repairs a missing parent recorded before crash recovery completed", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.saveTurnSnapshot("turn_6", "session_1", {
      turnId: "turn_6",
      status: "completed",
      startedAt: 1_000,
      completedAt: 2_000,
    }, "chat_id:c1");
    store.saveTurnParent("turn_6", "session_1");
    store.saveTurnParent("turn_5", "session_1");
    store.saveTurnSnapshot("turn_5", "session_1", {
      turnId: "turn_5",
      status: "completed",
      startedAt: 3_000,
      completedAt: 4_000,
    }, "chat_id:c1");

    const graph = () => store.listCompletedTurnGraph("session_1", "chat_id:c1").map((turn) => ({
      turnId: turn.turnId,
      parentTurnId: turn.parentTurnId,
    }));
    expect(graph()).toEqual([
      { turnId: "turn_5", parentTurnId: "turn_6" },
      { turnId: "turn_6", parentTurnId: undefined },
    ]);

    store.saveTurnParent("turn_5", "session_1", "turn_other");
    expect(graph()[0]).toEqual({ turnId: "turn_5", parentTurnId: "turn_6" });
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
    expect(store.findAgentBotTurnMessageById("om_user")).toBeUndefined();
    expect(store.findAgentBotTurnMessageById("om_progress")).toEqual({
      turnId: "turn_1",
      localSessionId: "session_1",
      messageKind: "progress",
    });
    expect(store.findAgentBotTurnMessageById("om_final_2")).toEqual({
      turnId: "turn_1",
      localSessionId: "session_1",
      messageKind: "final",
    });
  });

  test("persists unfinished turn attempts and rolls the same attempt forward for recovery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);
    first.createTurnAttempt({
      attemptId: "attempt_1",
      localSessionId: "session_1",
      contextKey: "chat_id:c1:thread_id:t1",
      promptText: "finish the task",
      localImagePaths: ["D:\\images\\input.png"],
      messageId: "om_user",
      replyMessageId: "om_topic",
      pendingTurnId: "pending_1",
      retryCount: 2,
    });
    first.updateTurnAttempt("attempt_1", { turnId: "turn_1", pendingTurnId: null, status: "running" });
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.listIncompleteTurnAttempts()).toEqual([
      expect.objectContaining({
        attemptId: "attempt_1",
        promptText: "finish the task",
        localImagePaths: ["D:\\images\\input.png"],
        messageId: "om_user",
        replyMessageId: "om_topic",
        turnId: "turn_1",
        retryCount: 2,
        status: "running",
      }),
    ]);

    second.prepareTurnAttemptRecovery("attempt_1", "turn_1");
    expect(second.getTurnAttempt("attempt_1")).toMatchObject({
      turnId: undefined,
      pendingTurnId: undefined,
      recoveredFromTurnId: "turn_1",
      recoveryCount: 1,
      status: "recovering",
    });
    second.bindTurnAttempt("session_1", "turn_2");
    second.markTurnAttemptTerminal("turn_2", "completed");
    expect(second.listIncompleteTurnAttempts()).toEqual([]);
    expect(second.getTurnAttempt("attempt_1")).toMatchObject({ turnId: "turn_2", status: "completed" });
  });

  test("refreshes unfinished turn activity while throttling frequent persistence writes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.createTurnAttempt({
      attemptId: "attempt_activity",
      localSessionId: "session_activity",
      contextKey: "chat_id:c1",
      promptText: "long running work",
      turnId: "turn_activity",
      status: "running",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    });

    store.touchTurnAttempt("turn_activity", new Date("2026-08-08T00:01:00.000Z"));
    expect(store.getTurnAttempt("attempt_activity")?.updatedAt).toBe("2026-08-08T00:01:00.000Z");

    store.touchTurnAttempt("turn_activity", new Date("2026-08-08T00:01:10.000Z"));
    expect(store.getTurnAttempt("attempt_activity")?.updatedAt).toBe("2026-08-08T00:01:00.000Z");

    store.touchTurnAttempt("turn_activity", new Date("2026-08-08T00:01:16.000Z"));
    expect(store.getTurnAttempt("attempt_activity")?.updatedAt).toBe("2026-08-08T00:01:16.000Z");
  });

  test("persists LLM retry counts and rebinds pending messages to the retry turn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.createTurnAttempt({
      attemptId: "attempt_retry",
      localSessionId: "session_retry",
      contextKey: "chat_id:c1",
      promptText: "finish the task",
      turnId: "turn_1",
      status: "running",
    });
    for (const messageId of ["om_original", "om_steer"]) {
      store.saveMessageReaction(messageId, "chat_id:c1", `reaction_${messageId}`, "OnIt");
      store.bindMessageToTurn(messageId, "session_retry", "turn_1");
      store.bindMessageReaction(messageId, "session_retry", "turn_1");
    }

    expect(store.prepareTurnAttemptRetry("attempt_retry", "turn_1")).toMatchObject({
      turnId: undefined,
      recoveredFromTurnId: "turn_1",
      retryCount: 1,
      status: "recovering",
    });
    store.bindTurnAttempt("session_retry", "turn_2");
    store.rebindPendingTurnMessages("session_retry", "turn_1", "turn_2");

    expect(store.getMessageReaction("om_original")).toMatchObject({ turnId: "turn_2", status: "pending" });
    expect(store.getMessageReaction("om_steer")).toMatchObject({ turnId: "turn_2", status: "pending" });
    expect(store.findTurnAnchorByMessageId("om_original")).toMatchObject({ turnId: "turn_2" });
    expect(store.findTurnAnchorByMessageId("om_steer")).toMatchObject({ turnId: "turn_2" });
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

  test("finds the latest inbound message anchor for a task and context", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.saveMessageReaction("om_old", "chat_id:c1:thread_id:t1", "reaction_old", "OnIt");
    store.bindMessageReaction("om_old", "session_1", "turn_1");
    store.saveMessageReaction("om_other", "chat_id:c2:thread_id:t2", "reaction_other", "OnIt");
    store.bindMessageReaction("om_other", "session_1", "turn_2");
    store.saveMessageReaction("om_latest", "chat_id:c1:thread_id:t1", "reaction_latest", "OnIt");
    store.bindMessageReaction("om_latest", "session_1", "turn_3");

    expect(store.findLatestMessageIdForSession("session_1")).toBe("om_latest");
    expect(store.findLatestMessageIdForSession("session_1", "chat_id:c1:thread_id:t1"))
      .toBe("om_latest");
    expect(store.findLatestMessageIdForSession("session_1", "chat_id:c2:thread_id:t2"))
      .toBe("om_other");
    expect(store.findLatestMessageIdForSession("unknown")).toBeUndefined();

    store.audit("chat_id:c1:thread_id:t1", "incoming_message", { messageId: "om_command" });
    expect(store.findLatestMessageIdForContext("chat_id:c1:thread_id:t1")).toBe("om_command");
    expect(store.findLatestMessageIdForContext("chat_id:missing")).toBeUndefined();
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
