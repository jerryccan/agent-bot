import path from "node:path";
import os from "node:os";
import type { Logger } from "pino";
import { createProjectlessWorkspace, detectProjectlessWorkspace } from "../codex/ProjectlessWorkspace.js";
import { resolveUserPath } from "../config/paths.js";
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
import {
  CardRenderer,
  type CardSection,
  type ExecutionSettingsTab,
  type TaskListCardAction,
} from "../feishu/CardRenderer.js";
import { generateGroupAvatarPng, resolveGroupAvatarProjectName } from "../feishu/GroupAvatarGenerator.js";
import type { OutboundRouter } from "../presentation/OutboundRouter.js";
import type { TurnActivity, TurnViewState } from "../presentation/turnViewTypes.js";
import type { AgentRuntimeRegistry } from "../runtime/AgentRuntimeRegistry.js";
import type {
  AgentRuntime,
  ApprovalDecision,
  PermissionMode,
  RemoteSessionActivity,
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
  type TurnAnchorRecord,
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
const REMOTE_SESSION_REFERENCE_PREFIX = "agent-runtime:";

interface AgentRemoteSession {
  agentName: string;
  runtime: AgentRuntime;
  remote: RemoteSessionSummary;
}

interface AgentRemoteSessionSummary {
  agentName: string;
  session: RemoteSessionSummary;
}

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

interface ExecutionSettingsCardOptions extends ModelCardOptions {
  notice?: string;
}

interface SessionExecutionSettings {
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
}

interface ProjectSessionReference {
  source?: SessionRecord;
  agentName: string;
  remoteSessionId: string;
  cwd: string;
  executionSettings: SessionExecutionSettings;
}

interface ForkSessionPlan {
  source?: SessionRecord;
  sourceLabel: string;
  runtime: AgentRuntime;
  agentName: string;
  remoteSessionId: string;
  lastTurnId: string;
  cwd: string;
  forkTitle: string;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  lastTurnStatus?: SessionRecord["lastTurnStatus"];
  sourceWasRunning: boolean;
  forkedFromHistoricalTurn: boolean;
}

interface ForkSessionResult {
  record: SessionRecord;
  session: RuntimeSession;
}

interface ForkGroupSessionPlan {
  plan: ForkSessionPlan;
  sourceDescription: string;
}

interface ResolvedThreadForkAnchor {
  anchor: TurnAnchorRecord;
  source: SessionRecord;
  snapshot?: TurnViewState;
}

interface CreatedFeishuGroupContext {
  chatId: string;
  contextKey: string;
  name: string;
}

interface CreatedFeishuTaskGroup {
  group: CreatedFeishuGroupContext;
  task: SessionRecord;
}

export interface ControlTaskGroupResult {
  sourceLocalSessionId: string;
  sourceTurnId?: string;
  group: CreatedFeishuGroupContext;
  task: SessionRecord;
}

export interface ProxyLifecycle {
  supervised?: boolean;
  restart(contextKey: string, force: boolean): Promise<void>;
  cancelSafeRestart?(scheduleId: number): Promise<boolean>;
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
    for (const [, runtime] of this.runtimes.entries()) {
      this.unsubscribe.push(
        runtime.onEvent((event) => {
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
    // The durable deduplication claim is the only operation allowed before acknowledgement.
    // It prevents event retries from adding duplicate reactions.
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
    if (message.chatId && message.chatType) {
      this.store.recordChatContext(baseChatContextKey(message.contextKey), message.chatType);
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
        ? { type: "prompt", text: message.text.trim() || "请查看这张图片" }
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
          if (command.type !== "forkgroup") await this.ensureThreadFork(message);
          await this.execute(
            message.contextKey,
            command,
            message.messageId,
            replyTarget,
            localImagePaths,
            message.userId,
            message,
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
          if (command.type !== "forkgroup") await this.ensureThreadFork(message);
          await this.execute(
            message.contextKey,
            command,
            message.messageId,
            replyTarget,
            localImagePaths,
            message.userId,
            message,
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
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "turn_cancel") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.cancelSession(this.requireSession(contextKey, sessionId));
        } else if (kind === "queued_prompt_cancel") {
          await this.cancelQueuedPrompt(scopedAction);
        } else if (kind === "safe_restart_cancel") {
          const scheduleId = Number(scopedAction.value.scheduleId);
          if (!Number.isSafeInteger(scheduleId) || scheduleId <= 0) {
            throw new Error("安全重启卡片无效，请使用最新的状态卡片。");
          }
          if (!this.lifecycle?.cancelSafeRestart) {
            throw new Error("当前运行方式不支持取消安全重启。");
          }
          const cancelled = await this.lifecycle.cancelSafeRestart(scheduleId);
          if (!cancelled) {
            await this.outbound.sendText(contextKey, "该安全重启计划已失效，请查看最新状态卡片。");
          }
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
        } else if (kind === "session_fork_group") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.forkSessionReferenceToFeishuGroup(contextKey, sessionId, scopedAction.userId);
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_new") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.createProjectSessionFromReference(contextKey, sessionId);
          await this.refreshSessionsCardFromAction(scopedAction);
        } else if (kind === "session_new_group") {
          const sessionId = String(scopedAction.value.sessionId ?? "");
          await this.createFeishuGroupFromReference(contextKey, sessionId, scopedAction.userId);
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
        } else if (kind === "settings_tab_open") {
          await this.openExecutionSettings(contextKey, executionSettingsTabValue(scopedAction.value.tab), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_agent_select") {
          await this.setDefaultAgent(contextKey, String(scopedAction.value.agent ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_provider_select") {
          await this.selectProvider(contextKey, String(scopedAction.value.provider ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_model_select") {
          await this.model(contextKey, String(scopedAction.value.model ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "settings_thinking_select") {
          await this.thinking(contextKey, String(scopedAction.value.effort ?? ""), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
            expectedModel: String(scopedAction.value.model ?? ""),
          });
        } else if (kind === "settings_permission_select") {
          await this.permissions(contextKey, permissionModeValue(scopedAction.value.permissionMode), {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
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
        } else if (kind === "provider_open") {
          await this.openExecutionSettings(contextKey, "provider", {
            sessionId: String(scopedAction.value.sessionId ?? ""),
            updateMessageId: scopedAction.messageId,
          });
        } else if (kind === "provider_select" || kind === "provider_model_open") {
          await this.openProviderModelSelector(
            contextKey,
            String(scopedAction.value.provider ?? ""),
            permissionModeValue(scopedAction.value.permissionMode),
            String(scopedAction.value.sessionId ?? ""),
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "provider_model_select" || kind === "provider_reasoning_open") {
          await this.openProviderReasoningSelector(
            contextKey,
            String(scopedAction.value.provider ?? ""),
            String(scopedAction.value.model ?? ""),
            permissionModeValue(scopedAction.value.permissionMode),
            String(scopedAction.value.sessionId ?? ""),
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "provider_reasoning_select") {
          await this.openProviderPermissionSelector(
            contextKey,
            String(scopedAction.value.provider ?? ""),
            String(scopedAction.value.model ?? ""),
            String(scopedAction.value.effort ?? ""),
            permissionModeValue(scopedAction.value.permissionMode),
            String(scopedAction.value.sessionId ?? ""),
            requiredCardMessageId(scopedAction.messageId),
          );
        } else if (kind === "provider_permission_select") {
          await this.applyProviderSettings(
            contextKey,
            {
              provider: String(scopedAction.value.provider ?? ""),
              model: String(scopedAction.value.model ?? ""),
              effort: String(scopedAction.value.effort ?? ""),
              mode: permissionModeValue(scopedAction.value.permissionMode),
            },
            {
              sessionId: String(scopedAction.value.sessionId ?? ""),
              updateMessageId: scopedAction.messageId,
            },
          );
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
    if (!record || record.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    await this.cancelSession(record);
    return `Task stop requested: ${record.title ?? record.remoteSessionId ?? record.localSessionId}`;
  }

  async controlGetTaskStatus(localSessionId: string): Promise<{
    session: SessionRecord;
    snapshot?: TurnViewState;
    remote?: RemoteSessionSummary;
  }> {
    const record = this.store.getSession(localSessionId);
    if (!record) throw new Error(`Task not found: ${localSessionId}`);
    let remote: RemoteSessionSummary | undefined;
    if (record.remoteSessionId) {
      const runtime = this.runtimes.forAgent(record.agentName);
      if (runtime.readRemoteSession) {
        try {
          remote = await runtime.readRemoteSession(record.remoteSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: record.localSessionId }, "Failed to inspect App Server task status for CLI.");
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
    if (!normalizedTitle) throw new Error("The task title cannot be empty.");
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
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
    return `Task title changed to: ${normalizedTitle}`;
  }

  async controlSendTaskPrompt(localSessionId: string, text: string): Promise<string> {
    const promptText = text.trim();
    if (!promptText) throw new Error("The Prompt cannot be empty.");
    const record = this.store.getSession(localSessionId);
    if (!record || record.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    const runtime = this.runtimes.forAgent(record.agentName);
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
      throw new Error("Could not resolve the target task's thread reply location. The Prompt was not sent.");
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
        this.agentLabel(scopedRecord.agentName),
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
    return `The Prompt was posted to the original chat and submitted to the task: ${record.title ?? record.remoteSessionId ?? record.localSessionId}`;
  }

  async controlCreateTaskGroup(
    localSessionId: string,
    requestedTitle: string | undefined,
    userOpenId: string | undefined,
    requestedProjectCwd?: string,
    forceProjectless = false,
    requestedAgentName?: string,
  ): Promise<ControlTaskGroupResult> {
    const source = this.store.getSession(localSessionId);
    if (!source || source.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    const agentName = requestedAgentName?.trim() || source.agentName;
    const agent = this.ensureAgent(agentName);
    if (forceProjectless && agent.kind !== "app-server") {
      throw new Error("task newgroup --nodir is only available for App Server agents.");
    }
    const sourceContextKey = this.outbound.getSessionContextKey(localSessionId) ?? source.contextKey;
    const replyTarget = this.outbound.getSessionReplyTarget(localSessionId);
    const boundProjectCwd = forceProjectless
      ? undefined
      : requestedProjectCwd === undefined
        ? detectProjectlessWorkspace(source.cwd) ? undefined : source.cwd
        : resolveUserPath(requestedProjectCwd);
    const created = await this.outbound.withReplyTarget(sourceContextKey, replyTarget, () =>
      this.createFeishuGroupWithTask(
        sourceContextKey,
        agentName,
        requestedTitle,
        userOpenId,
        boundProjectCwd,
        source.agentName === agentName
          ? {
              modelProvider: source.modelProvider,
              model: source.model,
              reasoningEffort: source.reasoningEffort,
              permissionMode: source.permissionMode,
            }
          : {},
      ));
    return {
      sourceLocalSessionId: source.localSessionId,
      group: created.group,
      task: created.task,
    };
  }

  async controlForkTaskGroup(
    localSessionId: string,
    requestedTitle: string | undefined,
    userOpenId: string | undefined,
  ): Promise<ControlTaskGroupResult> {
    const source = this.store.getSession(localSessionId);
    if (!source || source.status === "closed") throw new Error(`Task not found: ${localSessionId}`);
    const sourceContextKey = this.outbound.getSessionContextKey(localSessionId) ?? source.contextKey;
    const replyTarget = this.outbound.getSessionReplyTarget(localSessionId);
    const plan = await this.prepareForkSession(sourceContextKey, localSessionId, requestedTitle);
    const prepared: ForkGroupSessionPlan = {
      plan,
      sourceDescription: plan.forkedFromHistoricalTurn
        ? "当前任务最近已完成轮次"
        : "当前任务最新轮次",
    };
    const forked = await this.outbound.withReplyTarget(sourceContextKey, replyTarget, () =>
      this.forkPreparedSessionToFeishuGroup(
        sourceContextKey,
        prepared,
        userOpenId ?? "",
        "当前任务",
      ));
    return {
      sourceLocalSessionId: source.localSessionId,
      sourceTurnId: plan.lastTurnId,
      group: forked.group,
      task: forked.task,
    };
  }

  private cardActionContextKey(action: CardAction): string {
    const explicit = typeof action.value.contextKey === "string" ? action.value.contextKey : undefined;
    if (explicit && baseChatContextKey(explicit) === baseChatContextKey(action.contextKey)) return explicit;

    const sessionReference = typeof action.value.sessionId === "string" ? action.value.sessionId : undefined;
    const session = sessionReference
      ? this.store.getSession(sessionReference) ?? this.findStoredSessionByReference(sessionReference)
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
    incomingMessage?: IncomingMessage,
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    switch (command.type) {
      case "shell":
        await this.runShellCommand(contextKey, command.command);
        return;
      case "new":
        if (command.projectless && this.ensureAgent(context.defaultAgent).kind !== "app-server") {
          throw new Error("/new --nodir 仅支持 App Server Agent。");
        }
        await this.createSession(
          contextKey,
          context.defaultAgent,
          command.projectless
            ? undefined
            : command.cwd === undefined
              ? this.inheritedNewTaskCwd(contextKey)
              : resolveUserPath(command.cwd),
          true,
          false,
          undefined,
          undefined,
          command.title,
          this.inheritedExecutionSettings(contextKey, context.defaultAgent),
        );
        return;
      case "newgroup":
        if (command.projectless && this.ensureAgent(context.defaultAgent).kind !== "app-server") {
          throw new Error("/newgroup --nodir 仅支持 App Server Agent。");
        }
        await this.createFeishuGroup(
          contextKey,
          context.defaultAgent,
          command.title,
          userId,
          command.cwd === undefined ? undefined : resolveUserPath(command.cwd),
          command.projectless === true,
        );
        return;
      case "forkgroup":
        await this.forkCurrentSessionToFeishuGroup(contextKey, command.title, userId, incomingMessage);
        return;
      case "fork":
        await this.forkSessionReference(contextKey, command.sessionId);
        return;
      case "title":
        await this.setTitle(contextKey, command.title);
        return;
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
        else await this.openAgentSettings(contextKey);
        return;
      case "status":
        await this.status(contextKey, command.sessionId);
        return;
      case "goal":
        await this.goal(contextKey, command);
        return;
      case "restart":
        if (!this.lifecycle) throw new Error("当前运行方式不支持自动重启。");
        await this.lifecycle.restart(contextKey, command.force === true);
        return;
      case "model":
        await this.openExecutionSettings(contextKey, "model");
        return;
      case "provider":
        await this.openProviderSettings(contextKey);
        return;
      case "thinking":
        await this.openExecutionSettings(contextKey, "thinking");
        return;
      case "permissions":
        await this.openExecutionSettings(contextKey, "permission");
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
      this.outbound.registerSession(
        session.localSessionId,
        turnContextKey,
        session.title,
        session.cwd,
        this.agentLabel(session.agentName),
      );
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
    if (!text.trim()) throw new Error("请输入要交给 Agent 的内容。");
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
    const configuredRuntime = this.runtimes.forAgent(record.agentName);
    if (!configuredRuntime.getSession(record.localSessionId)) {
      this.outbound.registerSession(
        record.localSessionId,
        contextKey,
        record.title,
        record.cwd,
        this.agentLabel(record.agentName),
      );
      await this.outbound.startPendingTurn(record.localSessionId, contextKey, record.title, replyTarget, text);
    }
    let loaded: LoadedSession;
    try {
      loaded = await this.loadSession(record);
    } catch (error) {
      await this.outbound.failPendingTurn(record.localSessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    let remoteActivity: RemoteSessionActivity | undefined;
    try {
      remoteActivity = await this.assertSessionTurnOwnership(loaded.record, loaded.runtime);
    } catch (error) {
      await this.outbound.failPendingTurn(record.localSessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (needsFullSessionSynchronization(loaded.record, loaded.session, remoteActivity)) {
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
        this.logger.debug({ error, sessionId: record.localSessionId, activeTurnId }, "Steering failed; reconciling the App Server thread.");
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
              "Failed to steer the reconciled App Server turn; queueing prompt.",
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
    const { anchor, source, snapshot } = this.resolveThreadForkAnchor(message);
    const agent = this.ensureAgent(source.agentName);
    const runtime = this.runtimes.forAgent(source.agentName);
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 App Server Agent 不支持 fork 任务。");
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
      modelProvider: source.modelProvider,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      permissionMode: source.permissionMode ?? "auto",
    });
    this.store.setCurrentSession(message.contextKey, localSessionId);
    this.outbound.registerSession(
      localSessionId,
      message.contextKey,
      forkTitle,
      source.cwd,
      this.agentLabel(source.agentName),
    );

    try {
      const forked = await runtime.forkSession({
        localSessionId,
        remoteSessionId: source.remoteSessionId!,
        lastTurnId: anchor.turnId,
        agentName: source.agentName,
        cwd: source.cwd,
        title: forkTitle,
        modelProvider: source.modelProvider,
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

  private resolveThreadForkAnchor(message: IncomingMessage): ResolvedThreadForkAnchor {
    if (!message.threadContext || !message.threadId || !message.chatId) {
      throw new Error("当前消息不属于可识别的飞书话题。");
    }
    const anchorMessageIds = [message.rootMessageId, message.parentMessageId]
      .filter((messageId): messageId is string => Boolean(messageId && messageId !== message.messageId));
    const anchor = [...new Set(anchorMessageIds)]
      .map((messageId) => this.store.findTurnAnchorByMessageId(messageId))
      .find((candidate) => candidate !== undefined);
    if (!anchor) {
      throw new Error("无法确定这个话题对应的 App Server 轮次，因此没有创建分支任务。请从该轮的用户消息、思考卡片或最终回答创建话题。");
    }

    const source = anchor.contextKey
      ? this.store.getSessionForContext(anchor.localSessionId, anchor.contextKey)
      : this.store.getSession(anchor.localSessionId);
    if (!source || !source.remoteSessionId || !this.isCodexSession(source)) {
      throw new Error("这个话题的来源不是可 fork 的 App Server 任务。");
    }
    if (baseChatContextKey(anchor.contextKey ?? source.contextKey) !== `chat_id:${message.chatId}`) {
      throw new Error("话题来源任务不属于当前会话，已拒绝创建分支。");
    }

    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(anchor.turnId));
    if (isTurnStillRunning(snapshot?.status)
      || (source.lastTurnId === anchor.turnId && source.lastTurnStatus === "running")) {
      throw new Error("话题对应的轮次仍在执行，App Server 暂时不能从这一轮 fork。请等待该轮完成后再在话题中发送消息。");
    }

    return { anchor, source, snapshot };
  }

  private async forkSessionReference(contextKey: string, reference?: string): Promise<void> {
    const plan = await this.prepareForkSession(contextKey, reference);
    const forked = await this.forkSessionIntoContext(contextKey, plan);
    const forkSourceLabel = plan.forkedFromHistoricalTurn
      ? `${plan.sourceLabel}最近已完成轮次`
      : plan.sourceLabel;
    await this.outbound.sendText(
      contextKey,
      `已从${forkSourceLabel}创建分支并切换到新任务：${
        forked.session.title
          ? `${forked.session.title}（${forked.session.remoteSessionId}）`
          : forked.session.remoteSessionId
      }`,
    );
  }

  private async prepareForkSession(
    contextKey: string,
    reference?: string,
    requestedTitle?: string,
  ): Promise<ForkSessionPlan> {
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
      const global = direct ?? this.findStoredSessionByReference(taskId);
      source = global ? { ...global, contextKey } : undefined;
    }

    if (source && (!source.remoteSessionId || !this.isCodexSession(source))) {
      throw new Error(`${sourceLabel}不是可 fork 的 App Server 任务。`);
    }

    let runtime: AgentRuntime;
    let agentName: string;
    let remote: RemoteSessionSummary | undefined;
    if (source) {
      agentName = source.agentName;
      runtime = this.runtimes.forAgent(agentName);
    } else {
      if (!taskId) throw new Error("缺少要 fork 的 App Server 任务 ID。");
      const resolved = await this.resolveRemoteCodexSession(taskId);
      agentName = resolved.agentName;
      runtime = resolved.runtime;
      remote = resolved.remote;
    }
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 App Server Agent 不支持 fork 任务。");
    }

    const remoteSessionId = source?.remoteSessionId ?? remote?.id ?? taskId;
    if (!remoteSessionId) throw new Error("当前任务尚未创建 App Server 任务 ID，暂时不能 fork。");
    if (!runtime.readRemoteSession && !source) {
      throw new Error("当前 App Server Agent 不支持读取指定任务。");
    }
    remote ??= runtime.readRemoteSession
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
    if (!cwd) throw new Error("指定的 App Server 任务没有可用的工作目录，暂时不能 fork。");
    const sourceTitle = remote?.title ?? source?.title ?? remote?.preview;
    const forkTitle = normalizeTaskTitle(requestedTitle) ?? this.store.nextForkTitle(sourceTitle);
    const modelProvider = remote?.modelProvider ?? source?.modelProvider;
    const model = remote?.model ?? source?.model;
    const reasoningEffort = source?.reasoningEffort;
    const permissionMode = source?.permissionMode ?? "auto";

    return {
      source,
      sourceLabel,
      runtime,
      agentName,
      remoteSessionId,
      lastTurnId,
      cwd,
      forkTitle,
      modelProvider,
      model,
      reasoningEffort,
      permissionMode,
      lastTurnStatus: forkedFromHistoricalTurn
        ? "completed"
        : mapRemoteTurnStatus(remote?.lastTurnStatus)
        ?? forkedTurnStatus(snapshot?.status)
        ?? source?.lastTurnStatus,
      sourceWasRunning: isRunning,
      forkedFromHistoricalTurn,
    };
  }

  private async prepareForkGroupSession(
    contextKey: string,
    requestedTitle: string | undefined,
    incomingMessage: IncomingMessage | undefined,
  ): Promise<ForkGroupSessionPlan> {
    if (!incomingMessage?.threadContext) {
      const plan = await this.prepareForkSession(contextKey, undefined, requestedTitle);
      return {
        plan,
        sourceDescription: plan.forkedFromHistoricalTurn
          ? "当前任务最近已完成轮次"
          : "当前任务最新轮次",
      };
    }

    const resolved = this.resolveThreadForkAnchor(incomingMessage);
    const topicSession = this.currentSession(contextKey);
    const topicTurnId = topicSession
      ? this.store.findLatestCompletedTurnId(topicSession.localSessionId, contextKey)
      : undefined;
    if (topicSession && topicTurnId) {
      return {
        plan: this.prepareForkSessionFromTurn(
          topicSession,
          topicTurnId,
          requestedTitle,
          "当前话题任务",
        ),
        sourceDescription: "当前话题任务最近已完成轮次",
      };
    }

    return {
      plan: this.prepareForkSessionFromTurn(
        resolved.source,
        resolved.anchor.turnId,
        requestedTitle,
        "话题原始轮次",
      ),
      sourceDescription: "话题原始轮次",
    };
  }

  private prepareForkSessionFromTurn(
    source: SessionRecord,
    lastTurnId: string,
    requestedTitle: string | undefined,
    sourceLabel: string,
  ): ForkSessionPlan {
    if (!source.remoteSessionId || !this.isCodexSession(source)) {
      throw new Error(`${sourceLabel}不是可 fork 的 App Server 任务。`);
    }
    const runtime = this.runtimes.forAgent(source.agentName);
    if (runtime.kind !== "codex" || !runtime.forkSession) {
      throw new Error("当前 App Server Agent 不支持 fork 任务。");
    }

    const snapshot = turnViewSnapshot(this.store.getTurnSnapshot(lastTurnId));
    if (isTurnStillRunning(snapshot?.status)) {
      throw new Error(`${sourceLabel}仍在执行，App Server 暂时不能从这一轮 fork。`);
    }
    const sourceWasRunning = Boolean(
      runtime.getSession(source.localSessionId)?.activeTurnId
      || source.lastTurnStatus === "running"
      || source.status === "running",
    );
    const forkTitle = normalizeTaskTitle(requestedTitle) ?? this.store.nextForkTitle(source.title);

    return {
      source,
      sourceLabel,
      runtime,
      agentName: source.agentName,
      remoteSessionId: source.remoteSessionId,
      lastTurnId,
      cwd: source.cwd,
      forkTitle,
      modelProvider: source.modelProvider,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      permissionMode: source.permissionMode ?? "auto",
      lastTurnStatus: forkedTurnStatus(snapshot?.status)
        ?? (source.lastTurnId === lastTurnId ? source.lastTurnStatus : undefined)
        ?? "completed",
      sourceWasRunning,
      forkedFromHistoricalTurn: sourceWasRunning && source.lastTurnId !== lastTurnId,
    };
  }

  private async forkSessionIntoContext(
    contextKey: string,
    plan: ForkSessionPlan,
  ): Promise<ForkSessionResult> {
    const localSessionId = createId("sess");
    const record = this.store.createSession({
      localSessionId,
      contextKey,
      agentName: plan.agentName,
      cwd: plan.cwd,
      status: "starting",
    });
    this.store.updateRuntimeSession(localSessionId, {
      runtimeKind: "codex",
      title: plan.forkTitle,
      modelProvider: plan.modelProvider,
      model: plan.model,
      reasoningEffort: plan.reasoningEffort,
      permissionMode: plan.permissionMode,
    });

    try {
      const forked = await plan.runtime.forkSession!({
        localSessionId,
        remoteSessionId: plan.remoteSessionId,
        lastTurnId: plan.lastTurnId,
        agentName: plan.agentName,
        cwd: plan.cwd,
        title: plan.forkTitle,
        modelProvider: plan.modelProvider,
        model: plan.model,
        reasoningEffort: plan.reasoningEffort,
        permissionMode: plan.permissionMode,
      });
      this.persistRuntimeSession(record, forked, "ready");
      this.store.updateRuntimeSession(localSessionId, {
        lastTurnId: plan.lastTurnId,
        lastTurnStatus: plan.lastTurnStatus,
      });
      this.store.setCurrentSession(contextKey, localSessionId);
      this.outbound.registerSession(
        localSessionId,
        contextKey,
        forked.title ?? plan.forkTitle,
        plan.cwd,
        this.agentLabel(plan.agentName),
      );
      this.store.audit(contextKey, "session_forked", {
        sourceLocalSessionId: plan.source?.localSessionId,
        sourceRemoteSessionId: plan.remoteSessionId,
        sourceTurnId: plan.lastTurnId,
        sourceWasRunning: plan.sourceWasRunning,
        forkedLocalSessionId: localSessionId,
        forkedRemoteSessionId: forked.remoteSessionId,
      });
      return {
        record: this.store.getSession(localSessionId) ?? record,
        session: forked,
      };
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
      throw error;
    }
  }

  private async createProjectSessionFromReference(contextKey: string, reference: string): Promise<void> {
    const resolved = await this.resolveProjectSessionReference(contextKey, reference);
    const created = await this.createSession(
      contextKey,
      resolved.agentName,
      resolved.cwd,
      true,
      false,
      undefined,
      undefined,
      undefined,
      resolved.executionSettings,
    );
    this.store.audit(contextKey, "project_session_created", {
      sourceLocalSessionId: resolved.source?.localSessionId,
      sourceRemoteSessionId: resolved.remoteSessionId,
      createdLocalSessionId: created.localSessionId,
      createdRemoteSessionId: created.remoteSessionId,
      cwd: resolved.cwd,
      ...resolved.executionSettings,
    });
  }

  private async resolveProjectSessionReference(
    contextKey: string,
    reference: string,
  ): Promise<ProjectSessionReference> {
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    if (direct?.status === "closed") {
      throw new Error(`找不到任务：${taskId}`);
    }
    const source = direct ?? this.findStoredSessionByReference(taskId);
    if (source && !this.isCodexSession(source)) {
      throw new Error("指定任务不是 App Server 任务，暂时不能按项目创建新任务。");
    }

    let agentName: string;
    let runtime: AgentRuntime;
    let remote: RemoteSessionSummary | undefined;
    if (source) {
      agentName = source.agentName;
      runtime = this.runtimes.forAgent(agentName);
    } else {
      const resolved = await this.resolveRemoteCodexSession(taskId);
      agentName = resolved.agentName;
      runtime = resolved.runtime;
      remote = resolved.remote;
    }

    const remoteSessionId = source?.remoteSessionId ?? remote?.id ?? taskId;
    if (!remote && runtime.readRemoteSession && remoteSessionId) {
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
      throw new Error("指定的 App Server 任务没有可用的工作目录，暂时不能按项目创建新任务。");
    }
    const executionSettings: SessionExecutionSettings = {
      modelProvider: remote?.modelProvider ?? source?.modelProvider,
      model: remote?.model ?? source?.model,
      reasoningEffort: remote?.reasoningEffort ?? source?.reasoningEffort,
      permissionMode: remote?.permissionMode ?? source?.permissionMode ?? "auto",
    };
    return {
      source,
      agentName,
      remoteSessionId,
      cwd,
      executionSettings,
    };
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
    await this.outbound.startPendingTurn(
      loaded.record.localSessionId,
      loaded.record.contextKey,
      title,
      replyTarget,
      text,
    );
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
    const sessionCwd = cwd === undefined && agent.kind === "app-server"
      ? createProjectlessWorkspace({ prompt: initialTitle }).cwd
      : path.resolve(cwd ?? this.config.defaults.cwd);
    const record = this.store.createSession({ localSessionId, contextKey, agentName, cwd: sessionCwd, status: "starting" });
    if (initialTitle || executionSettings.modelProvider || executionSettings.model || executionSettings.reasoningEffort || executionSettings.permissionMode) {
      this.store.updateRuntimeSession(localSessionId, {
        title: initialTitle,
        modelProvider: executionSettings.modelProvider,
        model: executionSettings.model,
        reasoningEffort: executionSettings.reasoningEffort,
        permissionMode: executionSettings.permissionMode,
      });
    }
    this.store.setCurrentSession(contextKey, localSessionId);
    this.outbound.registerSession(
      localSessionId,
      contextKey,
      initialTitle,
      sessionCwd,
      this.agentLabel(agentName),
    );
    const runtime = this.runtimes.forAgent(agentName);
    try {
      if (prepareTurn) {
        await this.outbound.startPendingTurn(localSessionId, contextKey, initialTitle, replyTarget, prompt);
      }
      const session = await runtime.createSession({
        localSessionId,
        agentName,
        cwd: sessionCwd,
        title: initialTitle,
        modelProvider: executionSettings.modelProvider,
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
    requestedProjectCwd?: string,
    forceProjectless = false,
  ): Promise<void> {
    const source = this.currentSession(sourceContextKey);
    const boundProjectCwd = forceProjectless
      ? undefined
      : requestedProjectCwd ?? this.currentProjectCwd(sourceContextKey);
    const executionSettings: SessionExecutionSettings = source?.agentName === agentName
      ? {
          modelProvider: source.modelProvider,
          model: source.model,
          reasoningEffort: source.reasoningEffort,
          permissionMode: source.permissionMode,
        }
      : {};
    await this.createFeishuGroupWithTask(
      sourceContextKey,
      agentName,
      requestedTitle,
      userId,
      boundProjectCwd,
      executionSettings,
    );
  }

  private async createFeishuGroupFromReference(
    sourceContextKey: string,
    reference: string,
    userId: string | undefined,
  ): Promise<void> {
    const resolved = await this.resolveProjectSessionReference(sourceContextKey, reference);
    const boundProjectCwd = detectProjectlessWorkspace(resolved.cwd) ? undefined : resolved.cwd;
    await this.createFeishuGroupWithTask(
      sourceContextKey,
      resolved.agentName,
      undefined,
      userId,
      boundProjectCwd,
      resolved.executionSettings,
    );
  }

  private async createFeishuGroupWithTask(
    sourceContextKey: string,
    agentName: string,
    requestedTitle: string | undefined,
    userId: string | undefined,
    boundProjectCwd: string | undefined,
    executionSettings: SessionExecutionSettings,
  ): Promise<CreatedFeishuTaskGroup> {
    const explicitTitle = normalizeTaskTitle(requestedTitle);
    const taskTitle = explicitTitle ?? `新任务 (${formatGroupDateSuffix(new Date())})`;
    const group = await this.createFeishuGroupContext(
      sourceContextKey,
      agentName,
      taskTitle,
      userId,
      boundProjectCwd,
      "/newgroup",
      false,
    );

    let task: SessionRecord;
    try {
      task = await this.createSession(
        group.contextKey,
        agentName,
        boundProjectCwd,
        false,
        false,
        undefined,
        undefined,
        taskTitle,
        executionSettings,
      );
    } catch (error) {
      await this.outbound.sendText(
        group.contextKey,
        `群已创建，但新任务创建失败：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    const taskDescription = task.title
      ? `${task.title}（${task.remoteSessionId}）`
      : task.remoteSessionId ?? task.localSessionId;
    await this.outbound.sendText(
      group.contextKey,
      [
        "群和新任务已创建。",
        `当前任务：${taskDescription}`,
        `当前 Project 目录：${boundProjectCwd ?? "未绑定（Projectless）"}`,
        `当前 Provider：${task.modelProvider ?? "Agent 默认"}`,
        `当前模型：${task.model ?? "默认"}`,
        `思考强度：${task.reasoningEffort ?? "自动"}`,
        `权限类型：${task.permissionMode === "confirm" ? "执行前确认" : "自动执行"}`,
      ].join("\n"),
    );
    await this.outbound.sendText(
      sourceContextKey,
      `已创建飞书群：${group.name}，并创建新任务 ${taskDescription}。`,
    );
    return { group, task };
  }

  private async forkCurrentSessionToFeishuGroup(
    sourceContextKey: string,
    requestedTitle: string | undefined,
    userId: string | undefined,
    incomingMessage: IncomingMessage | undefined,
  ): Promise<void> {
    if (!userId?.startsWith("ou_")) {
      throw new Error("/forkgroup 只能由具有 open_id 的飞书用户消息触发。");
    }
    const prepared = await this.prepareForkGroupSession(sourceContextKey, requestedTitle, incomingMessage);
    await this.forkPreparedSessionToFeishuGroup(
      sourceContextKey,
      prepared,
      userId,
      incomingMessage?.threadContext ? prepared.sourceDescription : "当前任务",
    );
  }

  private async forkSessionReferenceToFeishuGroup(
    sourceContextKey: string,
    reference: string,
    userId: string | undefined,
  ): Promise<void> {
    if (!userId?.startsWith("ou_")) {
      throw new Error("ForkGroup 只能由具有 open_id 的飞书用户触发。");
    }
    const plan = await this.prepareForkSession(sourceContextKey, reference);
    await this.forkPreparedSessionToFeishuGroup(
      sourceContextKey,
      {
        plan,
        sourceDescription: plan.forkedFromHistoricalTurn
          ? "指定任务最近已完成轮次"
          : "指定任务最新轮次",
      },
      userId,
      "指定任务",
    );
  }

  private async forkPreparedSessionToFeishuGroup(
    sourceContextKey: string,
    prepared: ForkGroupSessionPlan,
    userId: string,
    sourceSummary: string,
  ): Promise<CreatedFeishuTaskGroup> {
    const { plan } = prepared;
    const boundProjectCwd = detectProjectlessWorkspace(plan.cwd) ? undefined : plan.cwd;
    const group = await this.createFeishuGroupContext(
      sourceContextKey,
      plan.agentName,
      plan.forkTitle,
      userId,
      boundProjectCwd,
      "/forkgroup",
      false,
    );

    let forked: ForkSessionResult;
    try {
      forked = await this.forkSessionIntoContext(group.contextKey, plan);
    } catch (error) {
      await this.outbound.sendText(
        group.contextKey,
        `群已创建，但 Fork 任务失败：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    const taskDescription = forked.session.title
      ? `${forked.session.title}（${forked.session.remoteSessionId}）`
      : forked.session.remoteSessionId;
    await this.outbound.sendText(
      group.contextKey,
      [
        `已从${prepared.sourceDescription}创建分支。`,
        `当前任务：${taskDescription}`,
        `当前 Project 目录：${boundProjectCwd ?? "未绑定（Projectless）"}`,
        `当前 Provider：${forked.session.modelProvider ?? "Agent 默认"}`,
        `当前模型：${forked.session.model ?? "默认"}`,
        `思考强度：${forked.session.reasoningEffort ?? "自动"}`,
        `权限类型：${forked.session.permissionMode === "confirm" ? "执行前确认" : "自动执行"}`,
      ].join("\n"),
    );
    await this.outbound.sendText(
      sourceContextKey,
      `已将${sourceSummary} Fork 到飞书群：${group.name}；新群当前任务为 ${taskDescription}。`,
    );
    return { group, task: forked.record };
  }

  private async createFeishuGroupContext(
    sourceContextKey: string,
    agentName: string,
    taskTitle: string,
    userId: string | undefined,
    boundProjectCwd: string | undefined,
    commandName: "/newgroup" | "/forkgroup",
    includeTimestamp: boolean,
  ): Promise<CreatedFeishuGroupContext> {
    if (!userId?.startsWith("ou_")) {
      throw new Error(`${commandName} 只能由具有 open_id 的飞书用户消息触发。`);
    }
    const groupName = formatNewGroupName(agentName, boundProjectCwd, taskTitle, new Date(), includeTimestamp);
    const group = await this.outbound.createGroup(sourceContextKey, {
      name: groupName,
      userOpenId: userId,
      avatarPng: generateGroupAvatarPng(
        resolveGroupAvatarProjectName(boundProjectCwd, taskTitle),
        boundProjectCwd,
      ),
    });
    const groupContextKey = `chat_id:${group.chatId}`;
    this.store.recordChatContext(groupContextKey, "group");
    this.store.getOrCreateUserContext(groupContextKey, agentName);
    if (boundProjectCwd) this.store.setBoundProjectCwd(groupContextKey, boundProjectCwd);
    return { chatId: group.chatId, contextKey: groupContextKey, name: group.name };
  }

  private async loadSession(record: SessionRecord): Promise<LoadedSession> {
    const agent = this.ensureAgent(record.agentName);
    const runtime = this.runtimes.forAgent(record.agentName);
    const existing = runtime.getSession(record.localSessionId);
    if (existing) return { record, runtime, session: existing };
    const pending = this.sessionLoads.get(record.localSessionId);
    if (pending) return pending;

    this.outbound.registerSession(
      record.localSessionId,
      record.contextKey,
      record.title,
      record.cwd,
      this.agentLabel(record.agentName),
    );
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
            modelProvider: record.modelProvider,
            model: record.model,
            reasoningEffort: record.reasoningEffort,
            permissionMode,
            activeTurnId: agent.kind === "app-server" && record.status === "running" && record.lastTurnStatus === "running"
              ? record.lastTurnId
              : undefined,
            lastTurnId: record.lastTurnId,
            lastTurnStatus: record.lastTurnStatus,
          });
        } catch (error) {
          if (!(agent.kind === "app-server" && !record.lastTurnId && isMissingRolloutError(error))) throw error;
          this.logger.warn({ error, sessionId: record.localSessionId }, "App Server task has no rollout; creating a replacement task.");
          session = await runtime.createSession({
            localSessionId: record.localSessionId,
            agentName: record.agentName,
            cwd: record.cwd,
            title: record.title,
            modelProvider: record.modelProvider,
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
          modelProvider: record.modelProvider,
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
      modelProvider: session.modelProvider,
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

    let presentationError: unknown;
    try {
      await this.outbound.onEvent(event);
    } catch (error) {
      presentationError = error;
    }

    if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      const terminalStatus = event.type === "turn_completed"
        ? "completed"
        : event.type === "turn_cancelled"
          ? "cancelled"
          : "failed";
      const reactionSession = this.store.getSession(event.sessionId);
      if (
        !presentationError
        && reactionSession?.lastTurnId === event.turnId
        && reactionSession.lastTurnStatus === terminalStatus
      ) {
        await this.finalizeTurnMessageReactions(event.turnId, terminalStatus);
      }

      const latest = this.store.getSession(event.sessionId);
      const activeTurnId = latest
        ? this.runtimes.forAgent(latest.agentName).getSession(event.sessionId)?.activeTurnId
        : undefined;
      if (latest?.lastTurnId === event.turnId && !activeTurnId) {
        this.store.updateSession(event.sessionId, { status: event.type === "turn_failed" ? "failed" : "ready" });
        await this.scheduleNextQueuedPrompt(event.sessionId);
      }
    }

    if (presentationError) throw presentationError;
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
      const remoteActivity = await this.assertSessionTurnOwnership(loaded.record, loaded.runtime);
      if (needsFullSessionSynchronization(loaded.record, loaded.session, remoteActivity)) {
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
    const runtime = this.runtimes.forAgent(record.agentName);
    if (runtime.kind === "codex" && record.remoteSessionId && runtime.interruptRemoteTurn) {
      if (runtime.getGoal && runtime.setGoal) {
        try {
          if (!runtime.getSession(record.localSessionId)) await this.loadSession(record);
          const goal = await runtime.getGoal(record.localSessionId);
          if (goal?.status === "active") await runtime.setGoal(record.localSessionId, { status: "paused" });
        } catch (error) {
          this.logger.warn(
            { error, sessionId: record.localSessionId },
            "Failed to pause the active Agent goal before interrupting its turn.",
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
            "Failed to inspect the current App Server turn before interrupting; using the locally tracked turn.",
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
      await this.outbound.sendText(record.contextKey, `已向 Agent 发送 Interrupt 请求：${turnId}`);
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

  private async openExecutionSettings(
    contextKey: string,
    activeTab: ExecutionSettingsTab,
    options: ExecutionSettingsCardOptions = {},
  ): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.currentSession(contextKey);
    if (!record && activeTab !== "agent") this.requireCurrentSession(contextKey);
    const agents = Object.entries(this.config.agents).map(([name, agent]) => ({
      name,
      title: agent.title,
    }));

    let runtimeSettings: Omit<Parameters<CardRenderer["renderExecutionSettings"]>[0],
      "sessionId" | "contextKey" | "activeTab" | "currentAgent" | "taskAgent" | "agents" | "runtimeSettingsAvailable" | "notice"> = {
        currentPermissionMode: "auto",
        providers: [],
        providerSupported: false,
        models: [],
        reasoningOptions: [],
      };
    if (record) {
      const loaded = await this.loadSession(record);
      const models = await loaded.runtime.listModels();
      const currentModel = models.find((model) => model.id === loaded.session.model)
        ?? models.find((model) => model.isDefault);
      const providerSupported = loaded.runtime.kind === "codex" && Boolean(loaded.runtime.listModelProviders);
      const providers = providerSupported ? await this.modelProviderOptions(loaded) : [];
      const currentProvider = loaded.session.modelProvider ?? providers.find((provider) => provider.isDefault)?.id;
      const currentEffort = currentModel?.supportedReasoningEfforts.some(
        (option) => option.value === loaded.session.reasoningEffort,
      )
        ? loaded.session.reasoningEffort
        : currentModel?.defaultReasoningEffort ?? loaded.session.reasoningEffort;
      runtimeSettings = {
        currentProvider,
        currentModel: currentModel?.id ?? loaded.session.model,
        currentEffort,
        currentPermissionMode: loaded.session.permissionMode,
        providers,
        providerSupported,
        models,
        reasoningOptions: currentModel?.supportedReasoningEfforts ?? [],
      };
    }
    const card = this.cardRenderer.renderExecutionSettings({
      ...(record ? { sessionId: record.localSessionId, taskAgent: record.agentName } : {}),
      contextKey,
      activeTab,
      currentAgent: context.defaultAgent,
      agents,
      runtimeSettingsAvailable: Boolean(record),
      ...runtimeSettings,
      notice: options.notice,
    });
    if (options.updateMessageId) {
      await this.outbound.updateInteractiveCard(contextKey, options.updateMessageId, card);
    } else {
      await this.outbound.sendInteractiveCard(contextKey, card);
    }
  }

  private async openAgentSettings(contextKey: string): Promise<void> {
    const current = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!).defaultAgent;
    if (Object.keys(this.config.agents).length <= 1) {
      await this.outbound.sendText(contextKey, `当前 Agent：${current}\n当前没有其他 Agent 可以切换。`);
      return;
    }
    await this.openExecutionSettings(contextKey, "agent");
  }

  private async openProviderSettings(contextKey: string): Promise<void> {
    const loaded = await this.loadSession(this.requireCurrentSession(contextKey));
    const providers = loaded.runtime.kind === "codex" && loaded.runtime.listModelProviders
      ? await this.modelProviderOptions(loaded)
      : [];
    const current = loaded.session.modelProvider?.trim()
      || providers.find((provider) => provider.isDefault)?.id
      || "运行时默认";
    if (providers.length <= 1) {
      await this.outbound.sendText(contextKey, `当前 Provider：${current}\n当前没有其他 Provider 可以切换。`);
      return;
    }
    await this.openExecutionSettings(contextKey, "provider", { sessionId: loaded.record.localSessionId });
  }

  private async selectProvider(
    contextKey: string,
    modelProvider: string,
    options: ModelCardOptions = {},
  ): Promise<void> {
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    await this.assertModelProvider(loaded, modelProvider);
    const models = await loaded.runtime.listModels();
    const model = models.find((candidate) => candidate.id === loaded.session.model)
      ?? models.find((candidate) => candidate.isDefault);
    if (!model) throw new Error("当前运行时没有可用于 Provider 切换的模型。");
    const effort = model.supportedReasoningEfforts.some(
      (candidate) => candidate.value === loaded.session.reasoningEffort,
    )
      ? loaded.session.reasoningEffort
      : model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0]?.value;
    if (!effort) throw new Error(`模型 ${model.id} 没有可用于 Provider 切换的思考强度。`);
    await this.applyProviderSettings(contextKey, {
      provider: modelProvider,
      model: model.id,
      effort,
      mode: loaded.session.permissionMode,
    }, options);
  }

  private async openProviderSelector(
    contextKey: string,
    options: ExecutionSettingsCardOptions = {},
  ): Promise<void> {
    await this.openExecutionSettings(contextKey, "provider", options);
  }

  private async openProviderModelSelector(
    contextKey: string,
    modelProvider: string,
    permissionMode: PermissionMode,
    sessionId: string,
    updateMessageId: string,
  ): Promise<void> {
    const loaded = await this.loadSession(this.requireSession(contextKey, sessionId));
    await this.assertModelProvider(loaded, modelProvider);
    const models = await loaded.runtime.listModels();
    const card = this.cardRenderer.renderModelSelector({
      sessionId,
      contextKey,
      currentModel: loaded.session.model ?? models.find((model) => model.isDefault)?.id,
      reasoningEffort: loaded.session.reasoningEffort,
      models,
      modelProvider,
      permissionMode,
      unifiedSettings: true,
    });
    await this.outbound.updateInteractiveCard(contextKey, updateMessageId, card);
  }

  private async openProviderReasoningSelector(
    contextKey: string,
    modelProvider: string,
    model: string,
    permissionMode: PermissionMode,
    sessionId: string,
    updateMessageId: string,
  ): Promise<void> {
    const loaded = await this.loadSession(this.requireSession(contextKey, sessionId));
    await this.assertModelProvider(loaded, modelProvider);
    const models = await loaded.runtime.listModels();
    const selected = models.find((candidate) => candidate.id === model);
    if (!selected) throw new Error(`未知模型：${model}`);
    const currentEffort = selected.supportedReasoningEfforts.some(
      (option) => option.value === loaded.session.reasoningEffort,
    )
      ? loaded.session.reasoningEffort
      : selected.defaultReasoningEffort;
    const card = this.cardRenderer.renderReasoningSelector({
      sessionId,
      contextKey,
      modelProvider,
      model,
      currentEffort,
      options: selected.supportedReasoningEfforts,
      permissionMode,
      unifiedSettings: true,
    });
    await this.outbound.updateInteractiveCard(contextKey, updateMessageId, card);
  }

  private async openProviderPermissionSelector(
    contextKey: string,
    modelProvider: string,
    model: string,
    effort: string,
    permissionMode: PermissionMode,
    sessionId: string,
    updateMessageId: string,
  ): Promise<void> {
    const loaded = await this.loadSession(this.requireSession(contextKey, sessionId));
    await this.assertProviderModelSettings(loaded, modelProvider, model, effort);
    await this.outbound.updateInteractiveCard(
      contextKey,
      updateMessageId,
      this.cardRenderer.renderPermissionSelector({
        sessionId,
        contextKey,
        modelProvider,
        model,
        reasoningEffort: effort,
        currentMode: permissionMode,
      }),
    );
  }

  private async applyProviderSettings(
    contextKey: string,
    settings: { provider: string; model: string; effort: string; mode: PermissionMode },
    options: ModelCardOptions = {},
  ): Promise<void> {
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    await this.assertProviderModelSettings(loaded, settings.provider, settings.model, settings.effort);
    if (!loaded.runtime.setExecutionSettings) {
      throw new Error("当前运行时不支持 Provider 设置。");
    }
    const session = await loaded.runtime.setExecutionSettings(loaded.record.localSessionId, {
      modelProvider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.effort,
      permissionMode: settings.mode,
    });
    this.store.updateRuntimeSession(loaded.record.localSessionId, {
      modelProvider: session.modelProvider ?? settings.provider,
      model: session.model ?? settings.model,
      reasoningEffort: session.reasoningEffort ?? settings.effort,
      permissionMode: session.permissionMode,
    });
    const notice = [
      `Provider 已切换为 ${cardCode(session.modelProvider ?? settings.provider)}`,
      `模型 ${cardCode(session.model ?? settings.model)}`,
      `思考强度 ${cardCode(session.reasoningEffort ?? settings.effort)}`,
      `权限 ${cardCode(session.permissionMode)}`,
      "从下一次请求生效。",
    ].join("，");
    if (options.updateMessageId) {
      await this.openProviderSelector(contextKey, {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice,
      });
    } else {
      await this.outbound.sendText(contextKey, notice.replaceAll("`", ""));
    }
  }

  private async assertProviderModelSettings(
    loaded: LoadedSession,
    modelProvider: string,
    model: string,
    effort: string,
  ): Promise<void> {
    await this.assertModelProvider(loaded, modelProvider);
    const selected = (await loaded.runtime.listModels()).find((candidate) => candidate.id === model);
    if (!selected) throw new Error(`未知模型：${model}`);
    if (!selected.supportedReasoningEfforts.some((option) => option.value === effort)) {
      const supported = selected.supportedReasoningEfforts.map((option) => option.value).join("、") || "无";
      throw new Error(`模型 ${model} 不支持思考强度 ${effort}。支持的强度：${supported}`);
    }
  }

  private async assertModelProvider(loaded: LoadedSession, modelProvider: string): Promise<void> {
    const providers = await this.modelProviderOptions(loaded);
    if (!providers.some((provider) => provider.id === modelProvider)) {
      throw new Error(`未知 Provider：${modelProvider}`);
    }
  }

  private async modelProviderOptions(loaded: LoadedSession) {
    if (loaded.runtime.kind !== "codex" || !loaded.runtime.listModelProviders) {
      throw new Error("当前任务不支持 Provider 设置。");
    }
    const providers = await loaded.runtime.listModelProviders();
    const current = loaded.session.modelProvider?.trim();
    if (current && !providers.some((provider) => provider.id === current)) {
      providers.unshift({ id: current });
    }
    return providers;
  }

  private async model(contextKey: string, model?: string, options: ModelCardOptions = {}): Promise<void> {
    if (!model) {
      await this.openExecutionSettings(contextKey, "model", options);
      return;
    }
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
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
    if (options.updateMessageId) {
      await this.openExecutionSettings(contextKey, "model", {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice: `模型已切换为 ${cardCode(model)}${effortMessage}，从下一次请求生效。`,
      });
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
      if (agent.kind !== "app-server") throw new Error("Goal 模式仅支持 App Server 任务。");
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
      throw new Error("当前 Agent 不支持 Goal 模式。");
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
          : "Goal 已恢复，Agent 会继续自动执行。",
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
      command.action === "edit" ? "Goal 已更新。" : "Goal 已启动，Agent 会持续执行直到完成、暂停或遇到阻塞。",
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
          `**App Server 任务 ID**：${cardText(record.remoteSessionId ?? "尚未创建")}`,
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
    await this.outbound.sendInteractiveCard(contextKey, this.cardRenderer.renderSectionsCard("Agent Goal", sections));
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
    if (!effort) {
      await this.openExecutionSettings(contextKey, "thinking", options);
      return;
    }
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

    if (!supported.some((option) => option.value === effort)) {
      const options = supported.map((option) => option.value).join("、") || "无";
      throw new Error(`不支持的思考强度：${effort}。支持的强度：${options}`);
    }
    await loaded.runtime.setReasoningEffort(loaded.record.localSessionId, effort);
    this.store.updateRuntimeSession(loaded.record.localSessionId, { reasoningEffort: effort });
    if (options.updateMessageId) {
      await this.openExecutionSettings(contextKey, "thinking", {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice: `思考强度已切换为 ${cardCode(effort)}，从下一次请求生效。`,
      });
      return;
    }
    await this.outbound.sendText(contextKey, `思考强度已切换为 ${effort}，从下一次请求生效。`);
  }

  private async permissions(
    contextKey: string,
    mode?: PermissionMode,
    options: ModelCardOptions = {},
  ): Promise<void> {
    if (!mode) {
      await this.openExecutionSettings(contextKey, "permission", options);
      return;
    }
    const record = options.sessionId
      ? this.requireSession(contextKey, options.sessionId)
      : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    await loaded.runtime.setPermissionMode(record.localSessionId, mode);
    loaded.session.permissionMode = mode;
    this.store.updateRuntimeSession(record.localSessionId, { permissionMode: mode });
    if (options.updateMessageId) {
      await this.openExecutionSettings(contextKey, "permission", {
        sessionId: loaded.record.localSessionId,
        updateMessageId: options.updateMessageId,
        notice: mode === "auto"
          ? "已切换为自动执行模式，从下一次请求生效。"
          : "已切换为执行前确认模式，从下一次请求生效。",
      });
      return;
    }
    await this.outbound.sendText(contextKey, mode === "auto" ? "已切换为自动执行模式。" : "已切换为执行前确认模式。");
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
    const remoteSessions: AgentRemoteSessionSummary[] = [];
    const remoteErrors: string[] = [];
    let remoteHasMore = false;
    await Promise.all(this.runtimes.entries("codex").map(async ([agentName, runtime]) => {
      if (!runtime.listRemoteSessions) return;
      try {
        const page = await runtime.listRemoteSessions({ searchTerm, limit: visibleCount });
        remoteSessions.push(...page.sessions.map((session) => ({ agentName, session })));
        remoteHasMore ||= Boolean(page.nextCursor);
      } catch (error) {
        this.logger.warn({ error, contextKey, agentName }, "Failed to list App Server sessions for an Agent.");
        remoteErrors.push(`${agentName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    const remoteHint = remoteErrors.length > 0
      ? `部分 Agent 的任务读取失败：${remoteErrors.join("；")}`
      : undefined;

    const entries = mergeTaskList(localSessions, remoteSessions, context.currentSessionId)
      .filter((entry) => !normalizedSearch
        || [entry.id, entry.title, entry.cwd, entry.agentName]
          .some((value) => value.toLowerCase().includes(normalizedSearch)))
      .sort((left, right) => Number(right.current) - Number(left.current)
        || Number(right.active) - Number(left.active)
        || right.updatedAt - left.updatedAt);
    const activeCount = entries.filter((entry) => entry.active).length;
    const visibleEntries = entries.slice(0, visibleCount);
    const hasMore = remoteHasMore || entries.length > visibleCount;
    this.lastSessionListings.set(contextKey, visibleEntries.map((entry) => entry.reference));
    const cardEntries = visibleEntries.map((entry, index) => {
      const marker = entry.current ? "✅" : entry.active ? "🟢 **活跃**" : "•";
      const showStop = entry.status === "外部执行中"
        && entry.reference !== options.forceSwitchTaskId
        && entry.id !== options.forceSwitchTaskId;
      const actions: TaskListCardAction[] = entry.current ? [] : [{
        text: showStop ? "Stop" : "Switch",
        type: showStop ? "danger" as const : "default" as const,
        value: {
          action: showStop ? "session_stop" : "session_switch",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
        },
      }];
      actions.push({
        text: "New",
        value: {
          action: "session_new",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
        },
      });
      actions.push({
        text: "NewGroup",
        value: {
          action: "session_new_group",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
        },
      });
      actions.push({
        text: "Fork",
        value: {
          action: "session_fork",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
        },
      });
      actions.push({
        text: "ForkGroup",
        value: {
          action: "session_fork_group",
          sessionId: entry.reference,
          ...(searchTerm ? { searchTerm } : {}),
          visibleCount: String(visibleCount),
          contextKey,
        },
      });
      actions.push({
        text: "Status",
        value: {
          action: "session_status",
          sessionId: entry.reference,
          contextKey,
        },
      });
      return {
        lines: [
          `**${index + 1}.**　${marker}　**${cardText(entry.title)}**　${cardText(entry.id)}`,
          `${entry.status} · ${entry.updatedLabel} · ${cardText(entry.agentName)} · ${cardText(entry.cwd || "目录未知")}`,
        ],
        actions,
      };
    });
    const card = this.cardRenderer.renderTaskListCard(
      searchTerm ? `App Server 任务：${searchTerm}` : "App Server 任务",
      activeCount > 0 ? `任务（${activeCount} 个活跃）` : "任务",
      cardEntries,
      [
        ...(remoteHint ? [remoteHint] : []),
        "点击 **New** 在对应任务的项目中创建新任务；点击 **Switch** 快速切换；点击 **Fork** 从任务最新已完成轮次创建分支；外部正在运行的任务显示 **Stop**，点击后发送 Interrupt 并变为 **Switch**。",
        "点击 **NewGroup** 在对应任务的项目中创建新群和新任务；点击 **ForkGroup** 从对应任务最新已完成轮次创建分支群。",
        "也可发送 **/switch [序号或任务 ID]**；不带参数切回上一个任务。外部正在执行的回合不会被接管。",
        "发送 **/fork [序号或任务 ID]**，可从当前或指定任务创建分支；任务运行中时使用最近已完成轮次。",
        "点击 **Status**，或发送 **/status [序号或任务 ID]**，查看当前或指定任务状态。",
      ],
      hasMore ? {
        text: "More",
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

  private findStoredSessionByReference(reference: string, contextKey?: string): SessionRecord | undefined {
    const scoped = parseRemoteSessionReference(reference);
    return scoped
      ? this.store.findSessionByRemoteSessionId(scoped.remoteSessionId, contextKey, scoped.agentName)
      : this.store.findSessionByRemoteSessionId(reference, contextKey);
  }

  private async resolveRemoteCodexSession(reference: string): Promise<AgentRemoteSession> {
    const scoped = parseRemoteSessionReference(reference);
    const candidates = scoped
      ? [[scoped.agentName, this.runtimes.forAgent(scoped.agentName)] as const]
      : this.runtimes.entries("codex");
    if (candidates.length === 0) throw new Error("未配置 App Server Agent。");

    const reads = await Promise.allSettled(candidates.map(async ([agentName, runtime]) => {
      if (runtime.kind !== "codex" || !runtime.readRemoteSession) {
        throw new Error(`Agent ${agentName} 不支持读取远端任务。`);
      }
      return {
        agentName,
        runtime,
        remote: await runtime.readRemoteSession(scoped?.remoteSessionId ?? reference),
      } satisfies AgentRemoteSession;
    }));
    const matches = reads
      .filter((result): result is PromiseFulfilledResult<AgentRemoteSession> => result.status === "fulfilled")
      .map((result) => result.value);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`多个 Agent 中存在相同任务 ID：${reference}。请先使用 /sessions，再通过序号选择任务。`);
    }
    const details = reads
      .map((result, index) => result.status === "rejected"
        ? `${candidates[index]?.[0] ?? "unknown"}: ${runtimeErrorMessage(result.reason)}`
        : undefined)
      .filter((detail): detail is string => Boolean(detail))
      .join("；");
    throw new Error(`找不到 App Server 任务：${scoped?.remoteSessionId ?? reference}${details ? `（${details}）` : ""}`);
  }

  private async switchSession(contextKey: string, reference?: string): Promise<void> {
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const taskId = this.resolveSessionReference(contextKey, reference);
    const direct = this.store.getSession(taskId);
    if (direct?.status === "closed") {
      throw new Error(`找不到任务：${taskId}`);
    }
    const existing = direct ?? this.findStoredSessionByReference(taskId);
    if (existing) {
      const runtime = this.runtimes.forAgent(existing.agentName);
      await this.assertSessionTurnOwnership(existing, runtime);
      this.store.attachSessionToContext(contextKey, existing.localSessionId);
      this.store.setCurrentSession(contextKey, existing.localSessionId);
      this.outbound.registerSession(
        existing.localSessionId,
        contextKey,
        existing.title,
        existing.cwd,
        this.agentLabel(existing.agentName),
      );
      await this.outbound.sendText(contextKey, `已切换到任务：${existing.title ?? existing.remoteSessionId ?? taskId}`);
      return;
    }

    const { agentName, remote } = await this.resolveRemoteCodexSession(taskId);
    if (remote.status === "active" || remote.lastTurnStatus === "inProgress") {
      throw new Error(`这个任务正在外部 Agent 中执行，当前不会切换。可使用 /status ${taskId} 查看进度。`);
    }
    if (!remote.cwd) throw new Error("这个 App Server 任务没有可用的工作目录，暂时无法切换。");
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
    this.outbound.registerSession(
      localSessionId,
      contextKey,
      remote.title ?? remote.preview,
      remote.cwd,
      this.agentLabel(agentName),
    );
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

    const existing = this.findStoredSessionByReference(taskId);
    if (existing) {
      await this.cancelSession({ ...existing, contextKey });
      return;
    }

    const { runtime, remote } = await this.resolveRemoteCodexSession(taskId);
    if (!runtime.readRemoteSession || !runtime.interruptRemoteTurn) {
      throw new Error("当前 App Server Agent 不支持停止外部任务。");
    }
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
    await this.outbound.sendText(contextKey, `已向 Agent 发送 Interrupt 请求：${turnId}`);
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

  private async assertSessionTurnOwnership(
    record: SessionRecord,
    runtime: AgentRuntime,
  ): Promise<RemoteSessionActivity | undefined> {
    if (runtime.kind !== "codex" || !record.remoteSessionId || !runtime.readRemoteSession) return;
    if (runtime.inspectRemoteSessionActivity) {
      let activity: RemoteSessionActivity;
      try {
        activity = await runtime.inspectRemoteSessionActivity(record.remoteSessionId);
      } catch (error) {
        if (!record.lastTurnId && isUnmaterializedCodexThreadError(error)) return { active: false };
        throw error;
      }
      const localActiveTurnId = runtime.getSession(record.localSessionId)?.activeTurnId;
      const runtimeOwnsActiveTurn = Boolean(localActiveTurnId)
        && (!activity.activeTurnId || activity.activeTurnId === localActiveTurnId);
      const persistedTurnMatches = record.status === "running"
        && record.lastTurnStatus === "running"
        && Boolean(record.lastTurnId)
        && activity.activeTurnId === record.lastTurnId;
      const botOwnsActiveTurn = runtimeOwnsActiveTurn || persistedTurnMatches;
      if (activity.active && !botOwnsActiveTurn) {
        throw new Error("这个任务正在外部 Agent 中执行。Agent Bot 不会接管或追加消息，请等待外部执行完成。");
      }
      return activity;
    }
    let remote: RemoteSessionSummary;
    try {
      remote = await runtime.readRemoteSession(record.remoteSessionId);
    } catch (error) {
      // App Server does not materialize a new thread until its first user message.
      // Such a thread has no turn to take over, so allow turn/start to create it.
      if (!record.lastTurnId && isUnmaterializedCodexThreadError(error)) return;
      throw error;
    }
    const botOwnsActiveTurn = isBotOwnedActiveTurn(record, remote);
    if ((remote.status === "active" || remote.lastTurnStatus === "inProgress") && !botOwnsActiveTurn) {
      throw new Error("这个任务正在外部 Agent 中执行。Agent Bot 不会接管或追加消息，请等待外部执行完成。");
    }
    return undefined;
  }

  private async setDefaultAgent(
    contextKey: string,
    agentName: string,
    options: ExecutionSettingsCardOptions = {},
  ): Promise<void> {
    this.ensureAgent(agentName);
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    this.store.setDefaultAgent(contextKey, agentName);
    if (Object.keys(this.config.agents).length <= 1) {
      await this.outbound.sendText(contextKey, `当前 Agent：${agentName}\n当前没有其他 Agent 可以切换。`);
      return;
    }
    await this.openExecutionSettings(contextKey, "agent", {
      ...options,
      notice: `默认 Agent 已切换为 ${cardCode(agentName)}，从下一次新建任务生效。`,
    });
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
        : this.findStoredSessionByReference(targetSessionId, contextKey);
      if (!current) {
        await this.statusForCodexTask(contextKey, targetSessionId, options);
        return;
      }
    } else {
      current = context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
    }

    if (current && current.status === "running") {
      try {
        const runtime = this.runtimes.forAgent(current.agentName);
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
      const runtime = this.runtimes.forAgent(current.agentName);
      if (runtime.readRemoteSession) {
        try {
          remote = await runtime.readRemoteSession(current.remoteSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to inspect App Server task status.");
        }
      }
      if (runtime.kind === "codex" && runtime.getGoal) {
        try {
          const loaded = runtime.getSession(current.localSessionId) ?? (await this.loadSession(current)).session;
          goal = await runtime.getGoal(loaded.localSessionId);
        } catch (error) {
          this.logger.warn({ error, sessionId: current.localSessionId }, "Failed to inspect Agent goal status.");
        }
      }
    }

    if (current) current = mergeRemoteTaskStatus(current, remote);

    const taskLines: string[] = [];
    let snapshot: TurnViewState | undefined;
    let activeTurnId: string | undefined;
    let queued = 0;
    if (!current) {
      taskLines.push("无。直接发送消息即可创建一个未指定项目的 Agent 任务。");
    } else {
      const agent = this.ensureAgent(current.agentName);
      const runtimeSession = this.runtimes.forAgent(current.agentName).getSession(current.localSessionId);
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
        `**Provider / 模型 / 思考强度**：${cardCode(current.modelProvider ?? "Agent 默认")} / ${cardCode(current.model ?? "默认")} / ${cardCode(current.reasoningEffort ?? "自动")}`,
        `**状态 / 最近结果**：${statusLabel} / ${resultLabel}`,
        `**Agent**：${cardCode(agent.title)}`,
        `**权限 / 任务范围**：${current.permissionMode === "confirm" ? "执行前确认" : "自动执行"} / ${detectProjectlessWorkspace(current.cwd) ? "未指定项目" : "指定项目"}`,
        `**App Server 任务 ID**：${cardCode(current.remoteSessionId ?? "尚未创建")}`,
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
        title: "Agent Bot",
        lines: [
          `**默认 Agent / 保活**：${cardCode(context.defaultAgent)} / ${this.lifecycle?.supervised ? "已启用" : "未启用"}`,
          "**交互方式**：普通消息继续当前任务；/new 创建新任务；/help 查看命令。",
        ],
      },
    ];
    const title = targetSessionId && current
      ? `Agent 状态：${truncateText((current.title ?? current.remoteSessionId ?? current.localSessionId).replace(/\s+/g, " "), 40)}`
      : "Agent 状态";
    const taskId = current?.remoteSessionId
      ? remoteSessionReference(current.agentName, current.remoteSessionId)
      : current?.localSessionId;
    const isCurrent = Boolean(current && current.localSessionId === context.currentSessionId);
    const remoteActive = isRemoteSessionActive(remote);
    const botOwnsActiveTurn = Boolean(localCurrent && remote && isBotOwnedActiveTurn(localCurrent, remote));
    const active = Boolean(activeTurnId || current?.status === "running" || remoteActive);
    const forceSwitch = Boolean(taskId && (
      options.forceSwitchTaskId === taskId
      || options.forceSwitchTaskId === current?.remoteSessionId
    ));
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
    reference: string,
    options: StatusCardOptions = {},
  ): Promise<void> {
    const { agentName, remote } = await this.resolveRemoteCodexSession(reference);
    const actionReference = remoteSessionReference(agentName, remote.id);
    const sections: CardSection[] = [
      {
        title: "指定任务",
        lines: [
          `**标题**：${cardCode(remote.title ?? remote.preview ?? "未命名任务")}`,
          `**工作目录**：${cardCode(remote.cwd || "目录未知")}`,
          `**状态 / 当前任务**：${remoteSessionDetailStatus(remote)} / 未切换`,
          `**Agent**：${cardCode(agentName)}`,
          `**App Server 任务 ID**：${cardCode(remote.id)}`,
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
            ? "外部 Agent 正在执行；Agent Bot 只读取状态，不会接管。"
            : `发送 **/switch ${cardText(remote.id)}** 切换到此任务。`,
        ],
        collapsible: true,
        elementId: "status_execution_details",
      },
    ];
    const title = `Agent 状态：${truncateText((remote.title ?? remote.preview ?? remote.id).replace(/\s+/g, " "), 40)}`;
    const showStop = isRemoteSessionActive(remote)
      && options.forceSwitchTaskId !== actionReference
      && options.forceSwitchTaskId !== remote.id;
    const actions = [
      statusRefreshAction(actionReference, contextKey),
      statusCardAction(
        showStop ? "Stop" : "Switch",
        showStop ? "danger" : "default",
        showStop ? "session_stop" : "session_switch",
        actionReference,
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
          "> 命令前缀示例：/sess 等同于 /sessions。",
          "> 命令缩写示例：/fg 等同于 /forkgroup。",
          "前缀或缩写匹配多个命令时，需要输入更长的形式。",
          "**[参数]** 可选　**&#60;参数&#62;** 必填",
        ],
      },
      {
        title: "任务管理",
        lines: [
          "**/new [title] [--dir &#60;cwd&#62; | --nodir]**　使用默认 Agent 创建任务；--nodir 强制创建 Projectless 任务",
          "**/newgroup [title] [--dir &#60;cwd&#62; | --nodir]**　创建飞书群和新任务；参数与 /new 相同",
          "**/forkgroup [title]**　从当前任务最新已完成轮次创建分支并绑定到新群",
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
          "**/queue &#60;prompt&#62;**（兼容 **/nosteer**）　不追加到当前轮次，按顺序排队为后续轮次",
          "**/goal [目标]**　查看或创建长任务 Goal；支持 pause、resume、edit、clear",
          "**/provider**　选择 AI 服务提供商；没有其他候选时仅显示当前 Provider",
          "**/model**　选择当前任务使用的模型",
          "**/thinking**　设置模型的思考强度",
          "**/permissions**　设置执行工具前是否需要确认",
        ],
      },
      {
        title: "Agent",
        lines: [
          "**/agent [name]**　选择新任务使用的默认 Agent；仅配置一个时直接显示当前 Agent",
        ],
      },
      {
        title: "系统",
        lines: [
          "**/status [序号或任务 ID]**　查看当前或指定任务的详细状态",
          "**/restart [--force]**　默认安全重启；--force 立即重启",
          "**/help**　显示本帮助",
        ],
      },
    ];
    await this.outbound.sendInteractiveCard(contextKey, this.cardRenderer.renderSectionsCard("Agent Bot 使用帮助", sections));
  }

  private ensureAgent(agentName: string) {
    const agent = this.config.agents[agentName];
    if (!agent) throw new Error(`未知 agent：${agentName}`);
    return agent;
  }

  private agentLabel(agentName: string): string {
    return this.ensureAgent(agentName).title;
  }

  private isCodexSession(session: SessionRecord): boolean {
    if (session.runtimeKind) return session.runtimeKind === "codex";
    return this.config.agents[session.agentName]?.kind === "app-server";
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

  private inheritedExecutionSettings(contextKey: string, agentName: string): SessionExecutionSettings {
    const current = this.currentSession(contextKey);
    if (!current || current.agentName !== agentName) return {};
    return {
      modelProvider: current.modelProvider,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      permissionMode: current.permissionMode,
    };
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
    text: "Refresh",
    value: {
      action: "session_status_refresh",
      ...(sessionId ? { sessionId } : {}),
      cardView: "status",
      contextKey,
    },
  };
}

interface UnifiedTaskListEntry {
  reference: string;
  id: string;
  agentName: string;
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
  remoteSessions: AgentRemoteSessionSummary[],
  currentLocalSessionId?: string,
): UnifiedTaskListEntry[] {
  const localByRemoteId = new Map(
    localSessions
      .filter((session) => session.runtimeKind === "codex" && session.remoteSessionId)
      .map((session) => [agentRemoteKey(session.agentName, session.remoteSessionId!), session]),
  );
  const representedLocalIds = new Set<string>();
  const entries = remoteSessions.map(({ agentName, session: remote }): UnifiedTaskListEntry => {
    const local = localByRemoteId.get(agentRemoteKey(agentName, remote.id));
    if (local) representedLocalIds.add(local.localSessionId);
    const active = remote.status === "active" || remote.lastTurnStatus === "inProgress";
    const status = remote.status === "active" || remote.lastTurnStatus === "inProgress"
      ? local && isBotOwnedActiveTurn(local, remote) ? "执行中" : "外部执行中"
      : remoteSessionStatusLabel(remote.status);
    const recencyAt = remote.recencyAt ?? remote.updatedAt;
    return {
      reference: remoteSessionReference(agentName, remote.id),
      id: remote.id,
      agentName,
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
      reference: local.remoteSessionId
        ? remoteSessionReference(local.agentName, local.remoteSessionId)
        : local.localSessionId,
      id: local.remoteSessionId ?? local.localSessionId,
      agentName: local.agentName,
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

function agentRemoteKey(agentName: string, remoteSessionId: string): string {
  return `${agentName}\u0000${remoteSessionId}`;
}

function remoteSessionReference(agentName: string, remoteSessionId: string): string {
  return `${REMOTE_SESSION_REFERENCE_PREFIX}${encodeURIComponent(agentName)}:${encodeURIComponent(remoteSessionId)}`;
}

function parseRemoteSessionReference(reference: string): { agentName: string; remoteSessionId: string } | undefined {
  if (!reference.startsWith(REMOTE_SESSION_REFERENCE_PREFIX)) return undefined;
  const value = reference.slice(REMOTE_SESSION_REFERENCE_PREFIX.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  try {
    const agentName = decodeURIComponent(value.slice(0, separator));
    const remoteSessionId = decodeURIComponent(value.slice(separator + 1));
    return agentName && remoteSessionId ? { agentName, remoteSessionId } : undefined;
  } catch {
    return undefined;
  }
}

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function permissionModeValue(value: unknown): PermissionMode {
  if (value === "auto" || value === "confirm") return value;
  throw new Error("权限模式只能是 auto 或 confirm。");
}

function executionSettingsTabValue(value: unknown): ExecutionSettingsTab {
  if (value === "agent" || value === "provider" || value === "model" || value === "thinking" || value === "permission") return value;
  throw new Error("设置卡片的 tab 无效，请重新发送设置命令。");
}

function requiredCardMessageId(value: string | undefined): string {
  if (value) return value;
  throw new Error("无法更新设置卡片，请重新发送设置命令。");
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
    modelProvider: remote.modelProvider ?? record.modelProvider,
    model: remote.model ?? record.model,
    reasoningEffort: remote.reasoningEffort ?? record.reasoningEffort,
    permissionMode: remote.permissionMode ?? record.permissionMode,
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

function needsFullSessionSynchronization(
  record: SessionRecord,
  session: RuntimeSession,
  remoteActivity: RemoteSessionActivity | undefined,
): boolean {
  if (!remoteActivity) return Boolean(record.lastTurnId || session.activeTurnId);
  return Boolean(session.activeTurnId && !remoteActivity.active);
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
  if (["model", "provider", "thinking", "permissions"].includes(command.type)) return true;
  return false;
}

function parseSessionVisibleCount(value: unknown): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= SESSION_PAGE_SIZE ? parsed : SESSION_PAGE_SIZE;
}

function isPromptCommand(command: Command): boolean {
  return command.type === "prompt" || command.type === "nosteer";
}

function runtimePrompt(text: string, localImagePaths?: string[]): RuntimePrompt {
  return localImagePaths?.length ? { text, localImagePaths } : text;
}

function formatGroupDateSuffix(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function formatNewGroupName(
  agentName: string,
  projectCwd: string | undefined,
  taskTitle: string,
  date: Date,
  includeTimestamp: boolean,
): string {
  const prefix = `[${agentName}] `;
  const projectPrefix = projectCwd ? `${formatGroupProjectDirectory(projectCwd)} ` : "";
  const titlePrefix = `${prefix}${projectPrefix}`;
  const timestampSuffix = includeTimestamp ? ` (${formatGroupDateSuffix(date)})` : "";
  const availableTitleLength = FEISHU_GROUP_NAME_MAX_LENGTH
    - Array.from(titlePrefix).length
    - Array.from(timestampSuffix).length;
  const title = truncateTail(taskTitle, availableTitleLength);
  return truncateTail(`${titlePrefix}${title}${timestampSuffix}`, FEISHU_GROUP_NAME_MAX_LENGTH);
}

const FEISHU_GROUP_NAME_MAX_LENGTH = 60;
const GROUP_PROJECT_DIRECTORY_MAX_LENGTH = 15;

function formatGroupProjectDirectory(projectCwd: string): string {
  const value = abbreviateHomeDirectory(projectCwd);
  if (Array.from(value).length <= GROUP_PROJECT_DIRECTORY_MAX_LENGTH) return `[${value}]`;

  const levels = value
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-2);
  return `[${fitTrailingPathLevels(levels, GROUP_PROJECT_DIRECTORY_MAX_LENGTH, path.sep)}]`;
}

function abbreviateHomeDirectory(value: string): string {
  const relative = path.relative(os.homedir(), value);
  if (relative === "") return "~";
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return value;
  return `~${path.sep}${relative}`;
}

function fitTrailingPathLevels(levels: string[], maxLength: number, separator: string): string {
  if (levels.length === 0) return "";
  if (levels.length === 1) return truncatePathLevel(levels[0]!, maxLength);
  const parent = levels[0]!;
  const leaf = levels[1]!;
  const joined = `${parent}${separator}${leaf}`;
  if (Array.from(joined).length <= maxLength) return joined;
  if (Array.from(leaf).length <= maxLength) return leaf;
  return truncatePathLevel(leaf, maxLength);
}

function truncatePathLevel(value: string, maxLength: number): string {
  return truncateTail(value, maxLength);
}

function truncateTail(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${characters.slice(0, maxLength - 3).join("")}...`;
}

function parseAgentGroupName(value: string): { agentName: string; title: string } | undefined {
  const match = /^\[([^[\]]+)\]\s+(.+)$/.exec(value.trim());
  const agentName = match?.[1]?.trim();
  const remainder = match?.[2]?.trim();
  if (!agentName || !remainder) return undefined;
  const projectPrefix = /^\[([^[\]]+)\](?:\s+(.+))?$/.exec(remainder);
  const title = projectPrefix ? projectPrefix[2]?.trim() : remainder;
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
