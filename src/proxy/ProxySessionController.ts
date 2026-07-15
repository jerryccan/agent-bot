import path from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { AcpSessionManager, type RuntimeSession } from "../acp/AcpSessionManager.js";
import type { AcpPermissionRequestParams, JsonValue } from "../acp/acpTypes.js";
import { CommandRouter } from "../commands/CommandRouter.js";
import type { Command } from "../commands/commandTypes.js";
import { CardRenderer } from "../feishu/CardRenderer.js";
import type { CardAction, FeishuOutbound, IncomingMessage } from "../feishu/types.js";
import { StateStore } from "../state/StateStore.js";
import { createId } from "../utils/id.js";
import { asInlineCode, truncateText } from "../utils/markdown.js";

interface PendingPermission {
  contextKey: string;
  resolve: (value: JsonValue) => void;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

interface SessionUpdateBuffer {
  contextKey: string;
  session: RuntimeSession;
  textParts: string[];
  latestUpdate?: Record<string, JsonValue>;
  timer?: NodeJS.Timeout;
  flushing?: Promise<void>;
}

const SESSION_UPDATE_FLUSH_INTERVAL_MS = 2500;
const SESSION_UPDATE_MAX_TEXT_LENGTH = 6000;

export class ProxySessionController {
  private readonly router = new CommandRouter();
  private readonly renderer = new CardRenderer();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly messageQueues = new Map<string, Promise<void>>();
  private readonly updateBuffers = new Map<string, SessionUpdateBuffer>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly acp: AcpSessionManager,
    private readonly feishu: FeishuOutbound,
    private readonly logger: Logger,
  ) {}

  async onMessage(message: IncomingMessage): Promise<void> {
    const previous = this.messageQueues.get(message.contextKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleMessage(message));

    this.messageQueues.set(message.contextKey, next);

    try {
      await next;
    } finally {
      if (this.messageQueues.get(message.contextKey) === next) {
        this.messageQueues.delete(message.contextKey);
      }
    }
  }

  async onCardAction(action: CardAction): Promise<void> {
    await this.handleCardAction(action);
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    this.store.audit(message.contextKey, "incoming_message", {
      messageId: message.messageId,
      text: message.text,
    });

    try {
      const command = this.router.parse(message.text);
      await this.execute(message.contextKey, command);
    } catch (error) {
      await this.feishu.sendText(message.contextKey, error instanceof Error ? error.message : String(error));
    }
  }

  async handleCardAction(action: CardAction): Promise<void> {
    const value = action.value;
    if (value.action !== "permission") {
      return;
    }

    const permissionId = String(value.permissionId ?? "");
    const optionId = String(value.optionId ?? "");
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      await this.feishu.sendText(action.contextKey, "这个确认请求已经过期或已处理。");
      return;
    }

    this.pendingPermissions.delete(permissionId);
    pending.resolve({
      outcome: {
        outcome: "selected",
        optionId,
      },
    });

    await this.feishu.sendText(action.contextKey, `已选择：${optionId}`);
  }

  private async execute(contextKey: string, command: Command): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);

    switch (command.type) {
      case "agents":
        await this.listAgents(contextKey);
        return;
      case "new":
        await this.createSession(contextKey, command.agent ?? context.defaultAgent, command.cwd);
        return;
      case "ask":
        await this.prompt(contextKey, command.text);
        return;
      case "prompt":
        await this.prompt(contextKey, command.text);
        return;
      case "sessions":
        await this.listSessions(contextKey);
        return;
      case "switch":
        await this.switchSession(contextKey, command.sessionId);
        return;
      case "agent":
        await this.setDefaultAgent(contextKey, command.agent);
        return;
      case "use":
        await this.setDefaultAgent(contextKey, command.agent);
        await this.createSession(contextKey, command.agent, command.cwd);
        return;
      case "cancel":
        await this.cancel(contextKey);
        return;
      case "close":
        await this.close(contextKey, command.sessionId);
        return;
      case "status":
        await this.status(contextKey);
        return;
      case "modes":
        await this.listModes(contextKey);
        return;
      case "mode":
        await this.setMode(contextKey, command.value);
        return;
      case "help":
        await this.help(contextKey);
        return;
    }
  }

  private async listAgents(contextKey: string): Promise<void> {
    const lines = Object.entries(this.config.agents).map(
      ([name, agent]) => `- ${asInlineCode(name)}：${agent.title}`,
    );
    await this.feishu.sendMarkdown(contextKey, `可用 agent：\n${lines.join("\n")}`);
  }

  private async createSession(contextKey: string, agentName: string, cwd?: string): Promise<void> {
    this.ensureAgent(agentName);

    const sessionCwd = path.resolve(cwd ?? this.config.defaults.cwd);
    const localSessionId = createId("sess");
    this.store.createSession({
      localSessionId,
      contextKey,
      agentName,
      cwd: sessionCwd,
      status: "starting",
    });
    this.store.setCurrentSession(contextKey, localSessionId);

    const runtime = await this.acp.create({
      localSessionId,
      agentName,
      cwd: sessionCwd,
      onUpdate: (session, update) => {
        void this.onSessionUpdate(contextKey, session, update).catch((error: unknown) => {
          this.logger.warn(
            { error, localSessionId: session.localSessionId },
            "Failed to handle ACP session update.",
          );
        });
      },
      onPermissionRequest: (session, params) => this.onPermissionRequest(contextKey, session, params),
    });

    this.store.updateSession(localSessionId, {
      acpSessionId: runtime.acpSessionId,
      status: "ready",
    });

    await this.feishu.sendInteractiveCard(contextKey, this.renderer.renderSessionStarted(runtime));
  }

  private async prompt(contextKey: string, text: string): Promise<void> {
    const session = this.requireCurrentSession(contextKey);
    this.store.updateSession(session.localSessionId, { status: "running" });
    try {
      const result = await this.acp.prompt(session.localSessionId, text);
      await this.flushSessionUpdates(session.localSessionId, true);
      this.store.updateSession(session.localSessionId, { status: "ready" });
      await this.safeSendText(contextKey, `完成：${result.stopReason}`, {
        localSessionId: session.localSessionId,
      });
    } catch (error) {
      await this.flushSessionUpdates(session.localSessionId, true).catch((flushError: unknown) => {
        this.logger.warn({ error: flushError, localSessionId: session.localSessionId }, "Failed to flush updates.");
      });
      this.store.updateSession(session.localSessionId, { status: "failed" });
      throw error;
    }
  }

  private async listSessions(contextKey: string): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const sessions = this.store.listSessions(contextKey);
    if (!sessions.length) {
      await this.feishu.sendText(contextKey, "当前没有会话。使用 /new [agent] [cwd] 创建一个。");
      return;
    }

    const lines = sessions.map((session) => {
      const marker = session.localSessionId === context.currentSessionId ? "*" : "-";
      return `${marker} ${asInlineCode(session.localSessionId)} ${session.agentName} ${session.status} ${session.cwd}`;
    });
    await this.feishu.sendMarkdown(contextKey, lines.join("\n"));
  }

  private async switchSession(contextKey: string, sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session || session.contextKey !== contextKey) {
      throw new Error(`找不到会话：${sessionId}`);
    }

    this.store.setCurrentSession(contextKey, sessionId);
    await this.feishu.sendText(contextKey, `已切换到会话：${sessionId}`);
  }

  private async setDefaultAgent(contextKey: string, agentName: string): Promise<void> {
    this.ensureAgent(agentName);
    this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    this.store.setDefaultAgent(contextKey, agentName);
    await this.feishu.sendText(contextKey, `默认 agent 已切换为：${agentName}`);
  }

  private async cancel(contextKey: string): Promise<void> {
    const session = this.requireCurrentSession(contextKey);
    this.acp.cancel(session.localSessionId);
    await this.feishu.sendText(contextKey, `已发送取消请求：${session.localSessionId}`);
  }

  private async close(contextKey: string, sessionId?: string): Promise<void> {
    const session = sessionId ? this.requireSession(contextKey, sessionId) : this.requireCurrentSession(contextKey);
    await this.acp.close(session.localSessionId);
    this.store.updateSession(session.localSessionId, { status: "closed" });

    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    if (context.currentSessionId === session.localSessionId) {
      this.store.setCurrentSession(contextKey, undefined);
    }

    await this.feishu.sendText(contextKey, `已关闭会话：${session.localSessionId}`);
  }

  private async status(contextKey: string): Promise<void> {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    const current = context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
    const status = [
      `默认 agent：${context.defaultAgent}`,
      `当前会话：${current?.localSessionId ?? "无"}`,
      `当前会话工作目录：${current?.cwd ?? "无"}`,
      `当前状态：${current?.status ?? "无"}`,
    ].join("\n");

    await this.feishu.sendInteractiveCard(contextKey, this.renderer.renderStatus(status));
  }

  private async listModes(contextKey: string): Promise<void> {
    const session = this.requireRuntimeCurrentSession(contextKey);
    const configText = session.configOptions
      ? `Config Options:\n${JSON.stringify(session.configOptions, null, 2)}`
      : "Config Options: 无";
    const modeText = session.modes ? `Modes:\n${JSON.stringify(session.modes, null, 2)}` : "Modes: 无";
    const commandsText = session.availableCommands
      ? `Available Commands:\n${JSON.stringify(session.availableCommands, null, 2)}`
      : "Available Commands: 无";

    await this.feishu.sendMarkdown(
      contextKey,
      truncateText(`\`\`\`json\n${configText}\n\n${modeText}\n\n${commandsText}\n\`\`\``, 8000),
    );
  }

  private async setMode(contextKey: string, value: string): Promise<void> {
    const runtime = this.requireRuntimeCurrentSession(contextKey);
    const modeConfigId = findModeConfigId(runtime.configOptions);
    if (modeConfigId) {
      await this.acp.setConfigOption(runtime.localSessionId, modeConfigId, value);
      await this.feishu.sendText(contextKey, `已切换模式：${value}`);
      return;
    }

    if (runtime.modes) {
      await this.acp.setMode(runtime.localSessionId, value);
      await this.feishu.sendText(contextKey, `已切换模式：${value}`);
      return;
    }

    await this.feishu.sendText(contextKey, "当前 agent 没有声明可切换的工作模式。");
  }

  private async help(contextKey: string): Promise<void> {
    await this.feishu.sendMarkdown(
      contextKey,
      [
        "可用命令：",
        "- `/agents`：列出 agent",
        "- `/new [agent] [cwd]`：创建新会话",
        "- `/use <agent> [cwd]`：切换默认 agent 并创建新会话",
        "- `/agent <agent>`：切换默认 agent",
        "- `/sessions`：列出会话",
        "- `/switch <session>`：切换当前会话",
        "- `/ask <content>`：发送 prompt",
        "- 普通文本：发送到当前会话",
        "- `/modes`：查看 agent 声明的模式/配置",
        "- `/mode <value>`：切换 agent 声明的模式",
        "- `/cancel`：取消当前任务",
        "- `/close [session]`：关闭会话",
        "- `/status`：查看状态",
      ].join("\n"),
    );
  }

  private async onSessionUpdate(
    contextKey: string,
    session: RuntimeSession,
    update: Record<string, JsonValue>,
  ): Promise<void> {
    this.store.audit(contextKey, "session_update", {
      localSessionId: session.localSessionId,
      update,
    });

    const updateType = update.sessionUpdate;
    if (updateType === "agent_message_chunk") {
      const text = extractText(update);
      if (text) {
        this.bufferSessionUpdate(contextKey, session, text, undefined);
        return;
      }
    }

    this.bufferSessionUpdate(contextKey, session, undefined, update);
  }

  private bufferSessionUpdate(
    contextKey: string,
    session: RuntimeSession,
    text: string | undefined,
    update: Record<string, JsonValue> | undefined,
  ): void {
    let buffer = this.updateBuffers.get(session.localSessionId);
    if (!buffer) {
      buffer = {
        contextKey,
        session,
        textParts: [],
      };
      this.updateBuffers.set(session.localSessionId, buffer);
    }

    buffer.contextKey = contextKey;
    buffer.session = session;
    if (text) {
      buffer.textParts.push(text);
    }
    if (update) {
      buffer.latestUpdate = update;
    }

    this.scheduleSessionUpdateFlush(buffer);
  }

  private scheduleSessionUpdateFlush(buffer: SessionUpdateBuffer): void {
    if (buffer.timer) {
      return;
    }

    buffer.timer = setTimeout(() => {
      buffer.timer = undefined;
      void this.flushSessionUpdates(buffer.session.localSessionId).catch((error: unknown) => {
        this.logger.warn(
          { error, localSessionId: buffer.session.localSessionId },
          "Failed to flush ACP session updates.",
        );
      });
    }, SESSION_UPDATE_FLUSH_INTERVAL_MS);
  }

  private async flushSessionUpdates(localSessionId: string, force = false): Promise<void> {
    const buffer = this.updateBuffers.get(localSessionId);
    if (!buffer) {
      return;
    }

    if (buffer.flushing) {
      await buffer.flushing;
      if (force) {
        await this.flushSessionUpdates(localSessionId, true);
      }
      return;
    }

    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }

    const text = buffer.textParts.join("");
    const latestUpdate = buffer.latestUpdate;
    buffer.textParts = [];
    buffer.latestUpdate = undefined;

    if (!text && !latestUpdate) {
      this.updateBuffers.delete(localSessionId);
      return;
    }

    buffer.flushing = (async () => {
      if (text) {
        await this.safeSendMarkdown(
          buffer.contextKey,
          truncateText(text, SESSION_UPDATE_MAX_TEXT_LENGTH),
          { localSessionId, kind: "agent_message_chunk" },
        );
      }

      if (latestUpdate) {
        await this.safeSendInteractiveCard(
          buffer.contextKey,
          this.renderer.renderSessionUpdate(buffer.session, latestUpdate),
          { localSessionId, kind: String(latestUpdate.sessionUpdate ?? "update") },
        );
      }
    })();

    await buffer.flushing;
    buffer.flushing = undefined;

    if (buffer.textParts.length || buffer.latestUpdate) {
      if (force) {
        await this.flushSessionUpdates(localSessionId, true);
      } else {
        this.scheduleSessionUpdateFlush(buffer);
      }
      return;
    }

    this.updateBuffers.delete(localSessionId);
  }

  private async safeSendText(
    contextKey: string,
    text: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.feishu.sendText(contextKey, text);
    } catch (error) {
      this.logger.warn({ error, contextKey, ...meta }, "Failed to send Feishu text message.");
    }
  }

  private async safeSendMarkdown(
    contextKey: string,
    markdown: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.feishu.sendMarkdown(contextKey, markdown);
    } catch (error) {
      this.logger.warn({ error, contextKey, ...meta }, "Failed to send Feishu markdown message.");
    }
  }

  private async safeSendInteractiveCard(
    contextKey: string,
    card: Record<string, unknown>,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.feishu.sendInteractiveCard(contextKey, card);
    } catch (error) {
      this.logger.warn({ error, contextKey, ...meta }, "Failed to send Feishu interactive card.");
    }
  }

  private async onPermissionRequest(
    contextKey: string,
    session: RuntimeSession,
    params: AcpPermissionRequestParams,
  ): Promise<JsonValue> {
    const permissionId = createId("perm");
    const toolTitle = typeof params.toolCall.title === "string" ? params.toolCall.title : "Agent permission request";

    const result = new Promise<JsonValue>((resolve) => {
      this.pendingPermissions.set(permissionId, {
        contextKey,
        resolve,
        options: params.options,
      });
    });

    await this.feishu.sendInteractiveCard(
      contextKey,
      this.renderer.renderPermissionRequest(session, permissionId, toolTitle, params.options),
    );

    return result;
  }

  private ensureAgent(agentName: string): void {
    if (!this.config.agents[agentName]) {
      throw new Error(`未知 agent：${agentName}`);
    }
  }

  private requireCurrentSession(contextKey: string) {
    const context = this.store.getOrCreateUserContext(contextKey, this.config.defaults.agent!);
    if (!context.currentSessionId) {
      throw new Error("当前没有会话。请先使用 /new [agent] [cwd] 创建会话。");
    }

    return this.requireSession(contextKey, context.currentSessionId);
  }

  private requireRuntimeCurrentSession(contextKey: string): RuntimeSession {
    const session = this.requireCurrentSession(contextKey);
    const runtime = this.acp.get(session.localSessionId);
    if (!runtime) {
      throw new Error("当前会话没有运行中的 ACP 连接，可能需要重新创建会话。");
    }

    return runtime;
  }

  private requireSession(contextKey: string, sessionId: string) {
    const session = this.store.getSession(sessionId);
    if (!session || session.contextKey !== contextKey) {
      throw new Error(`找不到会话：${sessionId}`);
    }

    return session;
  }
}

function extractText(update: Record<string, JsonValue>): string | undefined {
  const content = update.content;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return undefined;
  }

  return content.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

function findModeConfigId(configOptions: JsonValue | undefined): string | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }

  const modeOption = configOptions.find(
    (option): option is Record<string, JsonValue> =>
      typeof option === "object" &&
      option !== null &&
      !Array.isArray(option) &&
      option.category === "mode" &&
      typeof option.id === "string",
  );

  return modeOption?.id as string | undefined;
}
