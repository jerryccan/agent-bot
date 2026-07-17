import path from "node:path";
import type { Logger } from "pino";
import { createProjectlessWorkspace, detectProjectlessWorkspace } from "../codex/ProjectlessWorkspace.js";
import type { AppConfig } from "../config/schema.js";
import { CommandRouter } from "../commands/CommandRouter.js";
import type { Command } from "../commands/commandTypes.js";
import type { CardAction, IncomingMessage } from "../feishu/types.js";
import { CardRenderer, type CardSection, type TaskListCardAction } from "../feishu/CardRenderer.js";
import type { OutboundRouter } from "../presentation/OutboundRouter.js";
import type { TurnActivity, TurnViewState } from "../presentation/turnViewTypes.js";
import type { AgentRuntimeRegistry } from "../runtime/AgentRuntimeRegistry.js";
import type {
  AgentRuntime,
  ApprovalDecision,
  PermissionMode,
  RemoteSessionSummary,
  RuntimeEvent,
  RuntimeSession,
} from "../runtime/types.js";
import {
  StateStore,
  type MessageReactionRecord,
  type MessageReactionStatus,
  type SessionRecord,
} from "../state/StateStore.js";
import { createId } from "../utils/id.js";
import { asInlineCode, truncateMiddle, truncateText } from "../utils/markdown.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";

interface LoadedSession {
  record: SessionRecord;
  runtime: AgentRuntime;
  session: RuntimeSession;
}

const MESSAGE_RECEIVED_REACTION = "OnIt";
const MESSAGE_COMPLETED_REACTION = "DONE";
const MESSAGE_FAILED_REACTION = "ERROR";
const MESSAGE_CANCELLED_REACTION = "CrossMark";
const SESSION_PAGE_SIZE = 5;

interface QueuedPrompt {
  text: string;
  messageId?: string;
}

interface SessionsCardOptions {
  updateMessageId?: string;
  forceSwitchTaskId?: string;
  visibleCount?: number;
}

export interface ProxyLifecycle {
  supervised?: boolean;
  restart(contextKey: string): Promise<void>;
}

export class ProxySessionController {
  private readonly router = new CommandRouter();
  private readonly cardRenderer = new CardRenderer();
  private readonly messageQueues = new Map<string, Promise<void>>();
  private readonly sessionLoads = new Map<string, Promise<LoadedSession>>();
  private readonly queuedPrompts = new Map<string, QueuedPrompt[]>();
  private readonly lastSessionListings = new Map<string, string[]>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly runtimes: AgentRuntimeRegistry,
    private readonly outbound: OutboundRouter,
    private readonly logger: Logger,
    private readonly lifecycle?: ProxyLifecycle,
  ) {
    const interruptedAcpSessions = this.store.reconcileInterruptedAcpSessions(
      Object.entries(this.config.agents)
        .filter(([, agent]) => agent.kind === "acp")
        .map(([name]) => name),
    );
    if (interruptedAcpSessions.length > 0) {
      this.logger.warn(
        { sessionIds: interruptedAcpSessions.map((session) => session.localSessionId) },
        "Marked interrupted ACP sessions as failed after process restart.",
      );
    }
    for (const kind of ["acp", "codex"] as const) {
      this.unsubscribe.push(
        this.runtimes.get(kind).onEvent((event) => {
          void this.handleRuntimeEvent(event).catch((error: unknown) => {
            this.logger.warn({ error, event }, "Failed to present runtime event.");
          });
        }),
      );
    }
    this.restorePersistedSessionRoutes();
    void this.restorePersistedMessageReactions().catch((error: unknown) => {
      this.logger.warn({ error }, "Failed to restore persisted message reaction statuses.");
    });
  }

  async onMessage(message: IncomingMessage): Promise<void> {
    if (!this.store.claimInboundEvent(message.messageId, "message")) return;
    try {
      const reactionId = await this.outbound.addReaction(
        message.contextKey,
        message.messageId,
        MESSAGE_RECEIVED_REACTION,
      );
      if (reactionId) {
        this.store.saveMessageReaction(message.messageId, message.contextKey, reactionId, MESSAGE_RECEIVED_REACTION);
      }
    } catch (error) {
      this.logger.warn(
        { error, messageId: message.messageId, contextKey: message.contextKey },
        "Failed to acknowledge the incoming Feishu message with a reaction.",
      );
    }
    this.store.audit(message.contextKey, "incoming_message", { messageId: message.messageId, text: message.text });
    let command: Command;
    try {
      command = this.router.parse(message.text);
    } catch (error) {
      await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
      await this.sendError(message.contextKey, error);
      return;
    }

    // Operational and read-only commands must remain available even if a prompt operation is slow.
    if (isQueueIndependentCommand(command)) {
      try {
        await this.execute(message.contextKey, command, message.messageId);
        if (!isPromptCommand(command)) await this.finalizeStandaloneMessageReaction(message.messageId, "completed");
      } catch (error) {
        await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
        await this.sendError(message.contextKey, error);
      }
      return;
    }

    const previous = this.messageQueues.get(message.contextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      try {
        await this.execute(message.contextKey, command, message.messageId);
        if (!isPromptCommand(command)) await this.finalizeStandaloneMessageReaction(message.messageId, "completed");
      } catch (error) {
        await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
        await this.sendError(message.contextKey, error);
      }
    });
    this.messageQueues.set(message.contextKey, next);
    await next;
    if (this.messageQueues.get(message.contextKey) === next) this.messageQueues.delete(message.contextKey);
  }

  async onCardAction(action: CardAction): Promise<void> {
    if (!this.store.claimInboundEvent(action.actionId, "card_action")) return;

    try {
      const kind = String(action.value.action ?? "");
      if (kind === "turn_details") {
        await this.outbound.showDetails(action.contextKey, String(action.value.turnId ?? ""));
      } else if (kind === "turn_cancel") {
        const sessionId = String(action.value.sessionId ?? "");
        await this.cancelSession(this.requireSession(action.contextKey, sessionId));
      } else if (kind === "session_more") {
        await this.refreshSessionsCardFromAction(action, undefined, true);
      } else if (kind === "session_switch") {
        await this.switchSession(action.contextKey, String(action.value.sessionId ?? ""));
        await this.refreshSessionsCardFromAction(action);
      } else if (kind === "session_stop") {
        const sessionId = String(action.value.sessionId ?? "");
        await this.stopSessionReference(action.contextKey, sessionId);
        await this.refreshSessionsCardFromAction(action, sessionId);
      } else if (kind === "session_status") {
        await this.status(action.contextKey, String(action.value.sessionId ?? ""));
      } else if (kind === "approval") {
        await this.resolveApproval(action);
      }
    } catch (error) {
      await this.sendError(action.contextKey, error);
    }
  }

  close(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
    this.lastSessionListings.clear();
  }

  private async execute(contextKey: string, command: Command, messageId?: string): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    switch (command.type) {
      case "new":
        await this.createSession(
          contextKey,
          context.defaultAgent,
          command.cwd ?? this.inheritedNewTaskCwd(contextKey),
          true,
          false,
        );
        return;
      case "ask":
      case "prompt":
        await this.prompt(contextKey, command.text, messageId);
        return;
      case "sessions":
        await this.listSessions(contextKey, command.searchTerm);
        return;
      case "switch":
        await this.switchSession(contextKey, command.sessionId);
        return;
      case "agent":
        if (command.agent) await this.setDefaultAgent(contextKey, command.agent);
        else await this.listAgents(contextKey);
        return;
      case "use":
        await this.setDefaultAgent(contextKey, command.agent);
        await this.createSession(contextKey, command.agent, command.cwd, true, false);
        return;
      case "status":
        await this.status(contextKey, command.sessionId);
        return;
      case "restart":
        if (!this.lifecycle) throw new Error("当前运行方式不支持自动重启。");
        await this.lifecycle.restart(contextKey);
        return;
      case "model":
        await this.model(contextKey, command.model);
        return;
      case "thinking":
        await this.thinking(contextKey, command.effort);
        return;
      case "permissions":
        await this.permissions(contextKey, command.mode);
        return;
      case "modes":
      case "mode":
        await this.outbound.sendText(contextKey, "当前统一运行时不再暴露 ACP modes；Codex 请使用 /model 和 /permissions。");
        return;
      case "help":
        await this.help(contextKey);
        return;
      case "stop":
        await this.cancel(contextKey);
        return;
    }
  }

  private restorePersistedSessionRoutes(): void {
    for (const context of this.store.listUserContexts()) {
      if (!context.currentSessionId) continue;
      const session = this.store.getSession(context.currentSessionId);
      if (!session || session.status === "closed") continue;
      this.outbound.registerSession(session.localSessionId, session.contextKey, session.title);
      if (!session.lastTurnId) continue;
      void this.outbound.resumeDelivery(session.localSessionId, session.contextKey, session.lastTurnId).catch((error: unknown) => {
        this.logger.warn({ error, sessionId: session.localSessionId }, "Failed to restore persisted turn delivery.");
      });
    }
  }

  private async restorePersistedMessageReactions(): Promise<void> {
    const pending = this.store.listPendingMessageReactions();
    const terminalTurns = new Map<string, "completed" | "failed" | "cancelled">();
    for (const reaction of pending) {
      if (!reaction.turnId || !reaction.localSessionId) continue;
      const session = this.store.getSession(reaction.localSessionId);
      if (session?.lastTurnId !== reaction.turnId) continue;
      if (session.lastTurnStatus === "completed" || session.lastTurnStatus === "failed" || session.lastTurnStatus === "cancelled") {
        terminalTurns.set(reaction.turnId, session.lastTurnStatus);
      }
    }
    for (const [turnId, status] of terminalTurns) {
      await this.finalizeTurnMessageReactions(turnId, status);
    }
  }

  private async prompt(contextKey: string, text: string, messageId?: string): Promise<void> {
    if (!text.trim()) throw new Error("请输入要交给 Codex 的内容。");
    let record = this.currentSession(contextKey);
    if (!record) {
      const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
      record = await this.createSession(contextKey, context.defaultAgent, undefined, false, true, text);
    }
    const configuredRuntime = this.runtimes.forAgent(this.ensureAgent(record.agentName));
    if (!configuredRuntime.getSession(record.localSessionId)) {
      this.outbound.registerSession(record.localSessionId, contextKey, record.title);
      await this.outbound.startPendingTurn(record.localSessionId, contextKey, record.title);
    }
    let loaded: LoadedSession;
    try {
      loaded = await this.loadSession(record);
    } catch (error) {
      await this.outbound.failPendingTurn(record.localSessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    try {
      await this.assertSessionTurnOwnership(loaded.record, loaded.runtime);
    } catch (error) {
      await this.outbound.failPendingTurn(record.localSessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (loaded.record.lastTurnId || loaded.session.activeTurnId) {
      try {
        loaded.session = await loaded.runtime.synchronizeSession(record.localSessionId);
      } catch (error) {
        this.logger.warn({ error, sessionId: record.localSessionId }, "Failed to synchronize session before prompt.");
      }
    }
    const activeTurnId = loaded.session.activeTurnId;
    if (activeTurnId) {
      try {
        await loaded.runtime.steerTurn(record.localSessionId, activeTurnId, text);
        if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, activeTurnId);
        return;
      } catch (error) {
        this.logger.debug({ error, sessionId: record.localSessionId, activeTurnId }, "Steering failed; reconciling the Codex thread.");
        let current = loaded.runtime.getSession(record.localSessionId);
        try {
          current = await loaded.runtime.synchronizeSession(record.localSessionId);
        } catch (syncError) {
          this.logger.warn({ error: syncError, sessionId: record.localSessionId }, "Failed to synchronize after steering failure.");
        }
        if (!current?.activeTurnId) {
          const turnId = await this.startTurn(loaded, text);
          if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, turnId);
          return;
        }
        if (current.activeTurnId !== activeTurnId) {
          try {
            await loaded.runtime.steerTurn(record.localSessionId, current.activeTurnId, text);
            if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, current.activeTurnId);
            return;
          } catch (retryError) {
            this.logger.warn(
              { error: retryError, sessionId: record.localSessionId, activeTurnId: current.activeTurnId },
              "Failed to steer the reconciled Codex turn; queueing prompt.",
            );
          }
        }
        const queued = this.queuedPrompts.get(record.localSessionId) ?? [];
        queued.push({ text, messageId });
        this.queuedPrompts.set(record.localSessionId, queued);
        return;
      }
    }
    const turnId = await this.startTurn(loaded, text);
    if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, turnId);
  }

  private async startTurn(loaded: LoadedSession, text: string): Promise<string> {
    const currentRecord = this.store.getSession(loaded.record.localSessionId);
    const title = currentRecord?.title ?? normalizeTaskTitle(text);
    if (!currentRecord?.title && title) this.store.updateRuntimeSession(loaded.record.localSessionId, { title });
    if (title) this.outbound.updateSessionTitle(loaded.record.localSessionId, title);
    await this.outbound.startPendingTurn(loaded.record.localSessionId, loaded.record.contextKey, title);
    let turnId: string;
    try {
      turnId = await loaded.runtime.startTurn(loaded.record.localSessionId, text);
    } catch (error) {
      await this.outbound.failPendingTurn(
        loaded.record.localSessionId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    const latest = this.store.getSession(loaded.record.localSessionId);
    const alreadyTerminal = latest?.lastTurnId === turnId
      && ["completed", "cancelled", "failed"].includes(latest.lastTurnStatus ?? "");
    if (!alreadyTerminal) {
      this.store.updateSession(loaded.record.localSessionId, { status: "running" });
      this.store.updateRuntimeSession(loaded.record.localSessionId, { lastTurnId: turnId, lastTurnStatus: "running" });
    }
    return turnId;
  }

  private async createSession(
    contextKey: string,
    agentName: string,
    cwd: string | undefined,
    announce: boolean,
    prepareTurn: boolean,
    prompt?: string,
  ): Promise<SessionRecord> {
    const agent = this.ensureAgent(agentName);
    const localSessionId = createId("sess");
    const sessionCwd = cwd === undefined && agent.kind === "codex"
      ? createProjectlessWorkspace({ prompt }).cwd
      : path.resolve(cwd ?? this.config.defaults.cwd);
    const record = this.store.createSession({ localSessionId, contextKey, agentName, cwd: sessionCwd, status: "starting" });
    const initialTitle = normalizeTaskTitle(prompt ?? "");
    if (initialTitle) this.store.updateRuntimeSession(localSessionId, { title: initialTitle });
    this.store.setCurrentSession(contextKey, localSessionId);
    this.outbound.registerSession(localSessionId, contextKey, initialTitle);
    const runtime = this.runtimes.forAgent(agent);
    try {
      if (prepareTurn) await this.outbound.startPendingTurn(localSessionId, contextKey, initialTitle);
      const session = await runtime.createSession({
        localSessionId,
        agentName,
        cwd: sessionCwd,
        permissionMode: "auto",
      });
      this.persistRuntimeSession(record, session, session.activeTurnId ? "running" : "ready");
      const saved = this.store.getSession(localSessionId) ?? record;
      if (announce) await this.outbound.sendText(contextKey, `已创建 ${agent.title} 任务：${session.remoteSessionId}`);
      return saved;
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      if (prepareTurn) {
        await this.outbound.failPendingTurn(localSessionId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private async loadSession(record: SessionRecord): Promise<LoadedSession> {
    const agent = this.ensureAgent(record.agentName);
    const runtime = this.runtimes.forAgent(agent);
    const existing = runtime.getSession(record.localSessionId);
    if (existing) return { record, runtime, session: existing };
    const pending = this.sessionLoads.get(record.localSessionId);
    if (pending) return pending;

    this.outbound.registerSession(record.localSessionId, record.contextKey, record.title);
    const loading = (async (): Promise<LoadedSession> => {
      if (record.lastTurnId) {
        await this.outbound.resumeDelivery(record.localSessionId, record.contextKey, record.lastTurnId);
      }
      const permissionMode = record.permissionMode ?? "auto";
      if (record.remoteSessionId) await this.assertSessionTurnOwnership(record, runtime);
      let session: RuntimeSession;
      if (record.remoteSessionId) {
        try {
          session = await runtime.resumeSession({
            localSessionId: record.localSessionId,
            remoteSessionId: record.remoteSessionId,
            agentName: record.agentName,
            cwd: record.cwd,
            title: record.title,
            model: record.model,
            reasoningEffort: record.reasoningEffort,
            permissionMode,
            activeTurnId: agent.kind === "codex" && record.status === "running" && record.lastTurnStatus === "running"
              ? record.lastTurnId
              : undefined,
          });
        } catch (error) {
          if (!(agent.kind === "codex" && !record.lastTurnId && isMissingRolloutError(error))) throw error;
          this.logger.warn({ error, sessionId: record.localSessionId }, "Codex task has no rollout; creating a replacement task.");
          session = await runtime.createSession({
            localSessionId: record.localSessionId,
            agentName: record.agentName,
            cwd: record.cwd,
            title: record.title,
            model: record.model,
            reasoningEffort: record.reasoningEffort,
            permissionMode,
          });
        }
      } else {
        session = await runtime.createSession({
          localSessionId: record.localSessionId,
          agentName: record.agentName,
          cwd: record.cwd,
          title: record.title,
          model: record.model,
          reasoningEffort: record.reasoningEffort,
          permissionMode,
        });
      }
      this.persistRuntimeSession(record, session, session.activeTurnId ? "running" : "ready");
      return { record: this.store.getSession(record.localSessionId) ?? record, runtime, session };
    })();
    this.sessionLoads.set(record.localSessionId, loading);
    try {
      return await loading;
    } finally {
      this.sessionLoads.delete(record.localSessionId);
    }
  }

  private persistRuntimeSession(record: SessionRecord, session: RuntimeSession, status: "ready" | "running"): void {
    this.store.updateRuntimeSession(record.localSessionId, {
      runtimeKind: session.runtimeKind,
      remoteSessionId: session.remoteSessionId,
      title: session.title,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      permissionMode: session.permissionMode,
    });
    this.store.updateSession(record.localSessionId, {
      acpSessionId: session.runtimeKind === "acp" ? session.remoteSessionId : undefined,
      status,
    });
  }

  private async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if (event.type === "session_metadata_updated") {
      this.store.updateRuntimeSession(event.sessionId, { title: event.title });
      this.outbound.updateSessionTitle(event.sessionId, event.title);
      return;
    }
    if (event.type === "turn_started") {
      this.store.updateSession(event.sessionId, { status: "running" });
      this.store.updateRuntimeSession(event.sessionId, { lastTurnId: event.turnId, lastTurnStatus: "running" });
    } else if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      const status = event.type === "turn_failed" ? "failed" : "ready";
      this.store.updateSession(event.sessionId, { status });
      this.store.updateRuntimeSession(event.sessionId, {
        lastTurnId: event.turnId,
        lastTurnStatus: event.type === "turn_completed" ? "completed" : event.type === "turn_cancelled" ? "cancelled" : "failed",
      });
      await this.finalizeTurnMessageReactions(
        event.turnId,
        event.type === "turn_completed" ? "completed" : event.type === "turn_cancelled" ? "cancelled" : "failed",
      );
    }

    await this.outbound.onEvent(event);
    if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      const latest = this.store.getSession(event.sessionId);
      const agent = latest ? this.ensureAgent(latest.agentName) : undefined;
      const activeTurnId = agent ? this.runtimes.forAgent(agent).getSession(event.sessionId)?.activeTurnId : undefined;
      if (latest?.lastTurnId !== event.turnId || activeTurnId) return;
      await this.startNextQueuedPrompt(event.sessionId);
    }
  }

  private async startNextQueuedPrompt(sessionId: string): Promise<void> {
    const queued = this.queuedPrompts.get(sessionId);
    const prompt = queued?.shift();
    if (!prompt) {
      this.queuedPrompts.delete(sessionId);
      return;
    }
    if (queued?.length === 0) this.queuedPrompts.delete(sessionId);
    const record = this.store.getSession(sessionId);
    if (!record || record.status === "closed") return;
    try {
      const turnId = await this.startTurn(await this.loadSession(record), prompt.text);
      if (prompt.messageId) await this.bindMessageReactionToTurn(prompt.messageId, sessionId, turnId);
    } catch (error) {
      this.logger.warn({ error, sessionId }, "Failed to start queued prompt.");
      if (prompt.messageId) await this.finalizeStandaloneMessageReaction(prompt.messageId, "failed");
      await this.sendError(record.contextKey, error);
    }
  }

  private async finalizeStandaloneMessageReaction(
    messageId: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const reaction = this.store.claimMessageReaction(messageId);
    if (reaction) await this.replaceMessageReaction(reaction, status);
  }

  private async bindMessageReactionToTurn(messageId: string, sessionId: string, turnId: string): Promise<void> {
    this.store.bindMessageReaction(messageId, sessionId, turnId);
    const session = this.store.getSession(sessionId);
    if (session?.lastTurnId !== turnId) return;
    if (session.lastTurnStatus === "completed" || session.lastTurnStatus === "failed" || session.lastTurnStatus === "cancelled") {
      await this.finalizeTurnMessageReactions(turnId, session.lastTurnStatus);
    }
  }

  private async finalizeTurnMessageReactions(
    turnId: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    for (const reaction of this.store.claimMessageReactionsForTurn(turnId)) {
      await this.replaceMessageReaction(reaction, status);
    }
  }

  private async replaceMessageReaction(
    reaction: MessageReactionRecord,
    status: Exclude<MessageReactionStatus, "pending" | "updating">,
  ): Promise<void> {
    const emojiType = status === "completed"
      ? MESSAGE_COMPLETED_REACTION
      : status === "cancelled"
        ? MESSAGE_CANCELLED_REACTION
        : MESSAGE_FAILED_REACTION;
    try {
      const replacementId = await this.outbound.addReaction(reaction.contextKey, reaction.messageId, emojiType);
      if (!replacementId) throw new Error("Feishu did not return the replacement reaction ID.");
      try {
        await this.outbound.deleteReaction(reaction.contextKey, reaction.messageId, reaction.reactionId);
      } catch (error) {
        this.logger.warn(
          { error, messageId: reaction.messageId, reactionId: reaction.reactionId },
          "Added the terminal reaction but failed to remove the previous reaction.",
        );
      }
      this.store.finishMessageReaction(reaction.messageId, replacementId, emojiType, status);
    } catch (error) {
      this.store.releaseMessageReaction(reaction.messageId);
      this.logger.warn(
        { error, messageId: reaction.messageId, status },
        "Failed to update the Feishu message reaction for a completed task state.",
      );
    }
  }

  private async cancel(contextKey: string): Promise<void> {
    const record = this.requireCurrentSession(contextKey);
    await this.cancelSession(record);
  }

  private async cancelSession(record: SessionRecord): Promise<void> {
    const runtime = this.runtimes.forAgent(this.ensureAgent(record.agentName));
    if (runtime.kind === "codex" && record.remoteSessionId && runtime.interruptRemoteTurn) {
      let turnId = runtime.getSession(record.localSessionId)?.activeTurnId;
      if (runtime.readRemoteSession) {
        try {
          const remote = await runtime.readRemoteSession(record.remoteSessionId);
          turnId = remote.status === "active" || remote.lastTurnStatus === "inProgress"
            ? remote.lastTurnId
            : undefined;
        } catch (error) {
          this.logger.warn(
            { error, sessionId: record.localSessionId, remoteSessionId: record.remoteSessionId },
            "Failed to inspect the current Codex turn before interrupting; using the locally tracked turn.",
          );
        }
      }
      if (!turnId) {
        await this.outbound.sendText(record.contextKey, "当前没有正在执行的任务。");
        return;
      }
      await runtime.interruptRemoteTurn(record.remoteSessionId, turnId);
      this.store.audit(record.contextKey, "turn_interrupt_sent", {
        localSessionId: record.localSessionId,
        remoteSessionId: record.remoteSessionId,
        turnId,
      });
      await this.outbound.sendText(record.contextKey, `已向 Codex 发送 Interrupt 请求：${turnId}`);
      return;
    }

    const loaded = await this.loadSession(record);
    const turnId = loaded.session.activeTurnId;
    if (!turnId) {
      await this.outbound.sendText(record.contextKey, "当前没有正在执行的任务。");
      return;
    }
    await loaded.runtime.cancelTurn(record.localSessionId, turnId);
  }

  private async resolveApproval(action: CardAction): Promise<void> {
    const sessionId = String(action.value.sessionId ?? "");
    const requestId = String(action.value.requestId ?? "");
    const decision = String(action.value.decision ?? "") as ApprovalDecision;
    if (!(["accept", "acceptForSession", "decline", "cancel"] as string[]).includes(decision)) {
      throw new Error("无效的确认选项。");
    }
    const loaded = await this.loadSession(this.requireSession(action.contextKey, sessionId));
    await loaded.runtime.respondToApproval(sessionId, requestId, decision);
  }

  private async model(contextKey: string, model?: string): Promise<void> {
    const loaded = await this.loadSession(this.requireCurrentSession(contextKey));
    if (!model) {
      const models = await loaded.runtime.listModels();
      const currentModel = loaded.session.model ?? models.find((item) => item.isDefault)?.id;
      const lines = models.map((item) => {
        const isCurrent = item.id === currentModel;
        const marker = isCurrent ? "✅ " : "";
        const label = isCurrent ? "（当前）" : item.isDefault ? "（默认）" : "";
        const displayName = item.displayName && item.displayName !== item.id ? `：${item.displayName}` : "";
        return `- ${marker}${asInlineCode(item.id)}${label}${displayName}`;
      });
      await this.outbound.sendMarkdown(contextKey, [
        `当前模型：${asInlineCode(currentModel ?? "默认")}`,
        `当前思考强度：${loaded.session.reasoningEffort ?? "默认"}`,
        "支持的模型：",
        lines.join("\n") || "- 无",
      ].join("\n"));
      return;
    }

    const models = await loaded.runtime.listModels();
    const selected = models.find((item) => item.id === model);
    if (!selected) throw new Error(`未知模型：${model}`);
    const currentEffort = loaded.session.reasoningEffort;
    const compatible = currentEffort
      ? selected.supportedReasoningEfforts.some((option) => option.value === currentEffort)
      : false;
    const nextEffort = compatible ? currentEffort : selected.defaultReasoningEffort;

    await loaded.runtime.setModel(loaded.record.localSessionId, model);
    if (nextEffort && nextEffort !== currentEffort) {
      await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, nextEffort);
    }
    this.store.updateRuntimeSession(loaded.record.localSessionId, { model, reasoningEffort: nextEffort });
    const effortMessage = nextEffort && nextEffort !== currentEffort
      ? `，思考强度已自动调整为 ${nextEffort}`
      : "";
    await this.outbound.sendText(contextKey, `模型已切换为 ${model}${effortMessage}，从下一次请求生效。`);
  }

  private async thinking(contextKey: string, effort?: string): Promise<void> {
    const loaded = await this.loadSession(this.requireCurrentSession(contextKey));
    const models = await loaded.runtime.listModels();
    const currentModel = models.find((item) => item.id === loaded.session.model)
      ?? models.find((item) => item.isDefault);
    if (!currentModel) throw new Error("当前运行时没有可配置思考强度的模型。");
    const supported = currentModel.supportedReasoningEfforts;

    if (!effort) {
      const lines = supported.map((option) =>
        `- ${asInlineCode(option.value)}${option.description ? `：${option.description}` : ""}`,
      );
      await this.outbound.sendMarkdown(contextKey, [
        `当前思考强度：${loaded.session.reasoningEffort ?? currentModel.defaultReasoningEffort ?? "默认"}`,
        "可选强度：",
        lines.join("\n") || "无",
      ].join("\n"));
      return;
    }

    if (!supported.some((option) => option.value === effort)) {
      const options = supported.map((option) => option.value).join("、") || "无";
      throw new Error(`不支持的思考强度：${effort}。支持的强度：${options}`);
    }
    await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, effort);
    this.store.updateRuntimeSession(loaded.record.localSessionId, { reasoningEffort: effort });
    await this.outbound.sendText(contextKey, `思考强度已切换为 ${effort}，从下一次请求生效。`);
  }

  private async permissions(contextKey: string, mode?: PermissionMode): Promise<void> {
    const record = this.requireCurrentSession(contextKey);
    if (!mode) {
      await this.outbound.sendText(contextKey, `当前权限模式：${record.permissionMode ?? "auto"}`);
      return;
    }
    const loaded = await this.loadSession(record);
    await loaded.runtime.setPermissionMode(record.localSessionId, mode);
    this.store.updateRuntimeSession(record.localSessionId, { permissionMode: mode });
    await this.outbound.sendText(contextKey, mode === "auto" ? "已切换为自动执行模式。" : "已切换为执行前确认模式。");
  }

  private async listAgents(contextKey: string): Promise<void> {
    const current = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!).defaultAgent;
    const lines = Object.entries(this.config.agents).map(([name, agent]) => {
      const selected = name === current;
      return `- ${selected ? "✅ " : ""}${asInlineCode(name)}：${agent.title}${selected ? "（当前）" : ""}`;
    });
    await this.outbound.sendMarkdown(contextKey, [
      `当前 Agent：${asInlineCode(current)}`,
      "可用 Agent：",
      lines.join("\n") || "无",
    ].join("\n"));
  }

  private async listSessions(
    contextKey: string,
    searchTerm?: string,
    options: SessionsCardOptions = {},
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const normalizedSearch = searchTerm?.trim().toLowerCase();
    const visibleCount = options.visibleCount ?? SESSION_PAGE_SIZE;
    const localSessions = this.store.listSessions(contextKey).filter((session) =>
      session.status !== "closed" && this.isCodexSession(session),
    );
    let remoteSessions: RemoteSessionSummary[] = [];
    let remoteHint: string | undefined;
    let remoteHasMore = false;
    const runtime = this.runtimes.get("codex");
    if (runtime.listRemoteSessions) {
      try {
        const page = await runtime.listRemoteSessions({ searchTerm, limit: visibleCount });
        remoteSessions = page.sessions;
        remoteHasMore = Boolean(page.nextCursor);
      } catch (error) {
        this.logger.warn({ error, contextKey }, "Failed to list Codex sessions.");
        remoteHint = `读取 Codex 任务失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const entries = mergeTaskList(localSessions, remoteSessions, context.currentSessionId)
      .filter((entry) => !normalizedSearch || [entry.id, entry.title, entry.cwd].some((value) => value.toLowerCase().includes(normalizedSearch)))
      .sort((left, right) => Number(right.current) - Number(left.current)
        || Number(right.active) - Number(left.active)
        || right.updatedAt - left.updatedAt);
    const activeCount = entries.filter((entry) => entry.active).length;
    const visibleEntries = entries.slice(0, visibleCount);
    const hasMore = remoteHasMore || entries.length > visibleCount;
    this.lastSessionListings.set(contextKey, visibleEntries.map((entry) => entry.id));
    const cardEntries = visibleEntries.map((entry, index) => {
      const marker = entry.current ? "✅" : entry.active ? "🟢 **活跃**" : "•";
      const showStop = entry.status === "外部执行中" && entry.id !== options.forceSwitchTaskId;
      const actions: TaskListCardAction[] = entry.current ? [] : [{
        text: showStop ? "Stop" : "Switch",
        type: showStop ? "danger" as const : "default" as const,
        value: {
          action: showStop ? "session_stop" : "session_switch",
          sessionId: entry.id,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
        },
      }];
      actions.push({
        text: "Status",
        value: {
          action: "session_status",
          sessionId: entry.id,
        },
      });
      return {
        lines: [
          `**${index + 1}.**　${marker}　**${cardText(entry.title)}**　${cardText(entry.id)}`,
          `${entry.status} · ${entry.updatedLabel} · ${cardText(entry.cwd || "目录未知")}`,
        ],
        actions,
      };
    });
    const card = this.cardRenderer.renderTaskListCard(
      searchTerm ? `Codex 任务：${searchTerm}` : "Codex 任务",
      activeCount > 0 ? `任务（${activeCount} 个活跃）` : "任务",
      cardEntries,
      [
        ...(remoteHint ? [remoteHint] : []),
        "点击 **Switch** 快速切换；外部正在运行的任务显示 **Stop**，点击后发送 Interrupt 并变为 **Switch**。",
        "也可发送 **/switch [序号或任务 ID]**；不带参数切回上一个任务。外部正在执行的回合不会被接管。",
        "点击 **Status**，或发送 **/status [序号或任务 ID]**，查看当前或指定任务状态。",
      ],
      hasMore ? {
        text: "更多任务",
        type: "primary",
        value: {
          action: "session_more",
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
        },
      } : undefined,
    );
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    } else {
      await this.outbound.sendInteractiveCard(contextKey, card);
    }
  }

  private async refreshSessionsCardFromAction(
    action: CardAction,
    forceSwitchTaskId?: string,
    loadMore = false,
  ): Promise<void> {
    if (!action.messageId) return;
    const searchTerm = typeof action.value.searchTerm === "string" && action.value.searchTerm.trim()
      ? action.value.searchTerm
      : undefined;
    const currentVisibleCount = parseSessionVisibleCount(action.value.visibleCount);
    await this.listSessions(action.contextKey, searchTerm, {
      updateMessageId: action.messageId,
      forceSwitchTaskId,
      visibleCount: currentVisibleCount + (loadMore ? SESSION_PAGE_SIZE : 0),
    });
  }

  private async switchSession(contextKey: string, reference?: string): Promise<void> {
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    const existing = direct ?? this.store.findSessionByRemoteSessionId(taskId);
    if (existing) {
      if (existing.contextKey !== contextKey || existing.status === "closed") throw new Error(`找不到任务：${taskId}`);
      const runtime = this.runtimes.forAgent(this.ensureAgent(existing.agentName));
      await this.assertSessionTurnOwnership(existing, runtime);
      this.store.setCurrentSession(contextKey, existing.localSessionId);
      this.outbound.registerSession(existing.localSessionId, contextKey, existing.title);
      await this.outbound.sendText(contextKey, `已切换到任务：${existing.title ?? existing.remoteSessionId ?? taskId}`);
      return;
    }

    const runtime = this.runtimes.get("codex");
    if (!runtime.readRemoteSession) throw new Error("当前 Codex 运行时不支持读取任务。");
    const remote = await runtime.readRemoteSession(taskId);
    if (remote.status === "active" || remote.lastTurnStatus === "inProgress") {
      throw new Error(`这个任务正在外部 Codex 中执行，当前不会切换。可使用 /status ${taskId} 查看进度。`);
    }
    if (!remote.cwd) throw new Error("这个 Codex 任务没有可用的工作目录，暂时无法切换。");
    const agentEntry = Object.entries(this.config.agents).find(([, agent]) => agent.kind === "codex");
    if (!agentEntry) throw new Error("未配置 Codex Agent。");
    const [agentName] = agentEntry;
    const localSessionId = createId("sess");
    this.store.createSession({
      localSessionId,
      contextKey,
      agentName,
      cwd: remote.cwd,
      status: "ready",
    });
    this.store.updateRuntimeSession(localSessionId, {
      runtimeKind: "codex",
      remoteSessionId: remote.id,
      title: remote.title ?? remote.preview,
      permissionMode: "auto",
      lastTurnId: remote.lastTurnId,
      lastTurnStatus: mapRemoteTurnStatus(remote.lastTurnStatus),
    });
    this.store.setCurrentSession(contextKey, localSessionId);
    this.outbound.registerSession(localSessionId, contextKey, remote.title ?? remote.preview);
    await this.outbound.sendText(
      contextKey,
      `已切换到任务：${remote.title ?? remote.preview ?? remote.id}。历史消息不会重新发送。`,
    );
  }

  private async stopSessionReference(contextKey: string, taskId: string): Promise<void> {
    const direct = this.store.getSession(taskId);
    if (direct) {
      if (direct.contextKey !== contextKey || direct.status === "closed") throw new Error(`找不到任务：${taskId}`);
      await this.cancelSession(direct);
      return;
    }

    const existing = this.store.findSessionByRemoteSessionId(taskId);
    if (existing?.contextKey === contextKey && existing.status !== "closed") {
      await this.cancelSession(existing);
      return;
    }

    const runtime = this.runtimes.get("codex");
    if (!runtime.readRemoteSession || !runtime.interruptRemoteTurn) {
      throw new Error("当前 Codex 运行时不支持停止外部任务。");
    }
    const remote = await runtime.readRemoteSession(taskId);
    const turnId = remote.status === "active" || remote.lastTurnStatus === "inProgress"
      ? remote.lastTurnId
      : undefined;
    if (!turnId) {
      await this.outbound.sendText(contextKey, "当前没有正在执行的任务。");
      return;
    }
    await runtime.interruptRemoteTurn(remote.id, turnId);
    this.store.audit(contextKey, "turn_interrupt_sent", {
      remoteSessionId: remote.id,
      turnId,
      source: "sessions_card",
    });
    await this.outbound.sendText(contextKey, `已向 Codex 发送 Interrupt 请求：${turnId}`);
  }

  private resolveSessionReference(contextKey: string, reference?: string): string {
    if (reference === undefined) {
      const previous = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!).previousSessionId;
      if (!previous) throw new Error("没有可切换的上一个任务。请先使用 /new 创建任务，或使用 /switch <序号或任务 ID> 切换任务。");
      return previous;
    }
    if (!/^\d+$/.test(reference)) return reference;
    const position = Number(reference);
    const listing = this.lastSessionListings.get(contextKey);
    if (!listing) throw new Error("请先发送 /sessions 获取任务列表，再使用 /switch <序号>。");
    if (!Number.isSafeInteger(position) || position < 1 || position > listing.length) {
      throw new Error(`任务序号超出范围：${reference}。当前列表共有 ${listing.length} 项，请重新发送 /sessions。`);
    }
    return listing[position - 1]!;
  }

  private async assertSessionTurnOwnership(record: SessionRecord, runtime: AgentRuntime): Promise<void> {
    if (runtime.kind !== "codex" || !record.remoteSessionId || !runtime.readRemoteSession) return;
    let remote: RemoteSessionSummary;
    try {
      remote = await runtime.readRemoteSession(record.remoteSessionId);
    } catch (error) {
      // Codex does not materialize a new thread until its first user message.
      // Such a thread has no turn to take over, so allow turn/start to create it.
      if (!record.lastTurnId && isUnmaterializedCodexThreadError(error)) return;
      throw error;
    }
    const botOwnsActiveTurn = isBotOwnedActiveTurn(record, remote);
    if ((remote.status === "active" || remote.lastTurnStatus === "inProgress") && !botOwnsActiveTurn) {
      throw new Error("这个任务正在外部 Codex 中执行。acp-bot 不会接管或追加消息，请等待外部执行完成。");
    }
  }

  private async setDefaultAgent(contextKey: string, agentName: string): Promise<void> {
    this.ensureAgent(agentName);
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    this.store.setDefaultAgent(contextKey, agentName);
    await this.outbound.sendText(contextKey, `默认 agent 已切换为：${agentName}`);
  }

  private async status(contextKey: string, sessionId?: string): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const targetSessionId = sessionId === undefined ? undefined : this.resolveSessionReference(contextKey, sessionId);
    let current: SessionRecord | undefined;
    if (targetSessionId) {
      current = this.store.getSession(targetSessionId) ?? this.store.findSessionByRemoteSessionId(targetSessionId);
      if (current && current.contextKey !== contextKey) throw new Error(`找不到任务：${targetSessionId}`);
      if (!current) {
        await this.statusForCodexTask(contextKey, targetSessionId);
        return;
      }
    } else {
      current = context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
    }

    if (current && current.status === "running") {
      try {
        const runtime = this.runtimes.forAgent(this.ensureAgent(current.agentName));
        if (runtime.getSession(current.localSessionId)) {
          await runtime.synchronizeSession(current.localSessionId);
          current = this.store.getSession(current.localSessionId) ?? current;
        }
      } catch (error) {
        this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to synchronize task status.");
      }
    }

    let remote: RemoteSessionSummary | undefined;
    if (current?.remoteSessionId) {
      const runtime = this.runtimes.forAgent(this.ensureAgent(current.agentName));
      if (runtime.readRemoteSession) {
        try {
          remote = await runtime.readRemoteSession(current.remoteSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to inspect Codex task status.");
        }
      }
    }

    const sessions = this.store.listSessions(contextKey);
    const taskLines: string[] = [];
    let snapshot: TurnViewState | undefined;
    let activeTurnId: string | undefined;
    let queued = 0;
    if (!current) {
      taskLines.push("无。直接发送消息即可创建一个未指定项目的 Codex 任务。");
    } else {
      const agent = this.ensureAgent(current.agentName);
      const runtimeSession = this.runtimes.forAgent(agent).getSession(current.localSessionId);
      activeTurnId = runtimeSession?.activeTurnId;
      const remoteActive = isRemoteSessionActive(remote);
      activeTurnId = remoteActive ? remote?.lastTurnId ?? activeTurnId : activeTurnId;
      queued = this.queuedPrompts.get(current.localSessionId)?.length ?? 0;
      snapshot = turnViewSnapshot(current.lastTurnId ? this.store.getTurnSnapshot(current.lastTurnId) : undefined);
      taskLines.push(
        `**标题**：${cardText(current.title ?? "未命名任务")}`,
        `**状态**：${remoteActive && remote && !isBotOwnedActiveTurn(current, remote)
          ? "外部执行中"
          : sessionStatusLabel(current.status, activeTurnId)}`,
        `**Agent / 运行时**：${cardText(agent.title)} / ${cardText(current.runtimeKind ?? agent.kind)}`,
        `**模型 / 思考强度**：${cardText(current.model ?? "默认")} / ${cardText(current.reasoningEffort ?? "自动")}`,
        `**权限模式**：${current.permissionMode === "confirm" ? "执行前确认" : "自动执行"}`,
        `**任务范围**：${detectProjectlessWorkspace(current.cwd) ? "未指定项目" : "指定项目"}`,
        `**工作目录**：${cardText(current.cwd)}`,
        `**Codex 任务 ID**：${cardText(current.remoteSessionId ?? "尚未创建")}`,
        `**当前执行**：${activeTurnId ? cardText(activeTurnId) : "无"}　**排队消息**：${queued} 条`,
        `**最近结果**：${remoteActive ? "执行中" : remoteTurnStatusLabel(remote?.lastTurnStatus ?? current.lastTurnStatus)}`,
        `**创建 / 更新**：${formatStatusTime(current.createdAt)} / ${formatStatusTime(current.updatedAt)}`,
      );
    }

    const sections: CardSection[] = [
      { title: targetSessionId ? "指定任务" : "当前任务", lines: taskLines },
      ...(current ? [{
        title: "执行详情",
        lines: executionDetailLines(current, snapshot, remote, activeTurnId, queued),
      }] : []),
      ...(current ? [{
        title: "最终结果",
        lines: finalResultLines(snapshot, remote),
      }] : []),
      {
        title: "acp-bot",
        lines: [
          `**默认 Agent**：${cardText(context.defaultAgent)}`,
          `**保活机制**：${this.lifecycle?.supervised ? "已启用（异常退出自动重启）" : "未启用"}`,
          `**任务统计**：${sessionStats(sessions)}`,
          "**交互方式**：普通消息继续当前任务；/new 创建新任务；/help 查看命令。",
        ],
      },
    ];
    const title = targetSessionId && current
      ? `Codex 状态：${truncateText((current.title ?? current.remoteSessionId ?? current.localSessionId).replace(/\s+/g, " "), 40)}`
      : "Codex 状态";
    await this.outbound.sendInteractiveCard(contextKey, this.cardRenderer.renderSectionsCard(title, sections));
  }

  private async statusForCodexTask(contextKey: string, remoteSessionId: string): Promise<void> {
    const runtime = this.runtimes.get("codex");
    if (!runtime.readRemoteSession) throw new Error("当前 Codex 运行时不支持读取外部任务状态。");
    const remote = await runtime.readRemoteSession(remoteSessionId);
    const sections: CardSection[] = [
      {
        title: "指定任务",
        lines: [
          `**标题**：${cardText(remote.title ?? remote.preview ?? "未命名任务")}`,
          `**状态**：${remoteSessionDetailStatus(remote)}`,
          "**当前任务**：未切换",
          `**工作目录**：${cardText(remote.cwd || "目录未知")}`,
          `**Codex 任务 ID**：${cardText(remote.id)}`,
          `**最近回合**：${cardText(remote.lastTurnId ?? "无")}　${remoteTurnStatusLabel(remote.lastTurnStatus)}`,
          `**更新时间**：${formatRemoteTime(remote.updatedAt)}`,
        ],
      },
      {
        title: "执行详情",
        lines: [
          `**当前 / 最后步骤**：${statusExcerpt(remote.lastActivity ?? remoteStatusStep(remote), 500)}`,
          isRemoteSessionActive(remote)
            ? "外部 Codex 正在执行；acp-bot 只读取状态，不会接管。"
            : `发送 **/switch ${cardText(remote.id)}** 切换到此任务。`,
        ],
      },
      { title: "最终结果", lines: finalResultLines(undefined, remote) },
    ];
    const title = `Codex 状态：${truncateText((remote.title ?? remote.preview ?? remote.id).replace(/\s+/g, " "), 40)}`;
    await this.outbound.sendInteractiveCard(contextKey, this.cardRenderer.renderSectionsCard(title, sections));
  }

  private async help(contextKey: string): Promise<void> {
    const sections: CardSection[] = [
      {
        lines: [
          "直接发送消息即可继续当前任务；执行中发送的新消息会追加到本次任务。",
          "**[参数]** 可选　**&#60;参数&#62;** 必填",
        ],
      },
      {
        title: "任务管理",
        lines: [
          "**/new [cwd]**　使用默认 Agent 创建任务；省略目录时继承当前项目形态",
          "**/sessions [关键词]**　查找本机任务",
          "**/switch [序号或任务 ID]**　不填参数切回上一个任务",
        ],
      },
      {
        title: "执行设置",
        lines: [
          "**/stop**　停止当前执行",
          "**/model [name]**　查看或切换模型",
          "**/thinking [level]**　查看或设置思考强度",
          "**/permissions [auto|confirm]**　查看或切换确认模式",
        ],
      },
      {
        title: "Agent",
        lines: [
          "**/agent [name]**　查看或设置新任务的默认 Agent",
        ],
      },
      {
        title: "系统",
        lines: [
          "**/status [序号或任务 ID]**　查看当前或指定任务的详细状态",
          "**/restart**　重启 acp-bot 并恢复会话",
          "**/help**　显示本帮助",
        ],
      },
    ];
    await this.outbound.sendInteractiveCard(contextKey, this.cardRenderer.renderSectionsCard("Codex 使用帮助", sections));
  }

  private ensureAgent(agentName: string) {
    const agent = this.config.agents[agentName];
    if (!agent) throw new Error(`未知 agent：${agentName}`);
    return agent;
  }

  private isCodexSession(session: SessionRecord): boolean {
    if (session.runtimeKind) return session.runtimeKind === "codex";
    return this.config.agents[session.agentName]?.kind === "codex";
  }

  private currentSession(contextKey: string): SessionRecord | undefined {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    return context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
  }

  private inheritedNewTaskCwd(contextKey: string): string | undefined {
    const current = this.currentSession(contextKey);
    if (!current) return undefined;
    return detectProjectlessWorkspace(current.cwd)
      ? createProjectlessWorkspace().cwd
      : current.cwd;
  }

  private requireCurrentSession(contextKey: string): SessionRecord {
    const record = this.currentSession(contextKey);
    if (!record) throw new Error("当前没有任务，直接发送一条消息即可自动创建。");
    return record;
  }

  private requireSession(contextKey: string, sessionId: string): SessionRecord {
    const record = this.store.getSession(sessionId);
    if (!record || record.contextKey !== contextKey) throw new Error(`找不到任务：${sessionId}`);
    return record;
  }

  private async sendError(contextKey: string, error: unknown): Promise<void> {
    this.logger.warn({ error, contextKey }, "Request failed.");
    await this.outbound.sendText(contextKey, error instanceof Error ? error.message : String(error));
  }
}

function sessionStatusLabel(status: SessionRecord["status"], activeTurnId?: string): string {
  if (activeTurnId || status === "running") return "执行中";
  const labels: Record<SessionRecord["status"], string> = {
    starting: "正在启动",
    ready: "就绪",
    running: "执行中",
    closed: "已关闭",
    failed: "异常",
  };
  return labels[status];
}

interface UnifiedTaskListEntry {
  id: string;
  title: string;
  cwd: string;
  status: string;
  active: boolean;
  current: boolean;
  updatedAt: number;
  updatedLabel: string;
}

function mergeTaskList(
  localSessions: SessionRecord[],
  remoteSessions: RemoteSessionSummary[],
  currentLocalSessionId?: string,
): UnifiedTaskListEntry[] {
  const localByRemoteId = new Map(
    localSessions
      .filter((session) => session.runtimeKind === "codex" && session.remoteSessionId)
      .map((session) => [session.remoteSessionId!, session]),
  );
  const representedLocalIds = new Set<string>();
  const entries = remoteSessions.map((remote): UnifiedTaskListEntry => {
    const local = localByRemoteId.get(remote.id);
    if (local) representedLocalIds.add(local.localSessionId);
    const active = remote.status === "active" || remote.lastTurnStatus === "inProgress";
    const status = remote.status === "active" || remote.lastTurnStatus === "inProgress"
      ? local && isBotOwnedActiveTurn(local, remote) ? "执行中" : "外部执行中"
      : remoteSessionStatusLabel(remote.status);
    return {
      id: remote.id,
      title: remote.title ?? remote.preview ?? local?.title ?? "未命名任务",
      cwd: remote.cwd || local?.cwd || "",
      status,
      active,
      current: Boolean(local && local.localSessionId === currentLocalSessionId),
      updatedAt: (remote.updatedAt ?? 0) * 1_000,
      updatedLabel: formatRemoteTime(remote.updatedAt),
    };
  });

  for (const local of localSessions) {
    if (representedLocalIds.has(local.localSessionId)) continue;
    const updatedAt = Date.parse(local.updatedAt);
    entries.push({
      id: local.remoteSessionId ?? local.localSessionId,
      title: local.title ?? "未命名任务",
      cwd: local.cwd,
      status: sessionStatusLabel(local.status),
      active: local.status === "running",
      current: local.localSessionId === currentLocalSessionId,
      updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
      updatedLabel: formatStatusTime(local.updatedAt),
    });
  }
  return entries;
}

function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found|rollout[^\n]*(?:not found|missing)|thread\/resume failed/i.test(message);
}

function isUnmaterializedCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread\/read failed:[^\n]*(?:not materialized|not loaded|includeTurns is unavailable before first user message)/i.test(message);
}

function turnViewSnapshot(value: unknown): TurnViewState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TurnViewState>;
  return typeof candidate.turnId === "string" && typeof candidate.status === "string"
    ? candidate as TurnViewState
    : undefined;
}

function executionDetailLines(
  record: SessionRecord,
  snapshot: TurnViewState | undefined,
  remote: RemoteSessionSummary | undefined,
  activeTurnId: string | undefined,
  queued: number,
): string[] {
  const remoteActive = isRemoteSessionActive(remote);
  const turnId = remoteActive
    ? remote?.lastTurnId ?? activeTurnId
    : activeTurnId ?? snapshot?.turnId ?? remote?.lastTurnId ?? record.lastTurnId;
  if (!turnId) return ["尚无执行记录。"];
  const relevantSnapshot = snapshot?.turnId === turnId ? snapshot : undefined;
  const externallyActive = Boolean(remoteActive && remote && !isBotOwnedActiveTurn(record, remote));
  const lines = [
    `**回合 ID**：${cardText(turnId)}`,
    `**执行状态**：${externallyActive ? "外部执行中" : relevantSnapshot ? turnViewStatusLabel(relevantSnapshot.status) : remoteTurnStatusLabel(remote?.lastTurnStatus ?? remoteStatusToTurnStatus(remote?.status) ?? record.lastTurnStatus)}`,
    `**当前 / 最后步骤**：${statusExcerpt(currentOrLastStep(relevantSnapshot, remote), 600)}`,
  ];

  if (relevantSnapshot) {
    const lastTool = [...(relevantSnapshot.activities ?? [])]
      .reverse()
      .find((activity): activity is Extract<TurnActivity, { kind: "tool" }> => activity.kind === "tool")?.tool;
    const tool = relevantSnapshot.activeTool ?? lastTool;
    lines.push(`**工具执行**：完成 ${relevantSnapshot.completedTools?.length ?? 0}，失败 ${relevantSnapshot.failedTools?.length ?? 0}${relevantSnapshot.activeTool ? "，当前 1" : ""}`);
    if (tool) lines.push(`**当前 / 最后工具**：${statusExcerpt(tool.title, 400)}（${toolStatusLabel(tool.status)}）`);
    if (relevantSnapshot.durationMs !== undefined) lines.push(`**耗时**：${formatDuration(relevantSnapshot.durationMs)}`);
  }
  if (queued > 0) lines.push(`**排队消息**：${queued} 条`);
  return lines;
}

function finalResultLines(snapshot?: TurnViewState, remote?: RemoteSessionSummary): string[] {
  if (snapshot?.status === "running" || snapshot?.status === "tool_running" || snapshot?.status === "waiting_for_approval"
    || isRemoteSessionActive(remote)) {
    return ["任务仍在执行，尚无最终结果。"];
  }
  const result = snapshot?.finalResponse?.trim() || remote?.finalResponse?.trim();
  if (result) return [statusExcerpt(result, 2_800)];
  const error = snapshot?.error?.trim() || remote?.lastError?.trim();
  if (error) return [`❌ ${statusExcerpt(error, 2_400)}`];
  if (snapshot?.status === "cancelled" || remote?.lastTurnStatus === "interrupted") {
    return ["任务已停止，未产生最终回答。"];
  }
  if (snapshot?.status === "failed" || remote?.lastTurnStatus === "failed") {
    return ["任务执行失败，未记录最终回答。"];
  }
  return ["没有保存到可展示的最终结果。"];
}

function currentOrLastStep(snapshot?: TurnViewState, remote?: RemoteSessionSummary): string {
  const snapshotActive = snapshot?.status === "running" || snapshot?.status === "tool_running" || snapshot?.status === "waiting_for_approval";
  if (isRemoteSessionActive(remote) && !snapshotActive) return remote?.lastActivity ?? remoteStatusStep(remote);
  if (snapshot?.approval) return `等待确认：${snapshot.approval.title}`;
  if (snapshot?.activeTool) return `正在执行：${snapshot.activeTool.title}`;
  const activePlan = snapshot?.plan?.find((step) => step.status === "in_progress");
  if (activePlan) return activePlan.text;
  const activity = [...(snapshot?.activities ?? [])].reverse().find((item) =>
    item.kind === "reasoning" ? Boolean(item.text.trim()) : true,
  );
  if (activity?.kind === "reasoning") return activity.text;
  if (activity?.kind === "tool") return `${toolStatusLabel(activity.tool.status)}：${activity.tool.title}`;
  if (snapshot?.progressText) return snapshot.progressText;
  if (remote?.lastActivity) return remote.lastActivity;
  return remoteStatusStep(remote);
}

function remoteStatusStep(remote?: RemoteSessionSummary): string {
  if (!remote) return "未记录执行步骤";
  if (isRemoteSessionActive(remote)) return "外部任务正在执行，实时步骤尚未同步到本进程";
  if (remote.lastTurnStatus === "completed") return "最近回合已完成";
  if (remote.lastTurnStatus === "interrupted") return "最近回合已停止";
  if (remote.lastTurnStatus === "failed") return "最近回合执行失败";
  return "尚无执行记录";
}

function remoteSessionDetailStatus(remote: RemoteSessionSummary): string {
  if (isRemoteSessionActive(remote)) return "🟢 外部执行中";
  return remoteSessionStatusLabel(remote.status);
}

function isRemoteSessionActive(remote?: RemoteSessionSummary): boolean {
  return remote?.status === "active" || remote?.lastTurnStatus === "inProgress";
}

function remoteTurnStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    inProgress: "执行中",
    completed: "已完成",
    interrupted: "已停止",
    failed: "失败",
    running: "执行中",
    cancelled: "已停止",
  };
  return status ? labels[status] ?? status : "尚无执行记录";
}

function remoteStatusToTurnStatus(status?: RemoteSessionSummary["status"]): string | undefined {
  if (status === "active") return "inProgress";
  if (status === "error") return "failed";
  return undefined;
}

function turnViewStatusLabel(status: TurnViewState["status"]): string {
  const labels: Record<TurnViewState["status"], string> = {
    starting: "正在启动",
    running: "执行中",
    tool_running: "工具执行中",
    waiting_for_approval: "等待确认",
    completed: "已完成",
    cancelled: "已停止",
    failed: "失败",
  };
  return labels[status];
}

function toolStatusLabel(status: "running" | "completed" | "failed"): string {
  return status === "running" ? "执行中" : status === "completed" ? "已完成" : "失败";
}

function statusExcerpt(value: string, maxLength: number): string {
  const clean = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return cardText(truncateMiddle(clean || "未记录", maxLength));
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function sessionStats(sessions: SessionRecord[]): string {
  if (sessions.length === 0) return "共 0 个";
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const label = sessionStatusLabel(session.status);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const details = [...counts].map(([label, count]) => `${label} ${count}`).join("，");
  return `共 ${sessions.length} 个（${details}）`;
}

function formatStatusTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function cardText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("`", "&#96;").replaceAll("<", "&#60;").replaceAll(">", "&#62;");
}

function remoteSessionStatusLabel(status: RemoteSessionSummary["status"]): string {
  const labels: Record<RemoteSessionSummary["status"], string> = {
    active: "执行中",
    idle: "空闲",
    not_loaded: "未加载",
    error: "异常",
  };
  return labels[status];
}

function formatRemoteTime(value?: number): string {
  if (value === undefined) return "时间未知";
  return formatStatusTime(new Date(value * 1_000).toISOString());
}

function mapRemoteTurnStatus(status?: RemoteSessionSummary["lastTurnStatus"]): string | undefined {
  if (status === "interrupted") return "cancelled";
  if (status === "inProgress") return "running";
  return status;
}

function isBotOwnedActiveTurn(record: SessionRecord, remote: RemoteSessionSummary): boolean {
  return record.status === "running"
    && record.lastTurnStatus === "running"
    && Boolean(record.lastTurnId)
    && record.lastTurnId === remote.lastTurnId;
}

function isQueueIndependentCommand(command: Command): boolean {
  if (["stop", "status", "restart", "help", "sessions"].includes(command.type)) return true;
  if (command.type === "agent") return command.agent === undefined;
  if (command.type === "model") return command.model === undefined;
  if (command.type === "thinking") return command.effort === undefined;
  if (command.type === "permissions") return command.mode === undefined;
  return false;
}

function parseSessionVisibleCount(value: unknown): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= SESSION_PAGE_SIZE ? parsed : SESSION_PAGE_SIZE;
}

function isPromptCommand(command: Command): boolean {
  return command.type === "ask" || command.type === "prompt";
}
