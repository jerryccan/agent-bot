import path from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { CommandRouter } from "../commands/CommandRouter.js";
import type { Command } from "../commands/commandTypes.js";
import type { CardAction, IncomingMessage } from "../feishu/types.js";
import type { OutboundRouter } from "../presentation/OutboundRouter.js";
import type { AgentRuntimeRegistry } from "../runtime/AgentRuntimeRegistry.js";
import type {
  AgentEvent,
  AgentRuntime,
  ApprovalDecision,
  PermissionMode,
  RuntimeSession,
} from "../runtime/types.js";
import { StateStore, type SessionRecord } from "../state/StateStore.js";
import { createId } from "../utils/id.js";
import { asInlineCode } from "../utils/markdown.js";

interface LoadedSession {
  record: SessionRecord;
  runtime: AgentRuntime;
  session: RuntimeSession;
}

export class ProxySessionController {
  private readonly router = new CommandRouter();
  private readonly messageQueues = new Map<string, Promise<void>>();
  private readonly sessionLoads = new Map<string, Promise<LoadedSession>>();
  private readonly queuedPrompts = new Map<string, string[]>();
  private readonly handledActions = new Set<string>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly runtimes: AgentRuntimeRegistry,
    private readonly outbound: OutboundRouter,
    private readonly logger: Logger,
  ) {
    for (const kind of ["acp", "codex"] as const) {
      this.unsubscribe.push(
        this.runtimes.get(kind).onEvent((event) => {
          void this.handleRuntimeEvent(event).catch((error: unknown) => {
            this.logger.warn({ error, event }, "Failed to present runtime event.");
          });
        }),
      );
    }
  }

  async onMessage(message: IncomingMessage): Promise<void> {
    this.store.audit(message.contextKey, "incoming_message", { messageId: message.messageId, text: message.text });
    let command: Command;
    try {
      command = this.router.parse(message.text);
    } catch (error) {
      await this.sendError(message.contextKey, error);
      return;
    }

    // Cancellation must not wait behind a prompt/session operation.
    if (command.type === "cancel") {
      try {
        await this.cancel(message.contextKey);
      } catch (error) {
        await this.sendError(message.contextKey, error);
      }
      return;
    }

    const previous = this.messageQueues.get(message.contextKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      try {
        await this.execute(message.contextKey, command);
      } catch (error) {
        await this.sendError(message.contextKey, error);
      }
    });
    this.messageQueues.set(message.contextKey, next);
    await next;
    if (this.messageQueues.get(message.contextKey) === next) this.messageQueues.delete(message.contextKey);
  }

  async onCardAction(action: CardAction): Promise<void> {
    if (this.handledActions.has(action.actionId)) return;
    this.handledActions.add(action.actionId);
    if (this.handledActions.size > 1_000) this.handledActions.delete(this.handledActions.values().next().value as string);

    try {
      const kind = String(action.value.action ?? "");
      if (kind === "turn_details") {
        await this.outbound.showDetails(action.contextKey, String(action.value.turnId ?? ""));
      } else if (kind === "turn_cancel") {
        const sessionId = String(action.value.sessionId ?? "");
        await this.cancelSession(this.requireSession(action.contextKey, sessionId));
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
  }

  private async execute(contextKey: string, command: Command): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    switch (command.type) {
      case "agents":
        await this.listAgents(contextKey);
        return;
      case "new":
        await this.createSession(contextKey, command.agent ?? context.defaultAgent, command.cwd, true);
        return;
      case "ask":
      case "prompt":
        await this.prompt(contextKey, command.text);
        return;
      case "sessions":
        await this.listSessions(contextKey);
        return;
      case "switch":
        this.requireSession(contextKey, command.sessionId);
        this.store.setCurrentSession(contextKey, command.sessionId);
        await this.outbound.sendText(contextKey, `已切换到任务：${command.sessionId}`);
        return;
      case "agent":
        await this.setDefaultAgent(contextKey, command.agent);
        return;
      case "use":
        await this.setDefaultAgent(contextKey, command.agent);
        await this.createSession(contextKey, command.agent, command.cwd, true);
        return;
      case "close":
        await this.closeSession(contextKey, command.sessionId);
        return;
      case "status":
        await this.status(contextKey);
        return;
      case "model":
        await this.model(contextKey, command.model);
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
      case "cancel":
        return;
    }
  }

  private async prompt(contextKey: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("请输入要交给 Codex 的内容。");
    let record = this.currentSession(contextKey);
    if (!record) {
      const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
      record = await this.createSession(contextKey, context.defaultAgent, undefined, false);
    }
    const loaded = await this.loadSession(record);
    const activeTurnId = loaded.session.activeTurnId;
    if (activeTurnId) {
      try {
        await loaded.runtime.steerTurn(record.localSessionId, activeTurnId, text);
        return;
      } catch (error) {
        this.logger.debug({ error, sessionId: record.localSessionId, activeTurnId }, "Steering raced with turn completion; queueing prompt.");
        const current = loaded.runtime.getSession(record.localSessionId);
        if (!current?.activeTurnId) {
          await this.startTurn(loaded, text);
          return;
        }
        const queued = this.queuedPrompts.get(record.localSessionId) ?? [];
        queued.push(text);
        this.queuedPrompts.set(record.localSessionId, queued);
        return;
      }
    }
    await this.startTurn(loaded, text);
  }

  private async startTurn(loaded: LoadedSession, text: string): Promise<void> {
    const turnId = await loaded.runtime.startTurn(loaded.record.localSessionId, text);
    this.store.updateSession(loaded.record.localSessionId, { status: "running" });
    this.store.updateRuntimeSession(loaded.record.localSessionId, { lastTurnId: turnId, lastTurnStatus: "running" });
  }

  private async createSession(
    contextKey: string,
    agentName: string,
    cwd: string | undefined,
    announce: boolean,
  ): Promise<SessionRecord> {
    const agent = this.ensureAgent(agentName);
    const localSessionId = createId("sess");
    const sessionCwd = path.resolve(cwd ?? this.config.defaults.cwd);
    const record = this.store.createSession({ localSessionId, contextKey, agentName, cwd: sessionCwd, status: "starting" });
    this.store.setCurrentSession(contextKey, localSessionId);
    this.outbound.registerSession(localSessionId, contextKey);
    const runtime = this.runtimes.forAgent(agent);
    try {
      const session = await runtime.createSession({
        localSessionId,
        agentName,
        cwd: sessionCwd,
        permissionMode: "auto",
      });
      this.persistRuntimeSession(record, session, "ready");
      if (announce) await this.outbound.sendText(contextKey, `已创建 ${agent.title} 任务：${localSessionId}`);
      return this.store.getSession(localSessionId) ?? record;
    } catch (error) {
      this.store.updateSession(localSessionId, { status: "failed" });
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

    this.outbound.registerSession(record.localSessionId, record.contextKey);
    const loading = (async (): Promise<LoadedSession> => {
      const permissionMode = record.permissionMode ?? "auto";
      const session = record.remoteSessionId
        ? await runtime.resumeSession({
            localSessionId: record.localSessionId,
            remoteSessionId: record.remoteSessionId,
            agentName: record.agentName,
            cwd: record.cwd,
            model: record.model,
            permissionMode,
          })
        : await runtime.createSession({
            localSessionId: record.localSessionId,
            agentName: record.agentName,
            cwd: record.cwd,
            model: record.model,
            permissionMode,
          });
      this.persistRuntimeSession(record, session, "ready");
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
      model: session.model,
      permissionMode: session.permissionMode,
    });
    this.store.updateSession(record.localSessionId, {
      acpSessionId: session.runtimeKind === "acp" ? session.remoteSessionId : undefined,
      status,
    });
  }

  private async handleRuntimeEvent(event: AgentEvent): Promise<void> {
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
    }

    await this.outbound.onEvent(event);
    if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      await this.startNextQueuedPrompt(event.sessionId);
    }
  }

  private async startNextQueuedPrompt(sessionId: string): Promise<void> {
    const queued = this.queuedPrompts.get(sessionId);
    const text = queued?.shift();
    if (!text) {
      this.queuedPrompts.delete(sessionId);
      return;
    }
    if (queued?.length === 0) this.queuedPrompts.delete(sessionId);
    const record = this.store.getSession(sessionId);
    if (!record || record.status === "closed") return;
    try {
      await this.startTurn(await this.loadSession(record), text);
    } catch (error) {
      this.logger.warn({ error, sessionId }, "Failed to start queued prompt.");
      await this.sendError(record.contextKey, error);
    }
  }

  private async cancel(contextKey: string): Promise<void> {
    const record = this.requireCurrentSession(contextKey);
    await this.cancelSession(record);
  }

  private async cancelSession(record: SessionRecord): Promise<void> {
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
      const lines = models.map((item) => `- ${asInlineCode(item.id)}${item.isDefault ? "（默认）" : ""}${item.displayName ? `：${item.displayName}` : ""}`);
      await this.outbound.sendMarkdown(contextKey, `可用模型：\n${lines.join("\n") || "无"}`);
      return;
    }
    await loaded.runtime.setModel(loaded.record.localSessionId, model);
    this.store.updateRuntimeSession(loaded.record.localSessionId, { model });
    await this.outbound.sendText(contextKey, `模型已切换为 ${model}，从下一次请求生效。`);
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

  private async closeSession(contextKey: string, sessionId?: string): Promise<void> {
    const record = sessionId ? this.requireSession(contextKey, sessionId) : this.requireCurrentSession(contextKey);
    const loaded = await this.loadSession(record);
    await loaded.runtime.closeSession(record.localSessionId);
    this.outbound.unregisterSession(record.localSessionId);
    this.store.updateSession(record.localSessionId, { status: "closed" });
    if (this.currentSession(contextKey)?.localSessionId === record.localSessionId) this.store.setCurrentSession(contextKey, undefined);
    await this.outbound.sendText(contextKey, `已关闭任务：${record.localSessionId}`);
  }

  private async listAgents(contextKey: string): Promise<void> {
    const lines = Object.entries(this.config.agents).map(([name, agent]) => `- ${asInlineCode(name)}：${agent.title}`);
    await this.outbound.sendMarkdown(contextKey, `可用 agent：\n${lines.join("\n")}`);
  }

  private async listSessions(contextKey: string): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const sessions = this.store.listSessions(contextKey);
    if (!sessions.length) {
      await this.outbound.sendText(contextKey, "当前没有任务，直接发送消息即可自动创建。");
      return;
    }
    await this.outbound.sendMarkdown(contextKey, sessions.map((session) => {
      const marker = session.localSessionId === context.currentSessionId ? "*" : "-";
      return `${marker} ${asInlineCode(session.localSessionId)} ${session.agentName} ${session.status} ${session.cwd}`;
    }).join("\n"));
  }

  private async setDefaultAgent(contextKey: string, agentName: string): Promise<void> {
    this.ensureAgent(agentName);
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    this.store.setDefaultAgent(contextKey, agentName);
    await this.outbound.sendText(contextKey, `默认 agent 已切换为：${agentName}`);
  }

  private async status(contextKey: string): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const current = context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
    await this.outbound.sendMarkdown(contextKey, [
      `默认 agent：${context.defaultAgent}`,
      `当前任务：${current?.localSessionId ?? "无"}`,
      `运行时：${current?.runtimeKind ?? "未启动"}`,
      `模型：${current?.model ?? "默认"}`,
      `权限：${current?.permissionMode ?? "auto"}`,
      `状态：${current?.status ?? "无"}`,
      `目录：${current?.cwd ?? "无"}`,
    ].join("\n"));
  }

  private async help(contextKey: string): Promise<void> {
    await this.outbound.sendMarkdown(contextKey, [
      "直接发送文字即可使用 Codex；运行中继续发消息会追加到当前任务。",
      "- `/new [agent] [cwd]`：新建任务",
      "- `/sessions` / `/switch <id>`：查看或切换任务",
      "- `/model [name]`：查看或切换模型",
      "- `/permissions auto|confirm`：切换自动执行/确认模式",
      "- `/cancel`：停止当前执行",
      "- `/status`：查看当前状态",
      "- `/close [id]`：关闭任务",
      "- `/agents` / `/agent <name>`：查看或切换默认 agent",
    ].join("\n"));
  }

  private ensureAgent(agentName: string) {
    const agent = this.config.agents[agentName];
    if (!agent) throw new Error(`未知 agent：${agentName}`);
    return agent;
  }

  private currentSession(contextKey: string): SessionRecord | undefined {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    return context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
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
