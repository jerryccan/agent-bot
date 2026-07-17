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
import type { AgentRuntime, RemoteSessionSummary, RuntimeEvent, RuntimeSession } from "../../src/runtime/types.js";
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
  const remoteSessions: RemoteSessionSummary[] = [];
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
    getSession: vi.fn((id) => sessions.get(id)),
    readSessionMetadata: vi.fn(async () => ({})),
    listRemoteSessions: vi.fn(async ({ searchTerm }: { searchTerm?: string } = {}) => ({
      sessions: remoteSessions.filter((session) => !searchTerm || session.title?.includes(searchTerm)),
    })),
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
    addReaction: vi.fn(async () => undefined),
    deleteReaction: vi.fn(async () => undefined),
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
    agents: {
      codex: { kind: "codex", title: "Codex", command: "codex", args: [], env: {} },
      acp: { kind: "acp", title: "ACP", command: "acp", args: [], env: {} },
    },
    defaults: { agent: "codex", cwd: process.cwd() },
  } as unknown as AppConfig;
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const restart = vi.fn(async () => undefined);
  const controller = new ProxySessionController(
    config,
    store,
    new AgentRuntimeRegistry({ acp, codex: runtime }),
    outboundRouter,
    logger,
    { restart, supervised: true },
  );
  cleanups.push(() => {
    controller.close();
    store.close();
  });
  return { controller, runtime, sessions, remoteSessions, outbound, presenter, store, listeners, restart };
}

describe("ProxySessionController", () => {
  test("plain text creates the default Codex session and starts a turn", async () => {
    const { controller, runtime, store, presenter, outbound } = fixture();
    await controller.onMessage(message("inspect this repo"));

    expect(outbound.addReaction).toHaveBeenCalledWith("m-inspect this repo", "OnIt");
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(expect.any(String), "chat_id:c1", "inspect this repo");
    expect((presenter.startPendingTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect((outbound.addReaction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "inspect this repo");
    expect(presenter.registerSession).toHaveBeenCalledWith(expect.any(String), "chat_id:c1", "inspect this repo");
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ runtimeKind: "codex", remoteSessionId: "thr_1" });
  });

  test("new always uses the current default agent and treats its only argument as cwd", async () => {
    const { controller, runtime, store } = fixture();
    await controller.onMessage(message("/agent acp"));
    await controller.onMessage(message('/new "D:\\work space\\repo"'));

    expect(runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "acp",
      cwd: "D:\\work space\\repo",
    }));
    expect(store.listSessions("chat_id:c1").at(-1)).toMatchObject({
      agentName: "acp",
      cwd: "D:\\work space\\repo",
    });
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

    await controller.onMessage(message(`/new "${project}"`));
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

  test("plain text steers an active turn and stop bypasses prompt completion", async () => {
    const { controller, runtime, outbound } = fixture();
    await controller.onMessage(message("build it"));
    await controller.onMessage(message("also update docs"));
    await controller.onMessage(message("/stop"));

    expect(runtime.steerTurn).toHaveBeenCalledWith(expect.any(String), "turn_1", "also update docs");
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
      updatedAt: 100,
      lastTurnId: "turn_external",
      lastTurnStatus: "completed",
    });

    await controller.onMessage(message("/sessions Desktop"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Desktop investigation");
    expect(serialized).toContain("external_1");
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
    expect(serialized.indexOf("active_1")).toBeLessThan(serialized.indexOf("idle_1"));
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

    const currentId = store.getOrCreateUserContext("chat_id:c1", "codex").currentSessionId;
    expect(store.getSession(currentId!)?.remoteSessionId).toBe("external_second");
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
    const cardsBeforeStatus = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.length;

    await controller.onMessage(message("/status"));

    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(cardsBeforeStatus + 1);
    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ header: { title: { content: "Codex 状态" } } });
    expect(serialized).toContain("当前任务");
    expect(serialized).toContain("**标题**：inspect this repo");
    expect(serialized).toContain("**状态**：执行中");
    expect(serialized).toContain("**模型 / 思考强度**：gpt-test / high");
    expect(serialized).toContain("**权限模式**：自动执行");
    expect(serialized).toContain("**任务范围**：未指定项目");
    expect(serialized).toContain("**Codex 任务 ID**：thr_1");
    expect(serialized).toContain("acp-bot");
    expect(serialized).toContain("**保活机制**：已启用（异常退出自动重启）");
    expect(serialized).toContain("**任务统计**：共 1 个");
    expect(serialized).not.toContain("###");
    expect(serialized).not.toContain("`");
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
    expect(serialized).toContain("**状态**：外部执行中");
    expect(serialized).toContain("**当前执行**：turn_external_active");
    expect(serialized).toContain("**最近结果**：执行中");
    expect(serialized).toContain("**回合 ID**：turn_external_active");
    expect(serialized).toContain("Running external integration tests");
    expect(serialized).toContain("任务仍在执行，尚无最终结果");
    expect(serialized).not.toContain("turn_old");
    expect(serialized).not.toContain("stale local tool");
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
    expect(serialized).toContain("**工具执行**：完成 1，失败 0");
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
      lastTurnId: "turn_external",
      lastTurnStatus: "inProgress",
      lastActivity: "Running the integration tests",
    });

    await controller.onMessage(message("/status external_status"));

    const card = (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("🟢 外部执行中");
    expect(serialized).toContain("Running the integration tests");
    expect(serialized).toContain("**当前任务**：未切换");
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
    expect(serialized.match(/\/stop/g)).toHaveLength(1);
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
