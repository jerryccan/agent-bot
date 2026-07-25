import path from "node:path";
import type { Logger } from "pino";
import { createProjectlessWorkspace, detectProjectlessWorkspace } from "../codex/ProjectlessWorkspace.js";
import type { AppConfig } from "../config/schema.js";
import { CommandRouter } from "../commands/CommandRouter.js";
import type { Command } from "../commands/commandTypes.js";
import { baseChatContextKey, isThreadContextKey } from "../feishu/contextKey.js";
import type {
  CardAction,
  ChatUpdatedEvent,
  IncomingMessage,
  MessageReplyTarget,
} from "../feishu/types.js";
import { CardRenderer, type CardSection, type TaskListCardAction } from "../feishu/CardRenderer.js";
import type { OutboundRouter } from "../presentation/OutboundRouter.js";
import type { TurnActivity, TurnViewState } from "../presentation/turnViewTypes.js";
import type { AgentRuntimeRegistry } from "../runtime/AgentRuntimeRegistry.js";
import type {
  AgentRuntime,
  ApprovalDecision,
  PermissionMode,
  RemoteSessionSummary,
  RuntimeGoal,
  RuntimeEvent,
  RuntimePrompt,
  RuntimeSession,
} from "../runtime/types.js";
import {
  StateStore,
  type MessageReactionRecord,
  type MessageReactionStatus,
  type QueuedPromptRecord,
  type SessionRecord,
} from "../state/StateStore.js";
import { createId } from "../utils/id.js";
import { asInlineCode, codeBlock, truncateMiddle, truncateText } from "../utils/markdown.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";
import {
  executeShellCommand,
  type ShellCommandResult,
} from "../utils/executeShellCommand.js";

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

interface SessionsCardOptions {
  updateMessageId?: string;
  forceSwitchTaskId?: string;
  visibleCount?: number;
}

interface StatusCardOptions {
  updateMessageId?: string;
  forceSwitchTaskId?: string;
}

interface ModelCardOptions {
  sessionId?: string;
  updateMessageId?: string;
}

interface ThinkingCardOptions extends ModelCardOptions {
  expectedModel?: string;
}

interface SessionExecutionSettings {
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
}

export interface ProxyLifecycle {
  supervised?: boolean;
  restart(contextKey: string): Promise<void>;
}

export type ShellCommandExecutor = (command: string, cwd: string) => Promise<ShellCommandResult>;

export class ProxySessionController {
  private readonly router = new CommandRouter();
  private readonly cardRenderer = new CardRenderer();
  private readonly messageQueues = new Map<string, Promise<void>>();
  private readonly sessionLoads = new Map<string, Promise<LoadedSession>>();
  private readonly queuedPromptStarts = new Map<string, Promise<void>>();
  private readonly queuedPromptCards = new Map<string, Map<string, string>>();
  private readonly queuedPromptCardWrites = new Map<string, Promise<void>>();
  private readonly lastSessionListings = new Map<string, string[]>();
  private readonly threadInitializations = new Map<string, Promise<void>>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly runtimes: AgentRuntimeRegistry,
    private readonly outbound: OutboundRouter,
    private readonly logger: Logger,
    private readonly lifecycle?: ProxyLifecycle,
    private readonly shellCommandExecutor: ShellCommandExecutor = executeShellCommand,
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
    this.restorePersistedQueuedPrompts();
    void this.restorePersistedMessageReactions().catch((error: unknown) => {
      this.logger.warn({ error }, "Failed to restore persisted message reaction statuses.");
    });
  }

  async onMessage(message: IncomingMessage): Promise<void> {
    if (message.chatId && message.chatType) {
      this.store.recordChatContext(baseChatContextKey(message.contextKey), message.chatType);
    }
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
    const replyTarget = message.replyInThread
      ? { messageId: message.messageId, replyInThread: true as const }
      : undefined;
    const imageCount = message.images?.length ?? 0;
    this.store.audit(message.contextKey, "incoming_message", {
      messageId: message.messageId,
      text: message.text,
      ...(imageCount > 0 ? { imageCount } : {}),
    });
    if (imageCount > 0 && message.chatId && message.chatType) {
      this.store.markChatActive(baseChatContextKey(message.contextKey));
    }
    let localImagePaths: string[] | undefined;
    if (imageCount > 0) {
      try {
        localImagePaths = await Promise.all(message.images!.map((image) =>
          this.outbound.downloadImage(message.contextKey, message.messageId, image.imageKey)));
      } catch (error) {
        await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
        await this.outbound.withReplyTarget(
          message.contextKey,
          replyTarget,
          () => this.sendError(message.contextKey, error),
        );
        return;
      }
    }
    let command: Command;
    try {
      command = imageCount > 0 && !message.text.trimStart().startsWith("/")
        ? { type: "prompt", text: message.text.trim() || "请分析这张图片。" }
        : this.router.parse(message.text);
    } catch (error) {
      await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
      await this.outbound.withReplyTarget(
        message.contextKey,
        replyTarget,
        () => this.sendError(message.contextKey, error),
      );
      return;
    }
    if (
      message.chatId
      && message.chatType
      && (
        command.type === "shell"
        || (command.type === "prompt" && !message.text.trimStart().startsWith("/"))
      )
    ) {
      this.store.markChatActive(baseChatContextKey(message.contextKey));
    }

    // Operational and read-only commands must remain available even if a prompt operation is slow.
    if (isQueueIndependentCommand(command)) {
      await this.outbound.withReplyTarget(message.contextKey, replyTarget, async () => {
        try {
          await this.ensureThreadFork(message);
          await this.execute(
            message.contextKey,
            command,
            message.messageId,
            replyTarget,
            localImagePaths,
            message.userId,
          );
          if (!isPromptCommand(command)) await this.finalizeStandaloneMessageReaction(message.messageId, "completed");
        } catch (error) {
          await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
          await this.sendError(message.contextKey, error);
        }
      });
      return;
    }

    const previous = this.messageQueues.get(message.contextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() =>
      this.outbound.withReplyTarget(message.contextKey, replyTarget, async () => {
        try {
          await this.ensureThreadFork(message);
          await this.execute(
            message.contextKey,
            command,
            message.messageId,
            replyTarget,
            localImagePaths,
            message.userId,
          );
          if (!isPromptCommand(command)) await this.finalizeStandaloneMessageReaction(message.messageId, "completed");
        } catch (error) {
          await this.finalizeStandaloneMessageReaction(message.messageId, "failed");
          await this.sendError(message.contextKey, error);
        }
      }),
    );
    this.messageQueues.set(message.contextKey, next);
    await next;
    if (this.messageQueues.get(message.contextKey) === next) this.messageQueues.delete(message.contextKey);
  }

  async onCardAction(action: CardAction): Promise<void> {
    if (!this.store.claimInboundEvent(action.actionId, "card_action")) return;
    const contextKey = this.cardActionContextKey(action);
    const scopedAction = contextKey === action.contextKey ? action : { ...action, contextKey };
    const replyTarget = isThreadContextKey(contextKey) && action.messageId
      ? { messageId: action.messageId, replyInThread: true as const }
      : undefined;

    await this.outbound.withReplyTarget(contextKey, replyTarget, async () => {
      try {
        const kind = String(scopedAction.value.action ?? "");
        if (kind === "turn_details") {
          await this.outbound.showDetails(contextKey, String(scopedAction.value.turnId ?? ""));
        } else if (kind === "activity_history") {
          const requestedPage = String(scopedAction.value.page ?? "0");
          const numericPage = Number(requestedPage);
          await this.outbound.showActivityPage(
            contextKey,
            String(scopedAction.value.turnId ?? ""),
            requestedPage === "latest" ? "latest" : Number.isFinite(numericPage) ? numericPage : 0,
            scopedAction.messageId,
          );
        } else if (kind === "turn_cancel") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.cancelSession(this.requireSession(contextKey, sessionId));
        } else if (kind === "queued_prompt_cancel") {
          await this.cancelQueuedPrompt(scopedAction);
        } else if (kind === "session_more") {
          await this.refreshSessionsCardFromAction(scopedAction, undefined, true);
        } else if (kind === "session_switch") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.switchSession(contextKey, sessionId);
          if (scopedAction.value.cardView === "status") await this.refreshStatusCardFromAction(scopedAction);
          else await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_fork") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.forkSessionReference(contextKey, sessionId);
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_new") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.createProjectSessionFromReference(contextKey, sessionId);
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_stop") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.stopSessionReference(contextKey, sessionId);
          if (scopedAction.value.cardView === "status") await this.refreshStatusCardFromAction(scopedAction, sessionId);
          else await this.refreshSessionsCardFromAction(scopedAction, sessionId);
        } else if (kind === "session_status") {
          await this.status(contextKey, String(scopedAction.value.sessionId ?? ""));
        } else if (kind === "session_status_refresh") {
          await this.refreshStatusCardFromAction(scopedAction);
        } else if (kind === "model_select") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          const model = String(scopedAction.value.model ?? "");
          await this.model(contextKey, model, {
            sessionId,
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "model_open") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.model(contextKey, undefined, {
            sessionId,
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "reasoning_select") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          const model = String(scopedAction.value.model ?? "");
          const effort = String(scopedAction.value.effort ?? "");
          await this.thinking(contextKey, effort, {
            sessionId,
            updateMessageId: scopedAction.messageId,
            expectedModel: model,
          });
        } else if (kind === "approval") {
          await this.resolveApproval(scopedAction);
        }
      } catch (error) {
        await this.sendError(contextKey, error);
      }
    });
  }

  async onChatUpdated(event: ChatUpdatedEvent): Promise<void> {
    const contextKey = `chat_id:${event.chatId}`;
    const previous = this.messageQueues.get(contextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.syncTaskTitleFromGroupName(contextKey, event));
    this.messageQueues.set(contextKey, next);
    try {
      await next;
    } finally {
      if (this.messageQueues.get(contextKey) === next) this.messageQueues.delete(contextKey);
    }
  }

  close(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
    this.lastSessionListings.clear();
    this.queuedPromptCards.clear();
    this.queuedPromptCardWrites.clear();
  }

  async controlStopTask(localSessionId: string): Promise<string> {
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`找不到任务：${localSessionId}`);
    await this.cancelSession(record);
    return `已请求停止任务：${record.title ?? record.remoteSessionId ?? record.localSessionId}`;
  }

  async controlGetTaskStatus(localSessionId: string): Promise<{
    session: SessionRecord;
    snapshot?: TurnViewState;
    remote?: RemoteSessionSummary;
  }> {
    const record = this.store.getSession(localSessionId);
    if (!record) throw new Error(`找不到任务：${localSessionId}`);
    let remote: RemoteSessionSummary | undefined;
    if (record.remoteSessionId) {
      const runtime = this.runtimes.forAgent(this.ensureAgent(record.agentName));
      if (runtime.readRemoteSession) {
        try {
          remote = await runtime.readRemoteSession(record.remoteSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: record.localSessionId }, "Failed to inspect Codex task status for CLI.");
        }
      }
    }
    const session = mergeRemoteTaskStatus(record, remote);
    const snapshot = session.lastTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(session.lastTurnId))
      : undefined;
    return { session, snapshot, remote };
  }

  async controlSetTaskTitle(localSessionId: string, title: string): Promise<string> {
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) throw new Error("任务标题不能为空。");
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`找不到任务：${localSessionId}`);
    const loaded = await this.loadSession(record);
    if (loaded.runtime.setTitle) await loaded.runtime.setTitle(record.localSessionId, normalizedTitle);
    else loaded.session.title = normalizedTitle;
    this.store.updateRuntimeSession(record.localSessionId, { title: normalizedTitle });
    this.outbound.updateSessionTitle(record.localSessionId, normalizedTitle);
    this.store.audit(record.contextKey, "session_title_changed", {
      localSessionId: record.localSessionId,
      title: normalizedTitle,
      source: "cli",
    });
    return `任务标题已修改为：${normalizedTitle}`;
  }

  async controlSendTaskPrompt(localSessionId: string, text: string): Promise<string> {
    const promptText = text.trim();
    if (!promptText) throw new Error("Prompt 不能为空。");
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`找不到任务：${localSessionId}`);
    const runtime = this.runtimes.forAgent(this.ensureAgent(record.agentName));
    const activeTurnId = runtime.getSession(localSessionId)?.activeTurnId;
    const routedContextKey = this.outbound.getSessionContextKey(localSessionId);
    const responseContextKey = (activeTurnId ? this.store.getTurnContextKey(activeTurnId) ?? routedContextKey : undefined)
      ?? (record.lastTurnId ? this.store.getTurnContextKey(record.lastTurnId) : undefined)
      ?? routedContextKey
      ?? record.contextKey;
    const lastSnapshot = record.lastTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(record.lastTurnId))
      : undefined;
    const activeSnapshot = activeTurnId
      ? turnViewSnapshot(this.store.getTurnSnapshot(activeTurnId))
      : undefined;
    const routedReplyTarget = this.outbound.getSessionReplyTarget(localSessionId);
    const existingReplyTarget = activeSnapshot?.replyTarget
      ?? (activeTurnId ? routedReplyTarget : undefined)
      ?? lastSnapshot?.replyTarget
      ?? routedReplyTarget;
    if (isThreadContextKey(responseContextKey) && !existingReplyTarget) {
      throw new Error("无法确定目标任务的话题回复位置，未发送 Prompt。");
    }
    const scopedRecord = this.store.getSessionForContext(localSessionId, responseContextKey)
      ?? { ...record, contextKey: responseContextKey };
    const previous = this.messageQueues.get(responseContextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      this.outbound.registerSession(
        scopedRecord.localSessionId,
        responseContextKey,
        scopedRecord.title,
        scopedRecord.cwd,
      );
      const promptMessageId = await this.outbound.withReplyTarget(
        responseContextKey,
        existingReplyTarget,
        () => this.outbound.sendText(responseContextKey, promptText),
      );
      const turnReplyTarget = isThreadContextKey(responseContextKey)
        ? promptMessageId
          ? { messageId: promptMessageId, replyInThread: true as const }
          : existingReplyTarget
        : undefined;
      await this.promptSession(scopedRecord, responseContextKey, promptText, undefined, turnReplyTarget);
      this.store.audit(responseContextKey, "task_prompt_sent", {
        localSessionId,
        source: "cli",
      });
    });
    this.messageQueues.set(responseContextKey, next);
    try {
      await next;
    } finally {
      if (this.messageQueues.get(responseContextKey) === next) this.messageQueues.delete(responseContextKey);
    }
    return `已通过机器人向原会话发送 Prompt，并提交给任务：${record.title ?? record.remoteSessionId ?? record.localSessionId}`;
  }

  private cardActionContextKey(action: CardAction): string {
    const explicit = typeof action.value.contextKey === "string" ? action.value.contextKey : undefined;
    if (explicit && baseChatContextKey(explicit) === baseChatContextKey(action.contextKey)) return explicit;

    const sessionReference = typeof action.value.sessionId === "string" ? action.value.sessionId : undefined;
    const session = sessionReference
      ? this.store.getSession(sessionReference) ?? this.store.findSessionByRemoteSessionId(sessionReference)
      : undefined;
    if (session && baseChatContextKey(session.contextKey) === baseChatContextKey(action.contextKey)) {
      return session.contextKey;
    }

    const turnId = typeof action.value.turnId === "string" ? action.value.turnId : undefined;
    const snapshot = turnId ? turnViewSnapshot(this.store.getTurnSnapshot(turnId)) : undefined;
    const turnSession = snapshot ? this.store.getSession(snapshot.sessionId) : undefined;
    return turnSession && baseChatContextKey(turnSession.contextKey) === baseChatContextKey(action.contextKey)
      ? turnSession.contextKey
      : action.contextKey;
  }

  private async execute(
    contextKey: string,
    command: Command,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
    userId?: string,
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    switch (command.type) {
      case "shell":
        await this.runShellCommand(contextKey, command.command);
        return;
      case "new":
        if (command.projectless && this.ensureAgent(context.defaultAgent).kind !== "codex") {
          throw new Error("/new --nodir 仅支持 Codex Agent。");
        }
        await this.createSession(
          contextKey,
          context.defaultAgent,
          command.projectless ? undefined : command.cwd ?? this.inheritedNewTaskCwd(contextKey),
          true,
          false,
          undefined,
          undefined,
          command.title,
        );
        return;
      case "newgroup":
        await this.createFeishuGroup(
          contextKey,
          context.defaultAgent,
          command.title,
          userId,
        );
        return;
      case "fork":
        await this.forkSessionReference(contextKey, command.sessionId);
        return;
      case "title":
        await this.setTitle(contextKey, command.title);
        return;
      case "ask":
      case "prompt":
        await this.prompt(contextKey, command.text, messageId, replyTarget, localImagePaths);
        return;
      case "nosteer":
        await this.enqueueNoSteerPrompt(contextKey, command.text, messageId, replyTarget);
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
      case "goal":
        await this.goal(contextKey, command);
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
      const session = this.store.getSessionForContext(context.currentSessionId, context.contextKey);
      if (!session || session.status === "closed") continue;
      const turnContextKey = session.lastTurnId
        ? this.store.getTurnContextKey(session.lastTurnId) ?? context.contextKey
        : context.contextKey;
      this.outbound.registerSession(session.localSessionId, turnContextKey, session.title, session.cwd);
      if (!session.lastTurnId) continue;
      void this.outbound.resumeDelivery(session.localSessionId, turnContextKey, session.lastTurnId).catch((error: unknown) => {
        this.logger.warn({ error, sessionId: session.localSessionId }, "Failed to restore persisted turn delivery.");
      });
    }
  }

  private restorePersistedQueuedPrompts(): void {
    for (const sessionId of this.store.listQueuedPromptSessionIds()) {
      void this.scheduleNextQueuedPrompt(sessionId).catch((error: unknown) => {
        this.logger.warn({ error, sessionId }, "Failed to resume a persisted prompt queue.");
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

  private async prompt(
    contextKey: string,
    text: string,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
  ): Promise<void> {
    if (!text.trim()) throw new Error("请输入要交给 Codex 的内容。");
    let record = this.currentSession(contextKey);
    if (!record) {
      const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
      record = await this.createSession(
        contextKey,
        context.defaultAgent,
        this.inheritedNewTaskCwd(contextKey),
        false,
        true,
        text,
        replyTarget,
      );
    }
    await this.promptSession(record, contextKey, text, messageId, replyTarget, localImagePaths);
  }

  private async promptSession(
    record: SessionRecord,
    contextKey: string,
    text: string,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
  ): Promise<void> {
    const configuredRuntime = this.runtimes.forAgent(this.ensureAgent(record.agentName));
    if (!configuredRuntime.getSession(record.localSessionId)) {
      this.outbound.registerSession(record.localSessionId, contextKey, record.title, record.cwd);
      await this.outbound.startPendingTurn(record.localSessionId, contextKey, record.title, replyTarget);
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
      const activeContextKey = this.store.getTurnContextKey(activeTurnId);
      if (activeContextKey && activeContextKey !== contextKey) {
        this.persistQueuedPrompt(record.localSessionId, contextKey, text, {
          localImagePaths,
          messageId,
          replyTarget,
        });
        return;
      }
      try {
        await loaded.runtime.steerTurn(record.localSessionId, activeTurnId, runtimePrompt(text, localImagePaths));
        await this.presentSteerMessage(record.localSessionId, activeTurnId, text, messageId);
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
          const turnId = await this.startTurn(loaded, text, replyTarget, localImagePaths);
          if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, turnId);
          return;
        }
        if (current.activeTurnId !== activeTurnId) {
          try {
            await loaded.runtime.steerTurn(
              record.localSessionId,
              current.activeTurnId,
              runtimePrompt(text, localImagePaths),
            );
            await this.presentSteerMessage(record.localSessionId, current.activeTurnId, text, messageId);
            if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, current.activeTurnId);
            return;
          } catch (retryError) {
            this.logger.warn(
              { error: retryError, sessionId: record.localSessionId, activeTurnId: current.activeTurnId },
              "Failed to steer the reconciled Codex turn; queueing prompt.",
            );
          }
        }
        this.persistQueuedPrompt(record.localSessionId, contextKey, text, {
          localImagePaths,
          messageId,
          replyTarget,
        });
        return;
      }
    }
    const turnId = await this.startTurn(loaded, text, replyTarget, localImagePaths);
    if (messageId) await this.bindMessageReactionToTurn(messageId, record.localSessionId, turnId);
  }

  private async presentSteerMessage(
    localSessionId: string,
    turnId: string,
    text: string,
    messageId?: string,
  ): Promise<void> {
    try {
      await this.outbound.appendSteerMessage(localSessionId, turnId, text, messageId);
    } catch (error) {
      this.logger.warn(
        { error, sessionId: localSessionId, turnId, messageId },
        "Failed to insert a steer message into the thinking card.",
      );
    }
  }

  private async enqueueNoSteerPrompt(
    contextKey: string,
    text: string,
    messageId?: string,
    replyTarget?: MessageReplyTarget,
  ): Promise<void> {
    const record = this.requireCurrentSession(contextKey);
    const queued = this.persistQueuedPrompt(record.localSessionId, contextKey, text, { messageId, replyTarget });
    this.store.audit(contextKey, "queued_prompt_added", {
      promptId: queued.promptId,
      localSessionId: record.localSessionId,
    });
    await this.presentPromptQueueCard(record.localSessionId, contextKey);
    await this.scheduleNextQueuedPrompt(record.localSessionId);
  }

  private persistQueuedPrompt(
    localSessionId: string,
    contextKey: string,
    text: string,
    options: {
      localImagePaths?: string[];
      messageId?: string;
      replyTarget?: MessageReplyTarget;
    } = {},
  ): QueuedPromptRecord {
    return this.store.enqueuePrompt({
      promptId: createId("prompt"),
      localSessionId,
      contextKey,
      text,
      localImagePaths: options.localImagePaths,
      messageId: options.messageId,
      replyMessageId: options.replyTarget?.messageId,
    });
  }

  private async cancelQueuedPrompt(action: CardAction): Promise<void> {
    const promptId = String(action.value.promptId ?? "");
    const sessionId = String(action.value.sessionId ?? "");
    if (!promptId || !sessionId) throw new Error("无效的排队 Prompt 取消请求。");
    this.requireSession(action.contextKey, sessionId);
    if (action.messageId) this.rememberPromptQueueCard(sessionId, action.contextKey, action.messageId);
    const cancelled = this.store.cancelQueuedPrompt(promptId, sessionId);
    if (cancelled?.messageId) await this.finalizeStandaloneMessageReaction(cancelled.messageId, "cancelled");
    if (cancelled) {
      this.store.audit(action.contextKey, "queued_prompt_cancelled", {
        promptId,
        localSessionId: sessionId,
      });
    }
    await this.refreshPromptQueueCards(sessionId);
  }

  private async presentPromptQueueCard(localSessionId: string, contextKey: string): Promise<void> {
    await this.serializePromptQueueCardWrite(localSessionId, async () => {
      const card = this.renderPromptQueueCard(localSessionId, contextKey);
      const existing = this.queuedPromptCards.get(localSessionId)?.get(contextKey);
      if (existing) {
        try {
          await this.outbound.updateInteractiveCard(contextKey, existing, card);
          return;
        } catch (error) {
          this.logger.warn({ error, localSessionId, contextKey, messageId: existing }, "Failed to update prompt queue card; sending a replacement.");
        }
      }
      const messageId = await this.outbound.sendInteractiveCard(contextKey, card);
      if (messageId) this.rememberPromptQueueCard(localSessionId, contextKey, messageId);
    });
  }

  private async refreshPromptQueueCards(localSessionId: string): Promise<void> {
    await this.serializePromptQueueCardWrite(localSessionId, async () => {
      const cards = this.queuedPromptCards.get(localSessionId);
      if (!cards) return;
      await Promise.all([...cards].map(async ([contextKey, messageId]) => {
        try {
          await this.outbound.updateInteractiveCard(
            contextKey,
            messageId,
            this.renderPromptQueueCard(localSessionId, contextKey),
          );
        } catch (error) {
          this.logger.warn({ error, localSessionId, contextKey, messageId }, "Failed to refresh prompt queue card.");
        }
      }));
    });
  }

  private renderPromptQueueCard(localSessionId: string, contextKey: string): Record<string, unknown> {
    return this.cardRenderer.renderPromptQueue({
      sessionId: localSessionId,
      contextKey,
      prompts: this.store.listQueuedPrompts(localSessionId).map((prompt) => ({
        id: prompt.promptId,
        text: prompt.text,
      })),
    });
  }

  private rememberPromptQueueCard(localSessionId: string, contextKey: string, messageId: string): void {
    const cards = this.queuedPromptCards.get(localSessionId) ?? new Map<string, string>();
    cards.set(contextKey, messageId);
    this.queuedPromptCards.set(localSessionId, cards);
  }

  private serializePromptQueueCardWrite(localSessionId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.queuedPromptCardWrites.get(localSessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    this.queuedPromptCardWrites.set(localSessionId, next);
    return next.finally(() => {
      if (this.queuedPromptCardWrites.get(localSessionId) === next) this.queuedPromptCardWrites.delete(localSessionId);
    });
  }

  private async ensureThreadFork(message: IncomingMessage): Promise<void> {
    if (!message.threadContext || !message.threadId || !message.chatId) return;
    const current = this.store.getUserContext(message.contextKey)?.currentSessionId;
    if (current && this.store.getSession(current)) return;

    const existing = this.threadInitializations.get(message.contextKey);
    if (existing) return existing;
    const initialization = this.forkThreadSession(message);
    this.threadInitializations.set(message.contextKey, initialization);
    try {
      await initialization;
    } finally {
      if (this.threadInitializations.get(message.contextKey) === initialization) {
        this.threadInitializations.delete(message.contextKey);
      }
    }
  }

  private async forkThreadSession(message: IncomingMessage): Promise<void> {
    const anchorMessageIds = [message.rootMessageId, message.parentMessageId]
      .filter((messageId): messageId is string => Boolean(messageId && messageId !== message.messageId));
    const anchor = [...new Set(anchorMessageIds)]
      .map((messageId) => this.store.findTurnAnchorByMessageId(messageId))
      .find((candidate) => candidate !== undefined);
    if (!anchor) {
      throw new Error("无法确定这个话题对应的 Codex 轮次，因此没有创建分支任务。请从该轮的用户消息、思考卡片或最终回答创建话题。");
    }

    const source = anchor.contextKey
      ? this.store.getSessionForContext(anchor.localSessionId, anchor.contextKey)
      : this.store.getSession(anchor.localSessionId);
    if (!source || !source.remoteSessionId || !this.isCodexSession(source)) {
      throw new Error("这个话题的来源不是可 fork 的 Codex 任务。");
    }
    if (baseChatContextKey(anchor.contextKey ?? source.contextKey) !== `chat_id:${message.chatId}`) {
      throw new Error("话题来源任务不属于当前会话，已拒绝创建分支。");
    }

    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(anchor.turnId));
    if (isTurnStillRunning(snapshot?.status)
      || (source.lastTurnId === anchor.turnId && source.lastTurnStatus === "running")) {
      throw new Error("话题对应的轮次仍在执行，Codex 暂时不能从这一轮 fork。请等待该轮完成后再在话题中发送消息。");
    }

    const agent = this.ensureAgent(source.agentName);
    const runtime = this.runtimes.forAgent(agent);
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 Codex 运行时不支持 fork 任务。");
    }

    const context = this.store.getOrCreateUserContext(message.contextKey, source.agentName);
    if (context.currentSessionId && this.store.getSession(context.currentSessionId)) return;

    const forkTitle = this.store.nextForkTitle(source.title);
    const localSessionId = createId("sess");
    const record = this.store.createSession({
      localSessionId,
      contextKey: message.contextKey,
      agentName: source.agentName,
      cwd: source.cwd,
      status: "starting",
    });
    this.store.updateRuntimeSession(localSessionId, {
      runtimeKind: "codex",
      title: forkTitle,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      permissionMode: source.permissionMode ?? "auto",
    });
    this.store.setCurrentSession(message.contextKey, localSessionId);
    this.outbound.registerSession(localSessionId, message.contextKey, forkTitle, source.cwd);

    try {
      const forked = await runtime.forkSession({
        localSessionId,
        remoteSessionId: source.remoteSessionId,
        lastTurnId: anchor.turnId,
        agentName: source.agentName,
        cwd: source.cwd,
        title: forkTitle,
        model: source.model,
        reasoningEffort: source.reasoningEffort,
        permissionMode: source.permissionMode ?? "auto",
      });
      this.persistRuntimeSession(record, forked, "ready");
      this.store.updateRuntimeSession(localSessionId, {
        lastTurnId: anchor.turnId,
        lastTurnStatus: forkedTurnStatus(snapshot?.status),
      });
      this.store.audit(message.contextKey, "thread_forked", {
        threadId: message.threadId,
        sourceMessageId: message.rootMessageId ?? message.parentMessageId,
        sourceLocalSessionId: source.localSessionId,
        sourceRemoteSessionId: source.remoteSessionId,
        sourceTurnId: anchor.turnId,
        forkedLocalSessionId: localSessionId,
        forkedRemoteSessionId: forked.remoteSessionId,
      });
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      this.store.setCurrentSession(message.contextKey, undefined);
      this.outbound.unregisterSession(localSessionId);
      throw error;
    }
  }

  private async forkSessionReference(contextKey: string, reference?: string): Promise<void> {
    const sourceLabel = reference === undefined ? "当前任务" : "指定任务";
    const taskId = reference === undefined ? undefined : this.resolveSessionReference(contextKey, reference);
    let source: SessionRecord | undefined;
    if (taskId === undefined) {
      source = this.requireCurrentSession(contextKey);
    } else {
      const direct = this.store.getSession(taskId);
      if (direct?.status === "closed") {
        throw new Error(`找不到任务：${taskId}`);
      }
      const global = direct ?? this.store.findSessionByRemoteSessionId(taskId);
      source = global ? { ...global, contextKey } : undefined;
    }

    if (source && (!source.remoteSessionId || !this.isCodexSession(source))) {
      throw new Error(`${sourceLabel}不是可 fork 的 Codex 任务。`);
    }

    let runtime: AgentRuntime;
    let agentName: string;
    if (source) {
      agentName = source.agentName;
      runtime = this.runtimes.forAgent(this.ensureAgent(agentName));
    } else {
      const agentEntry = Object.entries(this.config.agents).find(([, agent]) => agent.kind === "codex");
      if (!agentEntry) throw new Error("未配置 Codex Agent。");
      [agentName] = agentEntry;
      runtime = this.runtimes.get("codex");
    }
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 Codex 运行时不支持 fork 任务。");
    }

    const remoteSessionId = source?.remoteSessionId ?? taskId;
    if (!remoteSessionId) throw new Error("当前任务尚未创建 Codex 任务 ID，暂时不能 fork。");
    if (!runtime.readRemoteSession && !source) {
      throw new Error("当前 Codex 运行时不支持读取指定任务。");
    }
    const remote = runtime.readRemoteSession
      ? await runtime.readRemoteSession(remoteSessionId)
      : undefined;
    const latestTurnId = remote?.lastTurnId ?? source?.lastTurnId;
    const latestSnapshot = turnViewSnapshot(latestTurnId ? this.store.getTurnSnapshot(latestTurnId) : undefined);
    const isRunning = remote
      ? isRemoteSessionActive(remote)
      : Boolean(
        (source && runtime.getSession(source.localSessionId)?.activeTurnId)
        || source?.lastTurnStatus === "running"
        || isTurnStillRunning(latestSnapshot?.status),
      );
    const lastTurnId = isRunning ? remote?.lastCompletedTurnId : latestTurnId;
    if (!lastTurnId) {
      if (isRunning) {
        throw new Error(`${sourceLabel}正在执行，且还没有已完成轮次可供 fork。请等待当前轮次完成后重试。`);
      }
      throw new Error(`${sourceLabel}还没有可供 fork 的轮次。请先完成至少一轮对话。`);
    }
    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(lastTurnId));
    const forkedFromHistoricalTurn = isRunning && lastTurnId !== latestTurnId;

    const cwd = remote?.cwd || source?.cwd;
    if (!cwd) throw new Error("指定的 Codex 任务没有可用的工作目录，暂时不能 fork。");
    const sourceTitle = remote?.title ?? source?.title ?? remote?.preview;
    const forkTitle = this.store.nextForkTitle(sourceTitle);
    const model = source?.model;
    const reasoningEffort = source?.reasoningEffort;
    const permissionMode = source?.permissionMode ?? "auto";

    const localSessionId = createId("sess");
    const record = this.store.createSession({
      localSessionId,
      contextKey,
      agentName,
      cwd,
      status: "starting",
    });
    this.store.updateRuntimeSession(localSessionId, {
      runtimeKind: "codex",
      title: forkTitle,
      model,
      reasoningEffort,
      permissionMode,
    });

    try {
      const forked = await runtime.forkSession({
        localSessionId,
        remoteSessionId,
        lastTurnId,
        agentName,
        cwd,
        title: forkTitle,
        model,
        reasoningEffort,
        permissionMode,
      });
      this.persistRuntimeSession(record, forked, "ready");
      this.store.updateRuntimeSession(localSessionId, {
        lastTurnId,
        lastTurnStatus: forkedFromHistoricalTurn
          ? "completed"
          : mapRemoteTurnStatus(remote?.lastTurnStatus)
          ?? forkedTurnStatus(snapshot?.status)
          ?? source?.lastTurnStatus,
      });
      this.store.setCurrentSession(contextKey, localSessionId);
      this.outbound.registerSession(localSessionId, contextKey, forked.title ?? forkTitle, cwd);
      this.store.audit(contextKey, "session_forked", {
        sourceLocalSessionId: source?.localSessionId,
        sourceRemoteSessionId: remoteSessionId,
        sourceTurnId: lastTurnId,
        sourceWasRunning: isRunning,
        forkedLocalSessionId: localSessionId,
        forkedRemoteSessionId: forked.remoteSessionId,
      });
      const forkSourceLabel = forkedFromHistoricalTurn ? `${sourceLabel}最近已完成轮次` : sourceLabel;
      await this.outbound.sendText(
        contextKey,
        `已从${forkSourceLabel}创建分支并切换到新任务：${forked.title ? `${forked.title}（${forked.remoteSessionId}）` : forked.remoteSessionId}`,
      );
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      throw error;
    }
  }

  private async createProjectSessionFromReference(contextKey: string, reference: string): Promise<void> {
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    if (direct?.status === "closed") {
      throw new Error(`找不到任务：${taskId}`);
    }
    const source = direct ?? this.store.findSessionByRemoteSessionId(taskId);
    if (source && !this.isCodexSession(source)) {
      throw new Error("指定任务不是 Codex 任务，暂时不能按项目创建新任务。");
    }

    let agentName: string;
    let runtime: AgentRuntime;
    if (source) {
      agentName = source.agentName;
      runtime = this.runtimes.forAgent(this.ensureAgent(agentName));
    } else {
      const agentEntry = Object.entries(this.config.agents).find(([, agent]) => agent.kind === "codex");
      if (!agentEntry) throw new Error("未配置 Codex Agent。");
      [agentName] = agentEntry;
      runtime = this.runtimes.get("codex");
    }

    const remoteSessionId = source?.remoteSessionId ?? taskId;
    let remote: RemoteSessionSummary | undefined;
    if (runtime.readRemoteSession && remoteSessionId) {
      try {
        remote = await runtime.readRemoteSession(remoteSessionId);
      } catch (error) {
        if (!source) throw error;
        this.logger.warn(
          { error, contextKey, taskId: remoteSessionId },
          "Failed to refresh the source task before creating a project task; using the local project path.",
        );
      }
    }

    const cwd = remote?.cwd || source?.cwd;
    if (!cwd) {
      throw new Error("指定的 Codex 任务没有可用的工作目录，暂时不能按项目创建新任务。");
    }
    const executionSettings: SessionExecutionSettings = {
      model: remote?.model ?? source?.model,
      reasoningEffort: remote?.reasoningEffort ?? source?.reasoningEffort,
      permissionMode: remote?.permissionMode ?? source?.permissionMode ?? "auto",
    };
    const created = await this.createSession(
      contextKey,
      agentName,
      cwd,
      true,
      false,
      undefined,
      undefined,
      undefined,
      executionSettings,
    );
    this.store.audit(contextKey, "project_session_created", {
      sourceLocalSessionId: source?.localSessionId,
      sourceRemoteSessionId: remoteSessionId,
      createdLocalSessionId: created.localSessionId,
      createdRemoteSessionId: created.remoteSessionId,
      cwd,
      ...executionSettings,
    });
  }

  private async startTurn(
    loaded: LoadedSession,
    text: string,
    replyTarget?: MessageReplyTarget,
    localImagePaths?: string[],
  ): Promise<string> {
    const currentRecord = this.store.getSession(loaded.record.localSessionId);
    const title = currentRecord?.title ?? normalizeTaskTitle(text);
    if (!currentRecord?.title && title) this.store.updateRuntimeSession(loaded.record.localSessionId, { title });
    if (title) this.outbound.updateSessionTitle(loaded.record.localSessionId, title);
    await this.outbound.startPendingTurn(loaded.record.localSessionId, loaded.record.contextKey, title, replyTarget);
    let turnId: string;
    try {
      turnId = await loaded.runtime.startTurn(
        loaded.record.localSessionId,
        runtimePrompt(text, localImagePaths),
      );
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
    replyTarget?: MessageReplyTarget,
    requestedTitle?: string,
    executionSettings: SessionExecutionSettings = {},
  ): Promise<SessionRecord> {
    const agent = this.ensureAgent(agentName);
    const localSessionId = createId("sess");
    const initialTitle = normalizeTaskTitle(requestedTitle ?? prompt ?? "");
    const sessionCwd = cwd === undefined && agent.kind === "codex"
      ? createProjectlessWorkspace({ prompt: initialTitle }).cwd
      : path.resolve(cwd ?? this.config.defaults.cwd);
    const record = this.store.createSession({ localSessionId, contextKey, agentName, cwd: sessionCwd, status: "starting" });
    if (initialTitle || executionSettings.model || executionSettings.reasoningEffort || executionSettings.permissionMode) {
      this.store.updateRuntimeSession(localSessionId, {
        title: initialTitle,
        model: executionSettings.model,
        reasoningEffort: executionSettings.reasoningEffort,
        permissionMode: executionSettings.permissionMode,
      });
    }
    this.store.setCurrentSession(contextKey, localSessionId);
    this.outbound.registerSession(localSessionId, contextKey, initialTitle, sessionCwd);
    const runtime = this.runtimes.forAgent(agent);
    try {
      if (prepareTurn) await this.outbound.startPendingTurn(localSessionId, contextKey, initialTitle, replyTarget);
      const session = await runtime.createSession({
        localSessionId,
        agentName,
        cwd: sessionCwd,
        title: initialTitle,
        model: executionSettings.model,
        reasoningEffort: executionSettings.reasoningEffort,
        permissionMode: executionSettings.permissionMode ?? "auto",
      });
      this.persistRuntimeSession(record, session, session.activeTurnId ? "running" : "ready");
      const saved = this.store.getSession(localSessionId) ?? record;
      if (announce) {
        const task = initialTitle ? `${initialTitle}（${session.remoteSessionId}）` : session.remoteSessionId;
        await this.outbound.sendText(contextKey, `已创建 ${agent.title} 任务：${task}`);
      }
      return saved;
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      if (prepareTurn) {
        await this.outbound.failPendingTurn(localSessionId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private async createFeishuGroup(
    sourceContextKey: string,
    agentName: string,
    requestedTitle: string | undefined,
    userId: string | undefined,
  ): Promise<void> {
    if (!userId?.startsWith("ou_")) {
      throw new Error("/newgroup 只能由具有 open_id 的飞书用户消息触发。");
    }
    const boundProjectCwd = this.currentProjectCwd(sourceContextKey);
    const groupName = formatNewGroupName(
      agentName,
      boundProjectCwd,
      normalizeTaskTitle(requestedTitle) ?? "新任务",
      new Date(),
    );
    if (Array.from(groupName).length > 60) {
      throw new Error(`飞书群名最多 60 个字符；当前格式化后的群名为 ${Array.from(groupName).length} 个字符。`);
    }

    const group = await this.outbound.createGroup(sourceContextKey, {
      name: groupName,
      userOpenId: userId,
    });
    const groupContextKey = `chat_id:${group.chatId}`;
    this.store.recordChatContext(groupContextKey, "group");
    this.store.getOrCreateUserContext(groupContextKey, agentName);
    if (boundProjectCwd) this.store.setBoundProjectCwd(groupContextKey, boundProjectCwd);
    await this.outbound.sendText(
      groupContextKey,
      [
        "群已创建。",
        `当前 Project 目录：${boundProjectCwd ?? "未绑定（Projectless）"}`,
        "直接发送消息即可在本群开始一个新任务。",
      ].join("\n"),
    );
    await this.listSessions(groupContextKey);
    await this.outbound.sendText(
      sourceContextKey,
      `已创建飞书群：${group.name}，邀请你加入，并在新群中发送了 Sessions 卡片。`,
    );
  }

  private async loadSession(record: SessionRecord): Promise<LoadedSession> {
    const agent = this.ensureAgent(record.agentName);
    const runtime = this.runtimes.forAgent(agent);
    const existing = runtime.getSession(record.localSessionId);
    if (existing) return { record, runtime, session: existing };
    const pending = this.sessionLoads.get(record.localSessionId);
    if (pending) return pending;

    this.outbound.registerSession(record.localSessionId, record.contextKey, record.title, record.cwd);
    const loading = (async (): Promise<LoadedSession> => {
      if (record.lastTurnId) {
        try {
          await this.outbound.resumeDelivery(record.localSessionId, record.contextKey, record.lastTurnId);
        } catch (error) {
          this.logger.warn(
            { error, sessionId: record.localSessionId, turnId: record.lastTurnId },
            "Failed to restore persisted turn delivery before loading session.",
          );
        }
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
      const saved = this.store.getSession(record.localSessionId) ?? record;
      return { record: saved, runtime, session };
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
      this.store.updateRuntimeSession(event.sessionId, {
        lastTurnId: event.turnId,
        lastTurnStatus: event.type === "turn_completed" ? "completed" : event.type === "turn_cancelled" ? "cancelled" : "failed",
      });
    }

    try {
      await this.outbound.onEvent(event);
      if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
        await this.finalizeTurnMessageReactions(
          event.turnId,
          event.type === "turn_completed" ? "completed" : event.type === "turn_cancelled" ? "cancelled" : "failed",
        );
      }
    } finally {
      if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
        const latest = this.store.getSession(event.sessionId);
        const agent = latest ? this.ensureAgent(latest.agentName) : undefined;
        const activeTurnId = agent ? this.runtimes.forAgent(agent).getSession(event.sessionId)?.activeTurnId : undefined;
        if (latest?.lastTurnId === event.turnId && !activeTurnId) {
          this.store.updateSession(event.sessionId, { status: event.type === "turn_failed" ? "failed" : "ready" });
        }
      }
    }
    if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      const latest = this.store.getSession(event.sessionId);
      const agent = latest ? this.ensureAgent(latest.agentName) : undefined;
      const activeTurnId = agent ? this.runtimes.forAgent(agent).getSession(event.sessionId)?.activeTurnId : undefined;
      if (latest?.lastTurnId !== event.turnId || activeTurnId) return;
      await this.scheduleNextQueuedPrompt(event.sessionId);
    }
  }

  private scheduleNextQueuedPrompt(sessionId: string): Promise<void> {
    const previous = this.queuedPromptStarts.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.startNextQueuedPromptIfIdle(sessionId));
    this.queuedPromptStarts.set(sessionId, next);
    return next.finally(() => {
      if (this.queuedPromptStarts.get(sessionId) === next) this.queuedPromptStarts.delete(sessionId);
    });
  }

  private async startNextQueuedPromptIfIdle(sessionId: string): Promise<void> {
    if (this.store.countQueuedPrompts(sessionId) === 0) return;
    const baseRecord = this.store.getSession(sessionId);
    if (!baseRecord || baseRecord.status === "closed") return;
    let prompt: QueuedPromptRecord | undefined;
    try {
      let loaded = await this.loadSession(baseRecord);
      await this.assertSessionTurnOwnership(loaded.record, loaded.runtime);
      if (loaded.record.lastTurnId || loaded.session.activeTurnId) {
        loaded = { ...loaded, session: await loaded.runtime.synchronizeSession(sessionId) };
      }
      if (loaded.session.activeTurnId) return;

      prompt = this.store.takeNextQueuedPrompt(sessionId);
      if (!prompt) return;
      const record = this.store.getSessionForContext(sessionId, prompt.contextKey) ?? baseRecord;
      loaded = { ...loaded, record };
      await this.refreshPromptQueueCards(sessionId);
      const turnId = await this.startTurn(
        loaded,
        prompt.text,
        prompt.replyMessageId ? { messageId: prompt.replyMessageId, replyInThread: true } : undefined,
        prompt.localImagePaths,
      );
      if (prompt.messageId) await this.bindMessageReactionToTurn(prompt.messageId, sessionId, turnId);
    } catch (error) {
      this.logger.warn({ error, sessionId }, "Failed to start queued prompt.");
      if (prompt?.messageId) await this.finalizeStandaloneMessageReaction(prompt.messageId, "failed");
      if (prompt) await this.sendError(prompt.contextKey, error);
      if (prompt && this.store.countQueuedPrompts(sessionId) > 0) {
        queueMicrotask(() => void this.scheduleNextQueuedPrompt(sessionId));
      }
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
    this.store.bindMessageToTurn(messageId, sessionId, turnId);
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
      if (runtime.getGoal && runtime.setGoal) {
        try {
          if (!runtime.getSession(record.localSessionId)) await this.loadSession(record);
          const goal = await runtime.getGoal(record.localSessionId);
          if (goal?.status === "active") await runtime.setGoal(record.localSessionId, { status: "paused" });
        } catch (error) {
          this.logger.warn(
            { error, sessionId: record.localSessionId },
            "Failed to pause the active Codex goal before interrupting its turn.",
          );
        }
      }
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

  private async model(contextKey: string, model?: string, options: ModelCardOptions = {}): Promise<void> {
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    const models = await loaded.runtime.listModels();
    if (!model) {
      const currentModel = loaded.session.model ?? models.find((item) => item.isDefault)?.id;
      const card = this.cardRenderer.renderModelSelector({
        sessionId: loaded.record.localSessionId,
        contextKey,
        currentModel,
        reasoningEffort: loaded.session.reasoningEffort,
        models,
      });
      if (options.updateMessageId) {
        await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
      } else {
        await this.outbound.sendInteractiveCard(contextKey, card);
      }
      return;
    }

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
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(
        contextKey,
        options.updateMessageId,
        this.cardRenderer.renderReasoningSelector({
          sessionId: loaded.record.localSessionId,
          contextKey,
          model,
          currentEffort: nextEffort,
          options: selected.supportedReasoningEfforts,
          notice: `模型已切换为 ${cardCode(model)}，请选择思考模式。`,
        }),
      );
      return;
    }
    await this.outbound.sendText(contextKey, `模型已切换为 ${model}${effortMessage}，从下一次请求生效。`);
  }

  private async goal(contextKey: string, command: Extract<Command, { type: "goal" }>): Promise<void> {
    const objective = command.action === "set" || command.action === "edit" ? command.objective : undefined;
    if (objective !== undefined) validateGoalObjective(objective);
    let record = this.currentSession(contextKey);
    if (!record) {
      if (command.action !== "set") {
        throw new Error("当前没有任务。请使用 /goal <目标> 创建 Goal，或先发送消息创建任务。");
      }
      const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
      const agent = this.ensureAgent(context.defaultAgent);
      if (agent.kind !== "codex") throw new Error("Goal 模式仅支持 Codex App Server 任务。");
      record = await this.createSession(
        contextKey,
        context.defaultAgent,
        this.inheritedNewTaskCwd(contextKey),
        false,
        false,
        objective,
      );
    }

    const loaded = await this.loadSession(record);
    if (loaded.runtime.kind !== "codex" || !loaded.runtime.getGoal || !loaded.runtime.setGoal || !loaded.runtime.clearGoal) {
      throw new Error("当前任务不支持 Codex Goal 模式。");
    }

    if (command.action === "show") {
      await this.sendGoalCard(contextKey, await loaded.runtime.getGoal(record.localSessionId));
      return;
    }
    if (command.action === "clear") {
      const cleared = await loaded.runtime.clearGoal(record.localSessionId);
      if (!cleared) {
        await this.outbound.sendText(contextKey, "当前任务没有 Goal。");
        return;
      }
      await this.sendGoalCard(contextKey, undefined, "Goal 已清除；当前正在执行的轮次不会被中断。", record);
      return;
    }

    const current = await loaded.runtime.getGoal(record.localSessionId);
    if (command.action === "pause" || command.action === "resume") {
      if (!current) throw new Error("当前任务没有 Goal。使用 /goal <目标> 创建一个 Goal。");
      const status = command.action === "pause" ? "paused" : "active";
      const goal = await loaded.runtime.setGoal(record.localSessionId, { status });
      await this.sendGoalCard(
        contextKey,
        goal,
        command.action === "pause"
          ? "Goal 已暂停；当前轮次可以完成，但不会继续自动执行。"
          : "Goal 已恢复，Codex 会继续自动执行。",
        record,
      );
      return;
    }

    if (objective === undefined) throw new Error("无效的 Goal 命令。");
    if (command.action === "set" && current && current.status !== "complete") {
      throw new Error("当前已有未完成的 Goal。使用 /goal edit <新目标> 修改，或先使用 /goal clear 清除。");
    }
    if (command.action === "edit" && !current) {
      throw new Error("当前任务没有可修改的 Goal。使用 /goal <目标> 创建一个 Goal。");
    }
    const goal = await loaded.runtime.setGoal(record.localSessionId, {
      objective,
      status: command.action === "edit" ? current!.status : "active",
      ...(command.action === "edit" ? { tokenBudget: current!.tokenBudget } : {}),
    });
    await this.sendGoalCard(
      contextKey,
      goal,
      command.action === "edit" ? "Goal 已更新。" : "Goal 已启动，Codex 会持续执行直到完成、暂停或遇到阻塞。",
      record,
    );
  }

  private async sendGoalCard(
    contextKey: string,
    goal: RuntimeGoal | undefined,
    notice?: string,
    record = this.currentSession(contextKey),
  ): Promise<void> {
    const sections: CardSection[] = [];
    if (notice) sections.push({ lines: [cardText(notice)] });
    sections.push(goal
      ? { title: "当前 Goal", lines: goalDetailLines(goal) }
      : { title: "当前 Goal", lines: ["未设置。使用 **/goal &#60;目标&#62;** 创建一个长任务。"] });
    if (record) {
      sections.push({
        title: "任务",
        lines: [
          `**标题**：${cardText(record.title ?? "未命名任务")}`,
          `**Codex 任务 ID**：${cardText(record.remoteSessionId ?? "尚未创建")}`,
        ],
      });
    }
    sections.push({
      title: "命令",
      lines: [
        "**/goal**　查看　　**/goal pause**　暂停　　**/goal resume**　恢复",
        "**/goal edit &#60;新目标&#62;**　修改　　**/goal clear**　清除",
      ],
    });
    await this.outbound.sendInteractiveCard(contextKey, this.cardRenderer.renderSectionsCard("Codex Goal", sections));
  }

  private async runShellCommand(contextKey: string, command: string): Promise<void> {
    const cwd = this.currentSession(contextKey)?.cwd ?? this.config.defaults.cwd;
    const result = await this.shellCommandExecutor(command, cwd);
    const outputParts = [
      result.stdout.trimEnd(),
      result.stderr.trimEnd() ? `[stderr]\n${result.stderr.trimEnd()}` : "",
    ].filter(Boolean);
    const output = truncateMiddle(outputParts.join("\n"), 6_000);
    const status = result.timedOut
      ? "已超时（120s）"
      : `退出码 ${result.exitCode ?? "未知"}`;
    await this.outbound.sendMarkdown(contextKey, [
      codeBlock(`$  ${command.trim()}\n${output || "（无输出）"}`, "text"),
      `${asInlineCode(cwd)} · ${status}${result.outputTruncated ? " · 输出已截断" : ""}`,
    ].join("\n"));
  }

  private async setTitle(contextKey: string, title: string): Promise<void> {
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) throw new Error("任务标题不能为空。");
    const loaded = await this.loadSession(this.requireCurrentSession(contextKey));
    if (loaded.runtime.setTitle) await loaded.runtime.setTitle(loaded.record.localSessionId, normalizedTitle);
    else loaded.session.title = normalizedTitle;
    this.store.updateRuntimeSession(loaded.record.localSessionId, { title: normalizedTitle });
    this.outbound.updateSessionTitle(loaded.record.localSessionId, normalizedTitle);
    await this.outbound.sendText(contextKey, `已将当前任务标题修改为：${normalizedTitle}`);
  }

  private async syncTaskTitleFromGroupName(
    contextKey: string,
    event: ChatUpdatedEvent,
  ): Promise<void> {
    const parsed = parseAgentGroupName(event.afterName);
    if (!parsed) return;
    const context = this.store.getUserContext(contextKey);
    if (!context?.currentSessionId) return;
    const record = this.store.getSessionForContext(context.currentSessionId, contextKey);
    if (!record || record.status === "closed") return;
    if (record.agentName.toLowerCase() !== parsed.agentName.toLowerCase()) return;
    const title = normalizeTaskTitle(parsed.title);
    if (!title || title === record.title) return;

    const loaded = await this.loadSession(record);
    if (loaded.runtime.setTitle) await loaded.runtime.setTitle(record.localSessionId, title);
    else loaded.session.title = title;
    this.store.updateRuntimeSession(record.localSessionId, { title });
    this.outbound.updateSessionTitle(record.localSessionId, title);
    this.store.audit(contextKey, "session_title_changed", {
      localSessionId: record.localSessionId,
      title,
      source: "group_name",
      beforeName: event.beforeName,
      afterName: event.afterName,
    });
  }

  private async thinking(contextKey: string, effort?: string, options: ThinkingCardOptions = {}): Promise<void> {
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    const models = await loaded.runtime.listModels();
    const currentModel = models.find((item) => item.id === loaded.session.model)
      ?? models.find((item) => item.isDefault);
    if (!currentModel) throw new Error("当前运行时没有可配置思考强度的模型。");
    if (options.expectedModel && currentModel.id !== options.expectedModel) {
      throw new Error("模型已发生变化，请重新打开 /model。");
    }
    const supported = currentModel.supportedReasoningEfforts;

    if (!effort) {
      const card = this.cardRenderer.renderReasoningSelector({
        sessionId: loaded.record.localSessionId,
        contextKey,
        model: currentModel.id,
        currentEffort: loaded.session.reasoningEffort ?? currentModel.defaultReasoningEffort,
        options: supported,
      });
      if (options.updateMessageId) {
        await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
      } else {
        await this.outbound.sendInteractiveCard(contextKey, card);
      }
      return;
    }

    if (!supported.some((option) => option.value === effort)) {
      const options = supported.map((option) => option.value).join("、") || "无";
      throw new Error(`不支持的思考强度：${effort}。支持的强度：${options}`);
    }
    await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, effort);
    this.store.updateRuntimeSession(loaded.record.localSessionId, { reasoningEffort: effort });
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(
        contextKey,
        options.updateMessageId,
        this.cardRenderer.renderReasoningSelector({
          sessionId: loaded.record.localSessionId,
          contextKey,
          model: currentModel.id,
          currentEffort: effort,
          options: supported,
          notice: `思考模式已切换为 ${cardCode(effort)}，从下一次请求生效。`,
        }),
      );
      return;
    }
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
          contextKey,
        },
      }];
      actions.push({
        text: "New",
        value: {
          action: "session_new",
          sessionId: entry.id,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
        },
      });
      actions.push({
        text: "Fork",
        value: {
          action: "session_fork",
          sessionId: entry.id,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
        },
      });
      actions.push({
        text: "Status",
        value: {
          action: "session_status",
          sessionId: entry.id,
          contextKey,
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
        "点击 **New** 在对应任务的项目中创建新任务；点击 **Switch** 快速切换；点击 **Fork** 从任务最新已完成轮次创建分支；外部正在运行的任务显示 **Stop**，点击后发送 Interrupt 并变为 **Switch**。",
        "也可发送 **/switch [序号或任务 ID]**；不带参数切回上一个任务。外部正在执行的回合不会被接管。",
        "发送 **/fork [序号或任务 ID]**，可从当前或指定任务创建分支；任务运行中时使用最近已完成轮次。",
        "点击 **Status**，或发送 **/status [序号或任务 ID]**，查看当前或指定任务状态。",
      ],
      hasMore ? {
        text: "更多任务",
        type: "primary",
        value: {
          action: "session_more",
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
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

  private async refreshStatusCardFromAction(action: CardAction, forceSwitchTaskId?: string): Promise<void> {
    if (!action.messageId) return;
    const sessionId = typeof action.value.sessionId === "string" && action.value.sessionId.trim()
      ? action.value.sessionId
      : undefined;
    await this.status(action.contextKey, sessionId, {
      updateMessageId: action.messageId,
      forceSwitchTaskId,
    });
  }

  private async switchSession(contextKey: string, reference?: string): Promise<void> {
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    if (direct?.status === "closed") {
      throw new Error(`找不到任务：${taskId}`);
    }
    const existing = direct ?? this.store.findSessionByRemoteSessionId(taskId);
    if (existing) {
      const runtime = this.runtimes.forAgent(this.ensureAgent(existing.agentName));
      await this.assertSessionTurnOwnership(existing, runtime);
      this.store.attachSessionToContext(contextKey, existing.localSessionId);
      this.store.setCurrentSession(contextKey, existing.localSessionId);
      this.outbound.registerSession(existing.localSessionId, contextKey, existing.title, existing.cwd);
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
    this.outbound.registerSession(localSessionId, contextKey, remote.title ?? remote.preview, remote.cwd);
    await this.outbound.sendText(
      contextKey,
      `已切换到任务：${remote.title ?? remote.preview ?? remote.id}。历史消息不会重新发送。`,
    );
  }

  private async stopSessionReference(contextKey: string, taskId: string): Promise<void> {
    const direct = this.store.getSession(taskId);
    if (direct) {
      if (direct.status === "closed") throw new Error(`找不到任务：${taskId}`);
      await this.cancelSession({ ...direct, contextKey });
      return;
    }

    const existing = this.store.findSessionByRemoteSessionId(taskId);
    if (existing) {
      await this.cancelSession({ ...existing, contextKey });
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
    if (!listing) throw new Error("请先发送 /sessions 获取任务列表，再使用任务序号。");
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

  private async status(
    contextKey: string,
    sessionId?: string,
    options: StatusCardOptions = {},
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const targetSessionId = sessionId === undefined ? undefined : this.resolveSessionReference(contextKey, sessionId);
    let current: SessionRecord | undefined;
    if (targetSessionId) {
      const direct = this.store.getSession(targetSessionId);
      current = direct
        ? { ...direct, contextKey }
        : this.store.findSessionByRemoteSessionId(targetSessionId, contextKey);
      if (!current) {
        await this.statusForCodexTask(contextKey, targetSessionId, options);
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

    const localCurrent = current;
    let remote: RemoteSessionSummary | undefined;
    let goal: RuntimeGoal | undefined;
    if (current?.remoteSessionId) {
      const runtime = this.runtimes.forAgent(this.ensureAgent(current.agentName));
      if (runtime.readRemoteSession) {
        try {
          remote = await runtime.readRemoteSession(current.remoteSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to inspect Codex task status.");
        }
      }
      if (runtime.kind === "codex" && runtime.getGoal) {
        try {
          const loaded = runtime.getSession(current.localSessionId) ?? (await this.loadSession(current)).session;
          goal = await runtime.getGoal(loaded.localSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to inspect Codex goal status.");
        }
      }
    }

    if (current) current = mergeRemoteTaskStatus(current, remote);

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
      queued = this.store.countQueuedPrompts(current.localSessionId);
      snapshot = turnViewSnapshot(current.lastTurnId ? this.store.getTurnSnapshot(current.lastTurnId) : undefined);
      const statusLabel = remoteActive && remote && localCurrent && !isBotOwnedActiveTurn(localCurrent, remote)
        ? "外部执行中"
        : sessionStatusLabel(current.status, activeTurnId);
      const resultLabel = remoteActive
        ? "执行中"
        : remoteTurnStatusLabel(remote?.lastTurnStatus ?? current.lastTurnStatus);
      taskLines.push(
        `**标题**：${cardCode(current.title ?? "未命名任务")}`,
        `**工作目录**：${cardCode(current.cwd)}`,
        `**模型 / 思考强度**：${cardCode(current.model ?? "默认")} / ${cardCode(current.reasoningEffort ?? "自动")}`,
        `**状态 / 最近结果**：${statusLabel} / ${resultLabel}`,
        `**Agent**：${cardCode(agent.title)}`,
        `**权限 / 任务范围**：${current.permissionMode === "confirm" ? "执行前确认" : "自动执行"} / ${detectProjectlessWorkspace(current.cwd) ? "未指定项目" : "指定项目"}`,
        `**Codex 任务 ID**：${cardCode(current.remoteSessionId ?? "尚未创建")}`,
        `**当前执行 / 排队消息**：${activeTurnId ? cardCode(activeTurnId) : "无"} / ${queued} 条`,
        `**创建时间 / 最近活动**：${formatStatusTime(current.createdAt)} / ${formatStatusTime(current.updatedAt)}`,
      );
    }

    const sections: CardSection[] = [
      { title: targetSessionId ? "指定任务" : "当前任务", lines: taskLines },
      ...(current ? [{
        title: "Goal",
        lines: goal ? goalDetailLines(goal) : ["未设置。"],
      }] : []),
      ...(current ? [{
        title: "最终结果",
        lines: finalResultLines(snapshot, remote),
      }] : []),
      ...(current ? [{
        title: "执行详情",
        lines: executionDetailLines(localCurrent ?? current, snapshot, remote, activeTurnId, queued),
        collapsible: true,
        elementId: "status_execution_details",
      }] : []),
      {
        title: "acp-bot",
        lines: [
          `**默认 Agent / 保活**：${cardCode(context.defaultAgent)} / ${this.lifecycle?.supervised ? "已启用" : "未启用"}`,
          "**交互方式**：普通消息继续当前任务；/new 创建新任务；/help 查看命令。",
        ],
      },
    ];
    const title = targetSessionId && current
      ? `Codex 状态：${truncateText((current.title ?? current.remoteSessionId ?? current.localSessionId).replace(/\s+/g, " "), 40)}`
      : "Codex 状态";
    const taskId = current?.remoteSessionId ?? current?.localSessionId;
    const isCurrent = Boolean(current && current.localSessionId === context.currentSessionId);
    const remoteActive = isRemoteSessionActive(remote);
    const botOwnsActiveTurn = Boolean(localCurrent && remote && isBotOwnedActiveTurn(localCurrent, remote));
    const active = Boolean(activeTurnId || current?.status === "running" || remoteActive);
    const forceSwitch = Boolean(taskId && options.forceSwitchTaskId === taskId);
    const taskActions: TaskListCardAction[] = !taskId ? []
      : remoteActive && !botOwnsActiveTurn && !forceSwitch
        ? [statusCardAction("Stop", "danger", "session_stop", taskId, contextKey)]
        : isCurrent && active && !forceSwitch
          ? [statusCardAction("Stop", "danger", "session_stop", taskId, contextKey)]
          : !isCurrent
            ? [statusCardAction("Switch", "default", "session_switch", taskId, contextKey)]
            : [];
    const actions: TaskListCardAction[] = [
      statusRefreshAction(taskId, contextKey),
      ...taskActions,
    ];
    const card = this.cardRenderer.renderSectionsCard(title, sections, actions);
    if (options.updateMessageId) await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    else await this.outbound.sendInteractiveCard(contextKey, card);
  }

  private async statusForCodexTask(
    contextKey: string,
    remoteSessionId: string,
    options: StatusCardOptions = {},
  ): Promise<void> {
    const runtime = this.runtimes.get("codex");
    if (!runtime.readRemoteSession) throw new Error("当前 Codex 运行时不支持读取外部任务状态。");
    const remote = await runtime.readRemoteSession(remoteSessionId);
    const sections: CardSection[] = [
      {
        title: "指定任务",
        lines: [
          `**标题**：${cardCode(remote.title ?? remote.preview ?? "未命名任务")}`,
          `**工作目录**：${cardCode(remote.cwd || "目录未知")}`,
          `**状态 / 当前任务**：${remoteSessionDetailStatus(remote)} / 未切换`,
          `**Codex 任务 ID**：${cardCode(remote.id)}`,
          `**最近回合**：${cardCode(remote.lastTurnId ?? "无")}　${remoteTurnStatusLabel(remote.lastTurnStatus)}`,
          `**创建时间 / 最近活动**：${formatRemoteTime(remote.createdAt)} / ${formatRemoteTime(latestRemoteTimestamp(remote.recencyAt, remote.updatedAt))}`,
        ],
      },
      { title: "最终结果", lines: finalResultLines(undefined, remote) },
      {
        title: "执行详情",
        lines: [
          `**当前 / 最后步骤**：${statusExcerpt(remote.lastActivity ?? remoteStatusStep(remote), 500)}`,
          isRemoteSessionActive(remote)
            ? "外部 Codex 正在执行；acp-bot 只读取状态，不会接管。"
            : `发送 **/switch ${cardText(remote.id)}** 切换到此任务。`,
        ],
        collapsible: true,
        elementId: "status_execution_details",
      },
    ];
    const title = `Codex 状态：${truncateText((remote.title ?? remote.preview ?? remote.id).replace(/\s+/g, " "), 40)}`;
    const showStop = isRemoteSessionActive(remote) && options.forceSwitchTaskId !== remote.id;
    const actions = [
      statusRefreshAction(remote.id, contextKey),
      statusCardAction(
        showStop ? "Stop" : "Switch",
        showStop ? "danger" : "default",
        showStop ? "session_stop" : "session_switch",
        remote.id,
        contextKey,
      ),
    ];
    const card = this.cardRenderer.renderSectionsCard(title, sections, actions);
    if (options.updateMessageId) await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    else await this.outbound.sendInteractiveCard(contextKey, card);
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
          "**/new [title] [--dir &#60;cwd&#62; | --nodir]**　使用默认 Agent 创建任务；--nodir 强制创建 Projectless 任务",
          "**/newgroup [title]**　创建飞书群并绑定当前项目；邀请当前用户并发送 Sessions 卡片",
          "**/fork [序号或任务 ID]**　从当前或指定任务创建分支；运行中使用最近已完成轮次",
          "**/title &#60;新标题&#62;**　修改当前任务的标题",
          "**/sessions [关键词]**　查找本机任务",
          "**/switch [序号或任务 ID]**　不填参数切回上一个任务",
        ],
      },
      {
        title: "执行设置",
        lines: [
          "**! &#60;命令&#62;**　在当前任务目录直接执行本地命令",
          "**/stop**　停止当前执行",
          "**/nosteer &#60;prompt&#62;**　不追加到当前轮次，按顺序排队为后续轮次",
          "**/goal [目标]**　查看或创建长任务 Goal；支持 pause、resume、edit、clear",
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
    return context.currentSessionId
      ? this.store.getSessionForContext(context.currentSessionId, contextKey)
      : undefined;
  }

  private inheritedNewTaskCwd(contextKey: string): string | undefined {
    const current = this.currentSession(contextKey);
    if (!current) return this.store.getUserContext(contextKey)?.boundProjectCwd;
    return detectProjectlessWorkspace(current.cwd)
      ? createProjectlessWorkspace().cwd
      : current.cwd;
  }

  private currentProjectCwd(contextKey: string): string | undefined {
    const current = this.currentSession(contextKey);
    return current && !detectProjectlessWorkspace(current.cwd) ? current.cwd : undefined;
  }

  private requireCurrentSession(contextKey: string): SessionRecord {
    const record = this.currentSession(contextKey);
    if (!record) throw new Error("当前没有任务，直接发送一条消息即可自动创建。");
    return record;
  }

  private requireSession(contextKey: string, sessionId: string): SessionRecord {
    const record = this.store.getSessionForContext(sessionId, contextKey);
    if (!record) throw new Error(`找不到任务：${sessionId}`);
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

function statusCardAction(
  text: "Stop" | "Switch",
  type: "danger" | "default",
  action: "session_stop" | "session_switch",
  sessionId: string,
  contextKey: string,
): TaskListCardAction {
  return {
    text,
    type,
    value: { action, sessionId, cardView: "status", contextKey },
  };
}

function statusRefreshAction(
  sessionId: string | undefined,
  contextKey: string,
): TaskListCardAction {
  return {
    text: "刷新",
    value: {
      action: "session_status_refresh",
      ...(sessionId ? { sessionId } : {}),
      cardView: "status",
      contextKey,
    },
  };
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
    const recencyAt = remote.recencyAt ?? remote.updatedAt;
    return {
      id: remote.id,
      title: remote.title ?? remote.preview ?? local?.title ?? "未命名任务",
      cwd: remote.cwd || local?.cwd || "",
      status,
      active,
      current: Boolean(local && local.localSessionId === currentLocalSessionId),
      updatedAt: (recencyAt ?? 0) * 1_000,
      updatedLabel: formatRemoteTime(recencyAt),
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
    : activeTurnId ?? remote?.lastTurnId ?? snapshot?.turnId ?? record.lastTurnId;
  if (!turnId) return ["尚无执行记录。"];
  const relevantSnapshot = snapshot?.turnId === turnId ? snapshot : undefined;
  const externallyActive = Boolean(remoteActive && remote && !isBotOwnedActiveTurn(record, remote));
  const lines = [
    `**回合 ID**：${cardText(turnId)}`,
    `**执行状态**：${externallyActive ? "外部执行中" : relevantSnapshot ? turnViewStatusLabel(relevantSnapshot.status) : remoteTurnStatusLabel(remote?.lastTurnStatus ?? remoteStatusToTurnStatus(remote?.status) ?? record.lastTurnStatus)}`,
    `**当前 / 最后步骤**：${statusExcerpt(currentOrLastStep(relevantSnapshot, remote), 600)}`,
  ];

  const remoteCountsApply = remote?.lastTurnId === turnId && remote.lastTurnToolCount !== undefined;
  if (relevantSnapshot || remoteCountsApply) {
    const lastTool = [...(relevantSnapshot?.activities ?? [])]
      .reverse()
      .find((activity): activity is Extract<TurnActivity, { kind: "tool" }> => activity.kind === "tool")?.tool;
    const tool = relevantSnapshot?.activeTool ?? lastTool;
    const completedTools = remoteCountsApply
      ? remote.lastTurnCompletedToolCount ?? 0
      : relevantSnapshot?.completedToolCount ?? relevantSnapshot?.completedTools?.length ?? 0;
    const failedTools = remoteCountsApply
      ? remote.lastTurnFailedToolCount ?? 0
      : relevantSnapshot?.failedToolCount ?? relevantSnapshot?.failedTools?.length ?? 0;
    const runningTools = remoteCountsApply
      ? remote.lastTurnRunningToolCount ?? 0
      : relevantSnapshot?.activeTool ? 1 : 0;
    lines.push(`**工具执行**：完成 ${completedTools}，失败 ${failedTools}${runningTools > 0 ? `，当前 ${runningTools}` : ""}`);
    if (tool) lines.push(`**当前 / 最后工具**：${statusExcerpt(tool.title, 400)}（${toolStatusLabel(tool.status)}）`);
    if (relevantSnapshot?.durationMs !== undefined) lines.push(`**耗时**：${formatDuration(relevantSnapshot.durationMs)}`);
  }
  if (queued > 0) lines.push(`**排队消息**：${queued} 条`);
  return lines;
}

function finalResultLines(snapshot?: TurnViewState, remote?: RemoteSessionSummary): string[] {
  const relevantSnapshot = !remote?.lastTurnId || snapshot?.turnId === remote.lastTurnId ? snapshot : undefined;
  if (relevantSnapshot?.status === "running" || relevantSnapshot?.status === "tool_running" || relevantSnapshot?.status === "waiting_for_approval"
    || isRemoteSessionActive(remote)) {
    return ["任务仍在执行，尚无最终结果。"];
  }
  const result = remote?.finalResponse?.trim() || relevantSnapshot?.finalResponse?.trim();
  if (result) return [statusExcerpt(result, 2_800)];
  const error = remote?.lastError?.trim() || relevantSnapshot?.error?.trim();
  if (error) return [`❌ ${statusExcerpt(error, 2_400)}`];
  if (relevantSnapshot?.status === "cancelled" || remote?.lastTurnStatus === "interrupted") {
    return ["任务已停止，未产生最终回答。"];
  }
  if (relevantSnapshot?.status === "failed" || remote?.lastTurnStatus === "failed") {
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

function cardCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
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
  return formatStatusTime(new Date(normalizeRemoteTimestamp(value)).toISOString());
}

function mapRemoteTurnStatus(status?: RemoteSessionSummary["lastTurnStatus"]): string | undefined {
  if (status === "interrupted") return "cancelled";
  if (status === "inProgress") return "running";
  return status;
}

function mergeRemoteTaskStatus(record: SessionRecord, remote?: RemoteSessionSummary): SessionRecord {
  if (!remote) return record;
  const remoteTurnStatus = mapRemoteTurnStatus(remote.lastTurnStatus);
  const createdAt = remote.createdAt === undefined
    ? record.createdAt
    : new Date(normalizeRemoteTimestamp(remote.createdAt)).toISOString();
  const remoteActivityAt = latestRemoteTimestamp(remote.recencyAt, remote.updatedAt);
  const updatedAt = remoteActivityAt === undefined
    ? record.updatedAt
    : new Date(remoteActivityAt).toISOString();
  return {
    ...record,
    title: remote.title ?? record.title,
    cwd: remote.cwd || record.cwd,
    status: isRemoteSessionActive(remote)
      ? "running"
      : remote.lastTurnStatus
        ? "ready"
        : record.status,
    lastTurnId: remote.lastTurnId ?? record.lastTurnId,
    lastTurnStatus: remoteTurnStatus ?? record.lastTurnStatus,
    createdAt,
    updatedAt,
  };
}

function normalizeRemoteTimestamp(value: number): number {
  return value >= 10_000_000_000 ? value : value * 1_000;
}

function latestRemoteTimestamp(...values: Array<number | undefined>): number | undefined {
  const timestamps = values
    .filter((value): value is number => value !== undefined)
    .map(normalizeRemoteTimestamp);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function isTurnStillRunning(status?: TurnViewState["status"]): boolean {
  return status === "starting"
    || status === "running"
    || status === "tool_running"
    || status === "waiting_for_approval";
}

function forkedTurnStatus(status?: TurnViewState["status"]): string | undefined {
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return undefined;
}

function isBotOwnedActiveTurn(record: SessionRecord, remote: RemoteSessionSummary): boolean {
  return record.status === "running"
    && record.lastTurnStatus === "running"
    && Boolean(record.lastTurnId)
    && record.lastTurnId === remote.lastTurnId;
}

function isQueueIndependentCommand(command: Command): boolean {
  if (["stop", "status", "restart", "help", "sessions", "goal", "nosteer"].includes(command.type)) return true;
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
  return command.type === "ask" || command.type === "prompt" || command.type === "nosteer";
}

function runtimePrompt(text: string, localImagePaths?: string[]): RuntimePrompt {
  return localImagePaths?.length ? { text, localImagePaths } : text;
}

function formatTimestampTaskTitle(date: Date): string {
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatNewGroupName(
  agentName: string,
  projectCwd: string | undefined,
  taskTitle: string,
  date: Date,
): string {
  const prefix = `[${agentName}] `;
  const suffix = ` ${taskTitle} - ${formatTimestampTaskTitle(date)}`;
  const availableProjectLength = 60 - Array.from(prefix).length - Array.from(suffix).length;
  if (availableProjectLength <= 0) return `${prefix}${projectCwd ?? "Projectless"}${suffix}`;
  const project = truncateMiddleCharacters(projectCwd ?? "Projectless", availableProjectLength);
  return `${prefix}${project}${suffix}`;
}

function truncateMiddleCharacters(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  if (maxLength === 1) return "…";
  const retained = maxLength - 1;
  const headLength = Math.ceil(retained / 2);
  const tailLength = Math.floor(retained / 2);
  return `${characters.slice(0, headLength).join("")}…${characters.slice(-tailLength).join("")}`;
}

function parseAgentGroupName(value: string): { agentName: string; title: string } | undefined {
  const match = /^\[([^[\]]+)\]\s+(.+)$/.exec(value.trim());
  const agentName = match?.[1]?.trim();
  const title = match?.[2]?.trim();
  return agentName && title ? { agentName, title } : undefined;
}

function validateGoalObjective(objective: string): void {
  const length = Array.from(objective.trim()).length;
  if (length === 0) throw new Error("Goal 不能为空。");
  if (length > 4_000) {
    throw new Error("Goal 最多 4000 个字符。请把详细说明写入文件，并在 Goal 中引用该文件。");
  }
}

function goalDetailLines(goal: RuntimeGoal): string[] {
  return [
    `**状态**：${goalStatusLabel(goal.status)}`,
    `**目标**：${statusExcerpt(goal.objective, 2_800)}`,
    `**消耗**：${formatGoalTokenCount(goal.tokensUsed)} tokens / ${formatGoalElapsed(goal.timeUsedSeconds)}`,
    ...(goal.tokenBudget === null || goal.tokenBudget === undefined
      ? []
      : [`**Token 预算**：${formatGoalTokenCount(goal.tokenBudget)}`]),
    `**更新时间**：${formatUnixTime(goal.updatedAt)}`,
  ];
}

function goalStatusLabel(status: RuntimeGoal["status"]): string {
  const labels: Record<RuntimeGoal["status"], string> = {
    active: "执行中",
    paused: "已暂停",
    blocked: "已阻塞",
    usageLimited: "额度受限",
    budgetLimited: "Token 预算受限",
    complete: "已完成",
  };
  return labels[status];
}

function formatGoalTokenCount(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 10_000) return new Intl.NumberFormat("zh-CN").format(rounded);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumSignificantDigits: 3,
  }).format(rounded);
}

function formatGoalElapsed(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const second = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minute = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  if (totalMinutes > 0) return `${String(totalMinutes).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  return `${totalSeconds}s`;
}

function formatUnixTime(seconds: number): string {
  return formatStatusTime(new Date(seconds * 1_000).toISOString());
}
