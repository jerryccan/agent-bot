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
import type { AgentEvent, AgentRuntime, RuntimeSession } from "../../src/runtime/types.js";
import { StateStore } from "../../src/state/StateStore.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function message(text: string): IncomingMessage {
  return { messageId: `m-${text}`, contextKey: "chat_id:c1", text };
}

function fixture() {
  const sessions = new Map<string, RuntimeSession>();
  const listeners = new Set<(event: AgentEvent) => void>();
  const runtime: AgentRuntime = {
    kind: "codex",
    createSession: vi.fn(async (input) => {
      const session: RuntimeSession = { ...input, remoteSessionId: "thr_1", runtimeKind: "codex" };
      sessions.set(input.localSessionId, session);
      return session;
    }),
    resumeSession: vi.fn(async (input) => {
      const session: RuntimeSession = { ...input, runtimeKind: "codex" };
      sessions.set(input.localSessionId, session);
      return session;
    }),
    getSession: vi.fn((id) => sessions.get(id)),
    startTurn: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId)!;
      session.activeTurnId = "turn_1";
      for (const listener of listeners) listener({ type: "turn_started", sessionId, turnId: "turn_1", startedAt: 1 });
      return "turn_1";
    }),
    steerTurn: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    respondToApproval: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [{ id: "gpt-test", displayName: "GPT Test" }]),
    onEvent: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    close: vi.fn(),
  };
  const acp = { ...runtime, kind: "acp" as const } as AgentRuntime;
  const outbound: FeishuOutbound = {
    sendText: vi.fn(async () => "text"),
    sendMarkdown: vi.fn(async () => "markdown"),
    sendInteractiveCard: vi.fn(async () => "card"),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
  const presenter: TurnPresenter = {
    registerSession: vi.fn(),
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
    agents: { codex: { kind: "codex", title: "Codex", command: "codex", args: [], env: {} } },
    defaults: { agent: "codex", cwd: process.cwd() },
  } as unknown as AppConfig;
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const controller = new ProxySessionController(config, store, new AgentRuntimeRegistry({ acp, codex: runtime }), outboundRouter, logger);
  cleanups.push(() => {
    controller.close();
    store.close();
  });
  return { controller, runtime, sessions, outbound, presenter, store, listeners };
}

describe("ProxySessionController", () => {
  test("plain text creates the default Codex session and starts a turn", async () => {
    const { controller, runtime, store, presenter } = fixture();
    await controller.onMessage(message("inspect this repo"));

    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(presenter.startPendingTurn).toHaveBeenCalledWith(expect.any(String), "chat_id:c1");
    expect((presenter.startPendingTurn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.createSession as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.any(String), "inspect this repo");
    expect(presenter.registerSession).toHaveBeenCalledWith(expect.any(String), "chat_id:c1");
    expect(store.listSessions("chat_id:c1")[0]).toMatchObject({ runtimeKind: "codex", remoteSessionId: "thr_1" });
  });

  test("ignores a duplicate inbound message id", async () => {
    const { controller, runtime } = fixture();
    const duplicate = { messageId: "same-event", contextKey: "chat_id:c1", text: "inspect" };
    await controller.onMessage(duplicate);
    await controller.onMessage(duplicate);
    expect(runtime.startTurn).toHaveBeenCalledOnce();
  });

  test("plain text steers an active turn and cancel bypasses prompt completion", async () => {
    const { controller, runtime } = fixture();
    await controller.onMessage(message("build it"));
    await controller.onMessage(message("also update docs"));
    await controller.onMessage(message("/cancel"));

    expect(runtime.steerTurn).toHaveBeenCalledWith(expect.any(String), "turn_1", "also update docs");
    expect(runtime.cancelTurn).toHaveBeenCalledWith(expect.any(String), "turn_1");
  });

  test("lazily resumes a persisted session before starting the next turn", async () => {
    const { controller, runtime, store } = fixture();
    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.createSession({ localSessionId: "saved", contextKey: "chat_id:c1", agentName: "codex", cwd: process.cwd(), status: "ready" });
    store.updateRuntimeSession("saved", { runtimeKind: "codex", remoteSessionId: "thr_saved", permissionMode: "auto" });
    store.setCurrentSession("chat_id:c1", "saved");

    await controller.onMessage(message("continue"));
    expect(runtime.resumeSession).toHaveBeenCalledWith(expect.objectContaining({ localSessionId: "saved", remoteSessionId: "thr_saved" }));
    expect(runtime.startTurn).toHaveBeenCalledWith("saved", "continue");
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
});
