import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonValue } from "../acp/acpTypes.js";
import type { RuntimeSession } from "../acp/AcpSessionManager.js";
import type {
  ApprovalDecision,
  ModelOption,
  ModelProviderOption,
  PermissionMode,
  ReasoningEffortOption,
  ToolState,
} from "../runtime/types.js";
import type { TurnActivity, TurnViewState, TurnViewStatus } from "../presentation/turnViewTypes.js";
import { truncateMiddle, truncateText } from "../utils/markdown.js";
import { localCardImage } from "./LocalCardImage.js";

export interface StartupStatusView {
  startedAt: Date;
  restartReason: string;
  agentBotVersion: string;
  defaultAgentName: string;
  defaultAgentTitle: string;
  cwd: string;
  workspaceKind?: "project" | "projectless";
  currentTask?: {
    id: string;
    title?: string;
    modelProvider?: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: PermissionMode;
    agentName: string;
    sessionStatus: string;
    lastTurnStatus?: string;
  };
}

export type InitializationWelcomeKind = "first" | "upgrade" | "refresh";

export interface InitializationWelcomeFeature {
  icon: string;
  title: string;
  description: string;
}

export interface InitializationWelcomeView {
  kind: InitializationWelcomeKind;
  version: string;
  previousVersion?: string;
  activationPending?: boolean;
  defaultAgentName: string;
  defaultAgentTitle: string;
  availableAgents: string[];
  logoPath: string;
  features: InitializationWelcomeFeature[];
}

export interface SafeRestartStatusView {
  scheduleId: number;
  reason: string;
  phase: "waiting_tasks" | "waiting_delivery" | "countdown" | "restarting" | "cancelled";
  remainingMs?: number;
  pendingFinalDeliveries: number;
  waitingTasks: Array<{
    id: string;
    title?: string;
  }>;
}

export interface PromptQueueCardView {
  sessionId: string;
  contextKey: string;
  prompts: Array<{
    id: string;
    text: string;
  }>;
}

export interface ModelSelectorCardView {
  sessionId: string;
  contextKey: string;
  currentModel?: string;
  reasoningEffort?: string;
  models: ModelOption[];
  modelProvider?: string;
  permissionMode?: PermissionMode;
  unifiedSettings?: boolean;
  notice?: string;
}

export interface ReasoningSelectorCardView {
  sessionId: string;
  contextKey: string;
  model: string;
  currentEffort?: string;
  options: ReasoningEffortOption[];
  modelProvider?: string;
  permissionMode?: PermissionMode;
  unifiedSettings?: boolean;
  notice?: string;
}

export interface ProviderSelectorCardView {
  sessionId: string;
  contextKey: string;
  currentProvider?: string;
  currentModel?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  providers: ModelProviderOption[];
  notice?: string;
}

export interface PermissionSelectorCardView {
  sessionId: string;
  contextKey: string;
  modelProvider: string;
  model: string;
  reasoningEffort: string;
  currentMode: PermissionMode;
}

export type ExecutionSettingsTab = "agent" | "provider" | "model" | "thinking" | "permission";

export interface ExecutionSettingsAgentOption {
  name: string;
  title: string;
}

export interface ExecutionSettingsCardView {
  sessionId?: string;
  contextKey: string;
  activeTab: ExecutionSettingsTab;
  currentAgent: string;
  taskAgent?: string;
  agents: ExecutionSettingsAgentOption[];
  runtimeSettingsAvailable: boolean;
  currentProvider?: string;
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode: PermissionMode;
  providers: ModelProviderOption[];
  providerSupported: boolean;
  models: ModelOption[];
  reasoningOptions: ReasoningEffortOption[];
  notice?: string;
}

export interface CardSection {
  title?: string;
  lines: string[];
  collapsible?: boolean;
  elementId?: string;
}

export interface TaskListCardAction {
  text: string;
  type?: "default" | "primary" | "danger";
  value: Record<string, string>;
}

export interface HelpCardCommand {
  text: string;
  action?: TaskListCardAction;
  usage?: string;
  description: string;
}

export interface HelpCardSection {
  title: string;
  commands: HelpCardCommand[];
}

export interface TaskListCardEntry {
  lines: string[];
  actions?: TaskListCardAction[];
  current?: boolean;
}

export interface SessionTaskCardEntry {
  reference: string;
  summary: string;
  detailLines: string[];
  actions?: TaskListCardAction[];
  current?: boolean;
}

export interface SessionTaskCardGroup {
  title: string;
  entries: SessionTaskCardEntry[];
  actions?: TaskListCardAction[];
}

export interface DirectoryBrowserCardEntry {
  name: string;
  kind: "directory" | "drive" | "file" | "image" | "binary";
  openAction?: TaskListCardAction;
  actions?: TaskListCardAction[];
}

export interface DirectoryBrowserCardView {
  directory: string;
  entries: DirectoryBrowserCardEntry[];
  currentActions: TaskListCardAction[];
  navigationActions: TaskListCardAction[];
  footerLines: string[];
}

const DIRECTORY_BROWSER_ROW_COUNT = 16;

export type ThinkingCardLayout = "grouped" | "timeline";

export interface CardRendererOptions {
  thinkingCardLayout?: ThinkingCardLayout;
}

export interface ResetHistoryCardEntry extends TaskListCardEntry {
  sequence: number;
  graphNodeLine: string;
  graphConnectorLine?: string;
}

export interface ResetHistoryCardView {
  entries: ResetHistoryCardEntry[];
  footerLines: string[];
  pageActions: TaskListCardAction[];
}

export class CardRenderer {
  private readonly thinkingCardLayout: ThinkingCardLayout;

  constructor(options: CardRendererOptions = {}) {
    this.thinkingCardLayout = options.thinkingCardLayout ?? "grouped";
  }

  renderExecutionSettings(view: ExecutionSettingsCardView): Record<string, unknown> {
    const baseAction: Record<string, string> = {
      contextKey: view.contextKey,
      ...(view.sessionId ? { sessionId: view.sessionId } : {}),
    };
    const tabRow = settingsTabRow(
      view.activeTab,
      baseAction,
      view.agents.length > 1,
      view.runtimeSettingsAvailable,
    );
    const elements: Record<string, unknown>[] = [
      markdown([
        view.taskAgent
          ? `**默认 Agent / 当前任务 Agent**：${inlineCode(view.currentAgent)} / ${inlineCode(view.taskAgent)}`
          : `**默认 Agent**：${inlineCode(view.currentAgent)}`,
        ...(view.runtimeSettingsAvailable
          ? [
              `**Provider / 模型**：${inlineCode(view.currentProvider ?? "Agent 默认")} / ${inlineCode(view.currentModel ?? "默认")}`,
              `**思考强度 / 权限**：${inlineCode(view.currentEffort ?? "自动")} / ${inlineCode(permissionModeLabel(view.currentPermissionMode))}`,
            ]
          : []),
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      ...(tabRow ? [tabRow] : []),
      { tag: "hr" },
    ];

    if (view.activeTab === "agent") {
      elements.push(...view.agents.map((agent) => settingsOptionRow({
        label: `${inlineCode(agent.name)} · ${escapeCardHtml(agent.title)}`,
        current: agent.name === view.currentAgent,
        action: {
          text: "Switch",
          value: {
            action: "settings_agent_select",
            ...baseAction,
            agent: agent.name,
          },
        },
      })));
    } else if (view.activeTab === "provider") {
      if (!view.providerSupported) {
        elements.push(markdown("当前运行时不支持 Provider 切换；其他设置仍可通过上方 tab 修改。"));
      } else if (view.providers.length === 0) {
        elements.push(markdown("当前 Agent 配置中没有可用的 Provider。"));
      } else {
        elements.push(...view.providers.map((provider) => settingsOptionRow({
          label: [
            inlineCode(provider.id),
            provider.displayName && provider.displayName !== provider.id
              ? ` · ${escapeCardHtml(provider.displayName)}`
              : "",
            provider.isDefault ? " · 默认" : "",
          ].join(""),
          current: provider.id === view.currentProvider,
          action: {
            text: "Switch",
            value: {
              action: "settings_provider_select",
              ...baseAction,
              provider: provider.id,
            },
          },
        })));
      }
    } else if (view.activeTab === "model") {
      if (view.models.length === 0) {
        elements.push(markdown("当前运行时未返回可用模型。"));
      } else {
        elements.push(...view.models.map((model) => settingsOptionRow({
          label: `${inlineCode(model.id)}${model.isDefault ? " · 默认" : ""}`,
          current: model.id === view.currentModel,
          action: {
            text: "Switch",
            value: {
              action: "settings_model_select",
              ...baseAction,
              model: model.id,
            },
          },
        })));
      }
    } else if (view.activeTab === "thinking") {
      if (!view.currentModel) {
        elements.push(markdown("请先选择模型。"));
      } else if (view.reasoningOptions.length === 0) {
        elements.push(markdown("当前模型没有可配置的思考强度。"));
      } else {
        const currentModel = view.currentModel;
        elements.push(...view.reasoningOptions.map((option) => settingsOptionRow({
          label: inlineCode(option.value),
          current: option.value === view.currentEffort,
          action: {
            text: "Switch",
            value: {
              action: "settings_thinking_select",
              ...baseAction,
              model: currentModel,
              effort: option.value,
            },
          },
        })));
      }
    } else {
      elements.push(...(["auto", "confirm"] as PermissionMode[]).map((mode) => settingsOptionRow({
        label: `${inlineCode(mode)} · ${permissionModeLabel(mode)}`,
        current: mode === view.currentPermissionMode,
        action: {
          text: "Switch",
          value: {
            action: "settings_permission_select",
            ...baseAction,
            permissionMode: mode,
          },
        },
      })));
    }

    return sectionCard("运行设置", elements, view.notice ? "green" : "blue");
  }

  renderProviderSelector(view: ProviderSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        `**当前 Provider**：${inlineCode(view.currentProvider ?? "Agent 默认")}`,
        `**模型 / 思考强度 / 权限**：${inlineCode(view.currentModel ?? "默认")} / ${inlineCode(view.reasoningEffort ?? "自动")} / ${inlineCode(permissionModeLabel(view.permissionMode))}`,
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      { tag: "hr" },
    ];
    if (view.providers.length === 0) {
      elements.push(markdown("当前 Agent 配置中没有可用的 Provider。"));
    } else {
      elements.push(...view.providers.map((provider) => ({
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        vertical_align: "center",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "center",
            elements: [markdown([
              inlineCode(provider.id),
              provider.displayName && provider.displayName !== provider.id ? ` · ${escapeCardHtml(provider.displayName)}` : "",
              provider.isDefault ? " · 默认" : "",
              provider.id === view.currentProvider ? " · ✅ 当前" : "",
            ].join(""))],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [taskActionElement({
              text: provider.id === view.currentProvider ? "Configure" : "Select",
              value: {
                action: "provider_select",
                sessionId: view.sessionId,
                contextKey: view.contextKey,
                provider: provider.id,
                permissionMode: view.permissionMode,
              },
            })],
          },
        ],
      })));
    }
    return sectionCard("Provider 设置", elements, view.notice ? "green" : "blue");
  }

  renderReasoningSelector(view: ReasoningSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        ...(view.modelProvider ? [`**Provider**：${inlineCode(view.modelProvider)}`] : []),
        `**模型**：${inlineCode(view.model)}`,
        `**当前思考模式**：${inlineCode(view.currentEffort ?? "默认")}`,
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      { tag: "hr" },
    ];
    if (view.options.length === 0) {
      elements.push(markdown("该模型没有可配置的思考模式。"));
    } else {
      elements.push(...view.options.map((option) => {
        const isCurrent = option.value === view.currentEffort;
        return {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "8px",
          vertical_align: "center",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              vertical_align: "center",
              elements: [markdown(inlineCode(option.value))],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: isCurrent && !view.unifiedSettings
                ? [markdown("✅ 当前")]
                : [taskActionElement({
                    text: view.unifiedSettings ? (isCurrent ? "Continue" : "Select") : "Switch",
                    value: {
                      action: view.unifiedSettings ? "provider_reasoning_select" : "reasoning_select",
                      sessionId: view.sessionId,
                      contextKey: view.contextKey,
                      ...(view.modelProvider ? { provider: view.modelProvider } : {}),
                      model: view.model,
                      effort: option.value,
                      ...(view.permissionMode ? { permissionMode: view.permissionMode } : {}),
                    },
                  })],
            },
          ],
        };
      }));
    }
    elements.push(
      { tag: "hr" },
      taskActionRow([{
        text: "Back",
        value: {
          action: view.unifiedSettings ? "provider_model_open" : "model_open",
          sessionId: view.sessionId,
          contextKey: view.contextKey,
          ...(view.modelProvider ? { provider: view.modelProvider } : {}),
          ...(view.permissionMode ? { permissionMode: view.permissionMode } : {}),
        },
      }]),
    );
    return sectionCard("思考模式", elements, view.notice ? "green" : "blue");
  }

  renderModelSelector(view: ModelSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        ...(view.modelProvider ? [`**Provider**：${inlineCode(view.modelProvider)}`] : []),
        `**当前模型**：${inlineCode(view.currentModel ?? "默认")}`,
        `**思考强度**：${inlineCode(view.reasoningEffort ?? "默认")}`,
        ...(view.notice ? [view.notice] : []),
      ].join("\n")),
      { tag: "hr" },
    ];
    if (view.models.length === 0) {
      elements.push(markdown("当前运行时未返回可用模型。"));
    } else {
      elements.push(...view.models.map((model) => {
        const isCurrent = model.id === view.currentModel;
        return {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "8px",
          vertical_align: "center",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              vertical_align: "center",
              elements: [markdown(
                `${inlineCode(model.id)}${model.isDefault ? " · 默认" : ""}`,
              )],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: isCurrent && !view.unifiedSettings
                ? [markdown("✅ 当前")]
                : [taskActionElement({
                    text: view.unifiedSettings ? (isCurrent ? "Continue" : "Select") : "Switch",
                    value: {
                      action: view.unifiedSettings ? "provider_model_select" : "model_select",
                      sessionId: view.sessionId,
                      contextKey: view.contextKey,
                      ...(view.modelProvider ? { provider: view.modelProvider } : {}),
                      model: model.id,
                      ...(view.permissionMode ? { permissionMode: view.permissionMode } : {}),
                    },
                  })],
            },
          ],
        };
      }));
    }
    if (view.unifiedSettings) {
      elements.push(
        { tag: "hr" },
        taskActionRow([{
          text: "Back",
          value: {
            action: "provider_open",
            sessionId: view.sessionId,
            contextKey: view.contextKey,
          },
        }]),
      );
    }
    return sectionCard(view.unifiedSettings ? "Provider 设置 · 模型" : "模型", elements, view.notice ? "green" : "blue");
  }

  renderPermissionSelector(view: PermissionSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
        `**Provider**：${inlineCode(view.modelProvider)}`,
        `**模型**：${inlineCode(view.model)}`,
        `**思考强度**：${inlineCode(view.reasoningEffort)}`,
        `**当前权限**：${inlineCode(permissionModeLabel(view.currentMode))}`,
      ].join("\n")),
      { tag: "hr" },
      ...(["auto", "confirm"] as PermissionMode[]).map((mode) => ({
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        vertical_align: "center",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "center",
            elements: [markdown(`${inlineCode(mode)} · ${permissionModeLabel(mode)}`)],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [taskActionElement({
              text: mode === view.currentMode ? "Apply" : "Select",
              value: {
                action: "provider_permission_select",
                sessionId: view.sessionId,
                contextKey: view.contextKey,
                provider: view.modelProvider,
                model: view.model,
                effort: view.reasoningEffort,
                permissionMode: mode,
              },
            })],
          },
        ],
      })),
      { tag: "hr" },
      taskActionRow([{
        text: "Back",
        value: {
          action: "provider_reasoning_open",
          sessionId: view.sessionId,
          contextKey: view.contextKey,
          provider: view.modelProvider,
          model: view.model,
          permissionMode: view.currentMode,
        },
      }]),
    ];
    return sectionCard("Provider 设置 · 权限", elements);
  }

  renderPromptQueue(view: PromptQueueCardView): Record<string, unknown> {
    const elements = view.prompts.length === 0
      ? [markdown("队列为空")]
      : view.prompts.map((prompt, index) => ({
          tag: "column_set",
          flex_mode: "stretch",
          horizontal_spacing: "8px",
          vertical_align: "center",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              vertical_align: "center",
              elements: [markdown(
                escapeCardHtml(
                  `${index + 1}. ${truncateText(prompt.text.replace(/\s+/g, " ").trim(), 180)}`,
                ),
              )],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: [{
                tag: "button",
                text: { tag: "plain_text", content: "Cancel" },
                type: "default",
                size: "tiny",
                behaviors: [{
                  type: "callback",
                  value: {
                    action: "queued_prompt_cancel",
                    promptId: prompt.id,
                    sessionId: view.sessionId,
                    contextKey: view.contextKey,
                  },
                }],
              }],
            },
          ],
        }));
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      header: {
        template: "grey",
        title: { tag: "plain_text", content: `排队 Prompt · ${view.prompts.length}` },
        padding: "8px 12px 8px 12px",
      },
      body: {
        direction: "vertical",
        vertical_spacing: "4px",
        padding: "8px 12px 8px 12px",
        elements,
      },
    };
  }

  renderSafeRestartStatus(view: SafeRestartStatusView): Record<string, unknown> {
    const countdown = view.phase === "countdown"
      ? `${Math.max(0, Math.ceil((view.remainingMs ?? 0) / 1_000))}s`
      : view.phase === "restarting"
        ? "0s"
        : view.phase === "cancelled"
          ? "已取消"
        : "等待阻塞项清空后开始";
    const status = view.phase === "waiting_tasks"
      ? "🟠 等待任务完成"
      : view.phase === "waiting_delivery"
        ? "🟠 等待最终结果投递"
        : view.phase === "countdown"
          ? "🟡 空闲确认中"
          : view.phase === "restarting"
            ? "🔄 正在重启"
            : "⚪ 已取消";
    const lines = [
      `**状态**：${status}`,
      `**重启原因**：${inlineCode(view.reason)}`,
      `**重启倒计时**：${countdown}`,
      `**待投递结果**：${view.pendingFinalDeliveries} 条`,
    ];
    const elements: Record<string, unknown>[] = [markdown(lines.join("\n"))];
    if (view.waitingTasks.length > 0) {
      const visible = view.waitingTasks.slice(0, 10);
      const taskLines = visible.map((task, index) =>
        `${index + 1}. ${task.title ? `${inlineCode(truncateText(task.title, 80))} · ` : ""}${inlineCode(task.id)}`);
      if (view.waitingTasks.length > visible.length) {
        taskLines.push(`… 还有 ${view.waitingTasks.length - visible.length} 个任务`);
      }
      elements.push({ tag: "hr" }, markdown(`**当前等待的任务（${view.waitingTasks.length}）**\n${taskLines.join("\n")}`));
    } else {
      elements.push({ tag: "hr" }, markdown("**当前等待的任务**：无"));
    }
    if (view.phase !== "restarting" && view.phase !== "cancelled") {
      elements.push(
        { tag: "hr" },
        taskActionRow([{
          text: "Cancel",
          value: {
            action: "safe_restart_cancel",
            scheduleId: String(view.scheduleId),
          },
        }]),
      );
    }
    const template = view.phase === "restarting"
      ? "blue"
      : view.phase === "cancelled"
        ? "grey"
        : "orange";
    return sectionCard("Agent Bot 安全重启", elements, template);
  }

  renderStartupStatus(view: StartupStatusView): Record<string, unknown> {
    const workspaceLine = view.workspaceKind === "projectless"
      ? "**任务范围**：未指定项目"
      : `**工作目录**：${inlineCode(view.cwd)}`;
    const lines = view.currentTask
      ? [
        `**当前任务**：${inlineCode(view.currentTask.title ?? view.currentTask.id)}`,
        workspaceLine,
        `**Provider / 模型 / 思考强度 / 权限**：${inlineCode(view.currentTask.modelProvider ?? "Agent 默认")} / ${inlineCode(view.currentTask.model ?? "默认")} / ${inlineCode(view.currentTask.reasoningEffort ?? "自动")} / ${inlineCode(permissionModeLabel(view.currentTask.permissionMode))}`,
        `**任务状态 / Agent**：${persistedTaskStatus(view.currentTask.sessionStatus, view.currentTask.lastTurnStatus)} / ${inlineCode(view.currentTask.agentName)}`,
        `**任务 ID**：${inlineCode(view.currentTask.id)}`,
      ]
      : [
        "**当前任务**：无，下一条普通消息会创建新任务",
        workspaceLine,
        `**Provider / 模型 / 思考强度 / 权限**：${inlineCode("Agent 默认")} / ${inlineCode("默认")} / ${inlineCode("自动")} / ${inlineCode(permissionModeLabel())}`,
        `**默认 Agent**：${view.defaultAgentTitle} (${inlineCode(view.defaultAgentName)})`,
      ];
    lines.push(
      `**Agent Bot 版本**：${inlineCode(view.agentBotVersion)}`,
      `**服务状态 / 启动时间**：🟢 在线 / ${formatStartupTime(view.startedAt)}`,
      `**重启原因**：${inlineCode(view.restartReason)}`,
      "> 发送消息即可开始对话；发送 `/new` 创建新任务；发送 `/help` 查看帮助。",
    );
    return sectionCard("Agent Bot 已启动", [markdown(lines.join("\n"))], "green");
  }

  renderInitializationWelcome(view: InitializationWelcomeView): Record<string, unknown> {
    const title = view.kind === "first"
      ? "欢迎使用 Agent Bot"
      : view.kind === "upgrade"
        ? "Agent Bot 已更新"
        : "Agent Bot 已准备就绪";
    const subtitle = view.activationPending
      ? "配置已完成，安全重启后生效"
      : view.kind === "first"
      ? "本地 Agent 已接入飞书"
      : view.kind === "upgrade"
        ? `新版本 ${view.version} 已生效`
        : "初始化配置已刷新";
    const activationNote = view.activationPending
      ? "当前任务完成并安全重启后生效。"
      : undefined;
    const intro = view.kind === "first"
      ? "**初始化完成**\n从现在起，你可以直接在飞书里把任务交给本机 Agent，并随时查看进度、切换任务或创建分支。"
      : view.kind === "upgrade"
        ? `**升级完成**\n${view.previousVersion ? `${inlineCode(view.previousVersion)} → ` : ""}${inlineCode(view.version)} 已准备好。${activationNote ?? "下面是本版值得关注的能力。"}`
        : `**配置刷新完成**\n${inlineCode(view.version)} 已重新检查配置、Agent 和飞书连接。${activationNote ?? ""}`;
    const logo = {
      ...localCardImage(view.logoPath, "Agent Bot logo"),
      preview: false,
    };
    const featureColumns = view.features.slice(0, 4).map((feature) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements: [markdown([
        `${feature.icon} **${feature.title}**`,
        `<font color='grey'>${feature.description}</font>`,
      ].join("\n"))],
    }));
    const featureRows = [0, 2].flatMap((start) => {
      const columns = featureColumns.slice(start, start + 2);
      return columns.length > 0
        ? [{
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "16px",
            vertical_align: "top",
            columns,
          }]
        : [];
    });
    const availableAgents = view.availableAgents.length > 0
      ? view.availableAgents.map((agent) => inlineCode(agent)).join(" · ")
      : inlineCode(view.defaultAgentName);
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      header: {
        template: view.kind === "first" ? "turquoise" : view.kind === "upgrade" ? "blue" : "green",
        title: { tag: "plain_text", content: title },
        subtitle: { tag: "plain_text", content: subtitle },
        padding: "12px 12px 12px 12px",
      },
      body: {
        direction: "vertical",
        vertical_spacing: "12px",
        padding: "12px 12px 12px 12px",
        elements: [
          {
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "16px",
            vertical_align: "center",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                vertical_align: "center",
                elements: [logo],
              },
              {
                tag: "column",
                width: "weighted",
                weight: 3,
                vertical_align: "center",
                elements: [markdown(intro)],
              },
            ],
          },
          { tag: "hr" },
          markdown(`**${view.kind === "upgrade" ? "本版亮点" : "你可以这样使用"}**`),
          ...featureRows,
          { tag: "hr" },
          markdown("> 直接发送消息即可开始；发送 `/new` 创建新任务；发送 `/help` 查看全部命令。"),
          {
            ...markdown(`**版本** ${inlineCode(view.version)}　·　**默认 Agent** ${inlineCode(view.defaultAgentTitle)}　·　**可用 Agent** ${availableAgents}`),
            text_size: "notation",
          },
          {
            ...markdown("📋 [查看更新日志](https://github.com/keyou/agent-bot/blob/master/CHANGELOG.md)"),
            text_size: "notation",
          },
        ],
      },
    };
  }

  renderTurn(state: TurnViewState): Record<string, unknown> {
    const elements = this.thinkingCardLayout === "timeline"
      ? renderTurnElements(state, "hidden")
      : renderGroupedTurnElements(state, "hidden");
    if (isTurnStoppable(state.status)) {
      elements.push({ tag: "hr" }, taskActionRow([{
        text: "Stop",
        type: "danger",
        value: { action: "turn_cancel", sessionId: state.sessionId, turnId: state.turnId },
      }]));
    } else if (state.status === "completed") {
      elements.push(
        { tag: "hr" },
        taskActionRow([{
          text: "Reset",
          value: { action: "turn_reset", sessionId: state.sessionId, turnId: state.turnId },
        }]),
        {
          ...markdown("<font color='grey'>Reset 会将当前任务的对话上下文恢复到本轮完成时；不会回退本地文件。</font>"),
          text_size: "notation",
        },
      );
    }
    return turnCard(
      turnTitle(state.status, state.prompt ?? state.taskTitle),
      turnTemplate(state.status),
      elements,
      renderTurnSubtitle(state),
    );
  }

  renderTurnDetails(state: TurnViewState): Record<string, unknown> {
    const title = state.taskTitle
      ? `任务执行详情：${truncateText(state.taskTitle.replace(/\s+/g, " ").trim(), 60)}`
      : "任务执行详情";
    return turnCard(title, "blue", renderTurnElements(state, "always"), renderTurnSubtitle(state));
  }

  renderActivityHistory(state: TurnViewState, requestedPage: number): Record<string, unknown> {
    const grouped = this.thinkingCardLayout === "grouped";
    const pages = grouped
      ? groupedActivityPages(turnActivities(state), state.projectCwd, {
        fullActivityText: true,
        includeReasoningHistory: true,
      })
      : activityPages(turnActivities(state));
    if (pages.length === 0) {
      return this.renderSectionsCard("思考活动历史", [{ lines: ["没有保存到活动记录。"] }]);
    }
    const page = Math.max(0, Math.min(Math.trunc(requestedPage), pages.length - 1));
    const actions: TaskListCardAction[] = [
      ...(pages.length > 1 ? [{
        text: "最新页",
        value: { action: "activity_history", turnId: state.turnId, page: "latest" },
      }] : []),
      ...(page > 0 ? [{
        text: "上一页",
        value: { action: "activity_history", turnId: state.turnId, page: String(page - 1) },
      }] : []),
      ...(page < pages.length - 2 ? [{
        text: "下一页",
        value: { action: "activity_history", turnId: state.turnId, page: String(page + 1) },
      }] : []),
    ];
    const elements: Record<string, unknown>[] = [];
    if (actions.length > 0) elements.push(taskActionRow(actions), { tag: "hr" });
    elements.push(...(grouped
      ? renderGroupedActivityGroups(pages[page] as GroupedTurnActivity[] | undefined ?? [], state.projectCwd, {
        fullActivityText: true,
        includeReasoningHistory: true,
      })
      : renderActivities(pages[page] as TurnActivity[] | undefined ?? [], state.projectCwd, true)));
    return sectionCard(`思考活动历史 · ${page + 1}/${pages.length}`, elements.length > 0 ? elements : [markdown("无")]);
  }

  renderSessionStarted(session: RuntimeSession): Record<string, unknown> {
    return this.baseCard("ACP 会话已创建", "green", [
      markdown(`**Agent**: ${session.agentName}\n**Session**: ${session.localSessionId}\n**CWD**: ${session.cwd}`),
    ]);
  }

  renderSessionUpdate(session: RuntimeSession, update: Record<string, JsonValue>): Record<string, unknown> {
    const updateType = String(update.sessionUpdate ?? "update");
    return this.baseCard(`ACP 更新：${updateType}`, "blue", [
      markdown(`**Agent**: ${session.agentName}\n**Session**: ${session.localSessionId}`),
      markdown(truncateText(formatUpdate(update), 6000)),
    ]);
  }

  renderPermissionRequest(
    session: RuntimeSession,
    permissionId: string,
    toolTitle: string,
    options: Array<{ optionId: string; name: string; kind: string }>,
  ): Record<string, unknown> {
    return this.baseCard("需要确认", "orange", [
      markdown(`**Session**: ${session.localSessionId}\n**Tool**: ${toolTitle}`),
      {
        tag: "action",
        actions: options.map((option) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: acpPermissionOptionLabel(option),
          },
          type: option.kind.startsWith("allow") ? "primary" : "default",
          value: {
            action: "permission",
            permissionId,
            optionId: option.optionId,
          },
        })),
      },
    ]);
  }

  renderStatus(status: string): Record<string, unknown> {
    return this.baseCard("Agent Bot 状态", "blue", [markdown(status)]);
  }

  renderSectionsCard(
    title: string,
    sections: CardSection[],
    actions: TaskListCardAction[] = [],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];
    sections.forEach((section, index) => {
      if (index > 0) elements.push({ tag: "hr" });
      const content = section.lines.join("\n");
      if (section.collapsible && section.title) {
        elements.push(collapsiblePanel(section.title, content, { elementId: section.elementId }));
      } else {
        const heading = section.title ? `**${section.title}**\n` : "";
        elements.push(markdown(`${heading}${content}`));
      }
    });
    if (actions.length > 0) elements.push({ tag: "hr" }, taskActionRow(actions));
    return sectionCard(title, elements);
  }

  renderHelpCard(
    title: string,
    introLines: string[],
    sections: HelpCardSection[],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [markdown(introLines.join("\n"))];
    for (const section of sections) {
      elements.push({ tag: "hr" }, markdown(`**${section.title}**`));
      elements.push(...section.commands.map(helpCommandRow));
    }
    return sectionCard(title, elements);
  }

  renderTaskListCard(
    title: string,
    sectionTitle: string,
    entries: TaskListCardEntry[],
    footerLines: string[],
    footerActions: TaskListCardAction[] = [],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [markdown(`**${sectionTitle}**`)];
    if (entries.length === 0) {
      elements.push(markdown("无"));
    } else {
      entries.forEach((entry, index) => {
        elements.push(markdown(entry.lines.join("\n")));
        if (entry.actions?.length) {
          elements.push(taskActionRow(entry.actions));
        }
        if (index < entries.length - 1) elements.push({ tag: "hr" });
      });
    }
    if (footerActions.length > 0) {
      elements.push({ tag: "hr" }, taskActionRow(footerActions));
    }
    if (footerLines.length > 0) {
      elements.push({ tag: "hr" }, markdown(footerLines.join("\n")));
    }
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      body: {
        elements,
      },
    };
  }

  renderSessionTaskListCard(
    title: string,
    sectionTitle: string,
    groups: SessionTaskCardGroup[],
    footerLines: string[],
    footerActions: TaskListCardAction[] = [],
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [markdown(`**${sectionTitle}**`)];
    if (groups.length === 0) {
      elements.push(markdown("无"));
    } else {
      groups.forEach((group) => {
        elements.push(sessionProjectRow(group));
        elements.push(...group.entries.map(sessionTaskPanel));
      });
    }
    if (footerActions.length > 0) {
      elements.push(taskActionRow(footerActions));
    }
    if (footerLines.length > 0) {
      elements.push(markdown(footerLines.join("\n")));
    }
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "fill",
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      body: {
        vertical_spacing: "4px",
        elements,
      },
    };
  }

  renderDirectoryBrowserCard(view: DirectoryBrowserCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown(`**当前目录**：${inlineCode(view.directory)}`),
      taskActionRow(view.currentActions),
      { tag: "hr" },
    ];
    const entryRows = view.entries.length === 0
      ? [directoryBrowserEmptyRow()]
      : view.entries.slice(0, DIRECTORY_BROWSER_ROW_COUNT).map(directoryBrowserEntryRow);
    while (entryRows.length < DIRECTORY_BROWSER_ROW_COUNT) entryRows.push(directoryBrowserPlaceholderRow());
    elements.push(...entryRows);
    if (view.navigationActions.length > 0) {
      elements.push({ tag: "hr" }, taskActionRow(view.navigationActions));
    }
    if (view.footerLines.length > 0) {
      elements.push({ tag: "hr" }, markdown(view.footerLines.join("\n")));
    }
    return sectionCard("文件浏览", elements, "blue", "2px");
  }

  renderResetHistoryCard(view: ResetHistoryCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      {
        ...markdown("<font color='grey'>Reset 会将当前任务的对话上下文恢复到所选轮次完成时；不会回退本地文件。</font>"),
        text_size: "notation",
      },
      { tag: "hr" },
      markdown("**历史对话轮次**"),
    ];
    if (view.entries.length === 0) {
      elements.push(markdown("当前任务还没有成功完成的 turn。"));
    } else {
      view.entries.forEach((entry) => {
        const action = entry.actions?.[0];
        elements.push(resetHistoryEntryRow(
          entry.graphNodeLine,
          entry.graphConnectorLine,
          entry.lines,
          action,
          entry.current === true,
        ));
      });
    }
    if (view.footerLines.length > 0) {
      elements.push({ tag: "hr" }, {
        ...markdown(view.footerLines.join("\n")),
        text_size: "notation",
      });
    }
    if (view.pageActions.length > 0) elements.push(taskActionRow(view.pageActions));
    return sectionCard("历史对话轮次", elements);
  }

  private baseCard(title: string, template: string, elements: unknown[]): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template,
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      elements,
    };
  }
}

function renderTurnSubtitle(state: TurnViewState): string {
  const elapsed = state.durationMs ?? Math.max(0, Date.now() - state.startedAt);
  const activityTools = turnActivities(state).filter((activity) => activity.kind === "tool").length;
  const totalTools = state.totalToolCount ?? activityTools;
  return [
    `耗时 ${formatTurnDuration(elapsed)}`,
    state.totalTokens !== undefined ? `${formatTokenCount(state.totalTokens)} tokens` : undefined,
    totalTools > 0 ? `${totalTools} 个工具` : undefined,
    state.fileSummary.length > 0 ? `${state.fileSummary.length} 个文件` : undefined,
  ].filter(Boolean).join(" · ");
}

function isTurnStoppable(status: TurnViewStatus): boolean {
  return status === "running" || status === "tool_running" || status === "waiting_for_approval";
}

function renderTurnElements(
  state: TurnViewState,
  assistantTextMode: "hidden" | "always",
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const allActivities = turnActivities(state);
  const pages = activityPages(allActivities);
  const visibleActivities = pages.at(-1) ?? [];
  if (state.plan.length > 0) elements.push(planPanel(state.plan));
  if (pages.length > 1) {
    elements.push(taskActionRow([{
      text: `查看历史思考（共 ${pages.length} 页）`,
      value: {
        action: "activity_history",
        turnId: state.turnId,
        page: String(pages.length - 2),
      },
    }]));
  }
  if (state.activitiesTruncated || pages.length > 1) elements.push(markdown("…"));
  elements.push(...renderActivities(visibleActivities, state.projectCwd));
  if (state.fileSummary.length > 0) elements.push(fileSummaryPanel(state));

  if (state.approval) {
    const request = state.approval;
    elements.push(markdown([
      `**${request.title}**`,
      request.command ? codeBlock(request.command, 800) : undefined,
      request.reason,
    ].filter(Boolean).join("\n")));
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      columns: request.options.map((option) => ({
        tag: "column",
        width: "auto",
        elements: [{
          tag: "button",
          text: { tag: "plain_text", content: approvalDecisionLabel(option.id) },
          type: option.id === "accept" || option.id === "acceptForSession" ? "primary" : option.id === "cancel" ? "danger" : "default",
          behaviors: [{
            type: "callback",
            value: {
              action: "approval",
              sessionId: state.sessionId,
              turnId: state.turnId,
              requestId: request.id,
              decision: option.id,
            },
          }],
        }],
      })),
    });
  }
  if (state.error) elements.push(markdown(codeBlock(state.error, 2_000)));
  const showAssistantText = state.assistantText && assistantTextMode === "always";
  if (showAssistantText) {
    if (elements.length > 0) elements.push({ tag: "hr" });
    const heading = state.status === "completed" ? "回答" : "回答生成中";
    elements.push(markdown(`**${heading}**\n${truncateText(state.assistantText, 3_000)}`));
  }
  if (elements.length === 0) elements.push(markdown(emptyTurnText(state.status, state.agentLabel)));
  return elements;
}

function renderGroupedTurnElements(
  state: TurnViewState,
  assistantTextMode: "hidden" | "always",
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const allActivities = turnActivities(state);
  const livePages = groupedActivityPages(allActivities, state.projectCwd);
  const historyPages = groupedActivityPages(allActivities, state.projectCwd, {
    fullActivityText: true,
    includeReasoningHistory: true,
  });
  const visibleGroups = livePages.at(-1) ?? [];
  if (state.plan.length > 0) elements.push(planPanel(state.plan));
  if (historyPages.length > 1) {
    elements.push(taskActionRow([{
      text: `查看历史思考（共 ${historyPages.length} 页）`,
      value: {
        action: "activity_history",
        turnId: state.turnId,
        page: String(historyPages.length - 2),
      },
    }]));
  }
  if (state.activitiesTruncated || livePages.length > 1 || historyPages.length > 1) elements.push(markdown("…"));
  elements.push(...renderGroupedActivityGroups(visibleGroups, state.projectCwd));
  if (state.fileSummary.length > 0) elements.push(fileSummaryPanel(state));

  if (state.approval) {
    const request = state.approval;
    elements.push(markdown([
      `**${request.title}**`,
      request.command ? codeBlock(request.command, 800) : undefined,
      request.reason,
    ].filter(Boolean).join("\n")));
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      columns: request.options.map((option) => ({
        tag: "column",
        width: "auto",
        elements: [{
          tag: "button",
          text: { tag: "plain_text", content: approvalDecisionLabel(option.id) },
          type: option.id === "accept" || option.id === "acceptForSession" ? "primary" : option.id === "cancel" ? "danger" : "default",
          behaviors: [{
            type: "callback",
            value: {
              action: "approval",
              sessionId: state.sessionId,
              turnId: state.turnId,
              requestId: request.id,
              decision: option.id,
            },
          }],
        }],
      })),
    });
  }
  if (state.error) elements.push(markdown(codeBlock(state.error, 2_000)));
  const showAssistantText = state.assistantText && assistantTextMode === "always";
  if (showAssistantText) {
    if (elements.length > 0) elements.push({ tag: "hr" });
    const heading = state.status === "completed" ? "回答" : "回答生成中";
    elements.push(markdown(`**${heading}**\n${truncateText(state.assistantText, 3_000)}`));
  }
  if (elements.length === 0) elements.push(markdown(emptyTurnText(state.status, state.agentLabel)));
  return elements;
}

function emptyTurnText(status: TurnViewStatus, agentLabel?: string): string {
  const label = agentLabel?.trim().replace(/[\r\n]+/g, " ") || "Agent";
  if (status === "starting") return `正在连接 ${label}…`;
  if (status === "completed") return "本轮已完成。";
  if (status === "cancelled") return "本轮已停止。";
  return `正在等待 ${label} 返回进度…`;
}

function planPanel(plan: TurnViewState["plan"]): Record<string, unknown> {
  const completed = plan.filter((step) => step.status === "completed").length;
  return collapsiblePanel(`计划 · ${completed}/${plan.length}`, plan.map(renderPlanStep).join("\n"), {
    expanded: true,
    borderColor: "blue",
  });
}

function fileSummaryPanel(state: TurnViewState): Record<string, unknown> {
  return collapsiblePanel(
    `文件变更 · ${state.fileSummary.length}`,
    state.fileSummary
      .map((file) => `- ${escapeMarkdownFilePath(displayFilePath(file.path, state.projectCwd))}  +${file.additions ?? 0} -${file.deletions ?? 0}`)
      .join("\n"),
    { elementId: "turn_files" },
  );
}

function renderPlanStep(step: TurnViewState["plan"][number]): string {
  const marker = step.status === "completed" ? "✅" : step.status === "in_progress" ? "🔄" : "○";
  return `${marker} ${step.text}`;
}

function renderActivity(
  activity: TurnActivity,
  projectCwd?: string,
  fullAssistantText = false,
): Record<string, unknown>[] {
  if (activity.kind === "user") {
    const text = activity.text.trim();
    if (!text) return [];
    const chunks = fullAssistantText
      ? splitText(text, ACTIVITY_TEXT_CHUNK)
      : [truncateText(text, MAX_LIVE_ASSISTANT_TEXT)];
    return chunks.map((chunk, index) => markdown(boldUserActivity(chunk, index === 0)));
  }
  if (activity.kind === "assistant" || (activity.kind === "reasoning" && activity.id.startsWith("commentary:"))) {
    const text = activity.text.trim();
    if (!text) return [];
    return fullAssistantText
      ? splitText(text, ACTIVITY_TEXT_CHUNK).map(markdown)
      : [markdown(truncateText(text, MAX_LIVE_ASSISTANT_TEXT))];
  }
  if (activity.kind === "reasoning") {
    return renderReasoningGroup([activity]);
  }
  return [toolPanel(activity.tool, projectCwd)];
}

function boldUserActivity(text: string, showIcon: boolean): string {
  return text
    .split("\n")
    .map((line, index) => {
      const content = showIcon && index === 0 ? `🙋 ${line}` : line;
      return content ? `**${content}**` : "";
    })
    .join("\n");
}

function renderActivities(
  activities: TurnActivity[],
  projectCwd?: string,
  fullAssistantText = false,
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  let reasoningGroup: Array<Extract<TurnActivity, { kind: "reasoning" }>> = [];
  const flushReasoning = (): void => {
    if (reasoningGroup.length === 0) return;
    elements.push(...renderReasoningGroup(reasoningGroup));
    reasoningGroup = [];
  };

  for (const activity of activities) {
    if (isRawReasoning(activity)) {
      reasoningGroup.push(activity);
      continue;
    }
    flushReasoning();
    elements.push(...renderActivity(activity, projectCwd, fullAssistantText));
  }
  flushReasoning();
  return elements;
}

type GroupedTurnActivity =
  | { kind: "activity"; activity: TurnActivity }
  | {
      kind: "execution";
      id: string;
      latestReasoning?: Extract<TurnActivity, { kind: "reasoning" }>;
      reasonings: Array<Extract<TurnActivity, { kind: "reasoning" }>>;
      tools: ToolState[];
    };

function renderGroupedActivityGroups(
  groups: GroupedTurnActivity[],
  projectCwd?: string,
  options: {
    fullActivityText?: boolean;
    includeReasoningHistory?: boolean;
  } = {},
): Record<string, unknown>[] {
  return groups.flatMap((group) => {
    if (group.kind === "activity") {
      return renderActivity(group.activity, projectCwd, options.fullActivityText === true);
    }
    if (group.tools.length === 0) {
      const reasonings = options.includeReasoningHistory
        ? group.reasonings
        : group.latestReasoning ? [group.latestReasoning] : [];
      return renderReasoningGroup(reasonings);
    }
    return [executionActivityPanel(group, projectCwd, options.includeReasoningHistory === true)];
  });
}

function groupTurnActivities(activities: TurnActivity[]): GroupedTurnActivity[] {
  const groups: GroupedTurnActivity[] = [];
  let segment: TurnActivity[] = [];
  const flushSegment = (): void => {
    if (segment.length === 0) return;
    let execution: Extract<GroupedTurnActivity, { kind: "execution" }> | undefined;
    let executionPosition = -1;
    for (let index = 0; index < segment.length; index += 1) {
      const activity = segment[index]!;
      if (isRawReasoning(activity)) {
        execution ??= { kind: "execution", id: activity.id, reasonings: [], tools: [] };
        execution.reasonings.push(activity);
        execution.latestReasoning = activity;
        executionPosition = index;
      } else if (activity.kind === "tool") {
        execution ??= { kind: "execution", id: activity.id, reasonings: [], tools: [] };
        execution.tools.push(activity.tool);
        executionPosition = index;
      }
    }
    for (let index = 0; index < segment.length; index += 1) {
      const activity = segment[index]!;
      if (index === executionPosition && execution) groups.push(execution);
      if (!isRawReasoning(activity) && activity.kind !== "tool") {
        groups.push({ kind: "activity", activity });
      }
    }
    segment = [];
  };

  for (const activity of activities) {
    if (!isCommentaryActivity(activity)) {
      segment.push(activity);
      continue;
    }
    flushSegment();
    groups.push({ kind: "activity", activity });
  }
  flushSegment();
  return groups;
}

function isCommentaryActivity(activity: TurnActivity): boolean {
  return activity.kind === "assistant"
    || (activity.kind === "reasoning" && activity.id.startsWith("commentary:"));
}

function executionActivityPanel(
  group: Extract<GroupedTurnActivity, { kind: "execution" }>,
  projectCwd: string | undefined,
  includeReasoningHistory = false,
): Record<string, unknown> {
  const status = executionActivityStatus(group.tools);
  const elements = [
    ...(includeReasoningHistory ? renderReasoningGroup(group.reasonings) : []),
    ...group.tools.map((tool) => toolPanel(tool, projectCwd)),
  ];
  return collapsiblePanel(
    executionActivityTitle(group, status),
    elements,
    {
      elementId: executionActivityPanelElementId(group.id),
      expanded: false,
      borderColor: status === "failed" ? "red" : status === "running" ? "blue" : "grey",
      compact: true,
    },
  );
}

function executionActivityStatus(tools: ToolState[]): ToolState["status"] {
  if (tools.some((tool) => tool.status === "running")) return "running";
  if (tools.some((tool) => tool.status === "failed")) return "failed";
  return "completed";
}

function executionActivityTitle(
  group: Extract<GroupedTurnActivity, { kind: "execution" }>,
  status: ToolState["status"],
): string {
  const icon = status === "running" ? "⏳" : status === "failed" ? "❌" : "💭";
  const latestReasoning = group.latestReasoning?.text
    ? removeMarkdownBold(group.latestReasoning.text).replace(/\s+/g, " ").trim()
    : "";
  const summary = latestReasoning
    ? truncateText(latestReasoning, 90)
    : status === "running"
      ? "正在执行工具"
      : status === "failed"
        ? "工具执行失败"
        : "已执行工具";
  return `${icon} ${summary} · ${group.tools.length} 个工具`;
}

function executionActivityPanelElementId(activityId: string): string {
  const digest = createHash("sha256").update(activityId).digest("hex").slice(0, 10);
  return `turn_exec_${digest}`;
}

function renderReasoningGroup(
  activities: Array<Extract<TurnActivity, { kind: "reasoning" }>>,
): Record<string, unknown>[] {
  const sections = activities
    .map((activity) => activity.text.trim())
    .filter(Boolean)
    .map((text) => removeMarkdownBold(truncateText(text, 2_000)));
  if (sections.length === 0) return [];
  const quotedReasoning = sections
    .map((text) => `💭 ${text.replaceAll("\n", "\n> ")}`)
    .join("\n> ");
  return [markdown(`> ${quotedReasoning}`)];
}

function isRawReasoning(
  activity: TurnActivity,
): activity is Extract<TurnActivity, { kind: "reasoning" }> {
  return activity.kind === "reasoning" && !activity.id.startsWith("commentary:");
}

const ACTIVITIES_PER_PAGE = 40;
const GROUPED_TOOLS_PER_PANEL = 8;
const GROUPED_PAGE_ACTIVITY_BYTES = 24 * 1024;
const GROUPED_PAGE_ACTIVITY_COMPONENTS = 160;
const MAX_LIVE_ASSISTANT_TEXT = 2_000;
const ACTIVITY_TEXT_CHUNK = 2_500;

function activityPages(activities: TurnActivity[]): TurnActivity[][] {
  if (activities.length === 0) return [];
  if (activities.length <= ACTIVITIES_PER_PAGE) return [activities];
  const pages: TurnActivity[][] = [];
  const firstPageSize = activities.length % ACTIVITIES_PER_PAGE || ACTIVITIES_PER_PAGE;
  pages.push(activities.slice(0, firstPageSize));
  for (let index = firstPageSize; index < activities.length; index += ACTIVITIES_PER_PAGE) {
    pages.push(activities.slice(index, index + ACTIVITIES_PER_PAGE));
  }
  return pages;
}

function groupedActivityPages(
  activities: TurnActivity[],
  projectCwd?: string,
  renderOptions: {
    fullActivityText?: boolean;
    includeReasoningHistory?: boolean;
  } = {},
): GroupedTurnActivity[][] {
  const groups = groupTurnActivities(activities).flatMap(splitGroupedExecutionActivity);
  if (groups.length === 0) return [];

  const newestFirst: GroupedTurnActivity[][] = [];
  let page: GroupedTurnActivity[] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const candidate = [group, ...page];
    if (page.length > 0 && !groupedActivityPageFits(candidate, projectCwd, renderOptions)) {
      newestFirst.push(page);
      page = [];
    }
    page.unshift(group);
  }
  if (page.length > 0) newestFirst.push(page);
  return newestFirst.reverse();
}

function groupedActivityPageFits(
  groups: GroupedTurnActivity[],
  projectCwd: string | undefined,
  renderOptions: {
    fullActivityText?: boolean;
    includeReasoningHistory?: boolean;
  },
): boolean {
  const elements = renderGroupedActivityGroups(groups, projectCwd, renderOptions);
  return Buffer.byteLength(JSON.stringify(elements), "utf8") <= GROUPED_PAGE_ACTIVITY_BYTES
    && countCardComponents(elements) <= GROUPED_PAGE_ACTIVITY_COMPONENTS;
}

function countCardComponents(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + countCardComponents(entry), 0);
  }
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  return (typeof record.tag === "string" ? 1 : 0)
    + Object.values(record).reduce<number>((total, entry) => total + countCardComponents(entry), 0);
}

function splitGroupedExecutionActivity(group: GroupedTurnActivity): GroupedTurnActivity[] {
  if (group.kind !== "execution" || group.tools.length <= GROUPED_TOOLS_PER_PANEL) return [group];
  const chunks: Array<Extract<GroupedTurnActivity, { kind: "execution" }>> = [];
  for (let index = 0; index < group.tools.length; index += GROUPED_TOOLS_PER_PANEL) {
    const tools = group.tools.slice(index, index + GROUPED_TOOLS_PER_PANEL);
    const isLast = index + GROUPED_TOOLS_PER_PANEL >= group.tools.length;
    chunks.push({
      kind: "execution",
      id: index === 0 ? group.id : tools[0]?.id ?? `${group.id}:${index}`,
      ...(isLast && group.latestReasoning ? { latestReasoning: group.latestReasoning } : {}),
      reasonings: isLast ? group.reasonings : [],
      tools,
    });
  }
  return chunks;
}

function splitText(value: string, maxLength: number): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxLength) {
    chunks.push(value.slice(offset, offset + maxLength));
  }
  return chunks;
}

function removeMarkdownBold(value: string): string {
  return value
    .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
    .replace(/__([\s\S]+?)__/g, "$1");
}

function turnActivities(state: TurnViewState): TurnActivity[] {
  if (state.activities?.length) return state.activities;

  const activities: TurnActivity[] = [];
  if (state.progressText) {
    activities.push({ kind: "reasoning", id: "legacy-progress", text: state.progressText });
  }
  const tools = [state.activeTool, ...state.failedTools, ...state.completedTools].filter(
    (tool): tool is ToolState => tool !== undefined,
  );
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.id)) continue;
    seen.add(tool.id);
    activities.push({ kind: "tool", id: tool.id, tool });
  }
  return activities;
}

function toolPanel(tool: ToolState, projectCwd?: string): Record<string, unknown> {
  const elements = [markdown(renderToolDetails(tool, projectCwd))];
  if ((tool.kind === "image_view" || tool.kind === "image_generation") && tool.imagePath) {
    elements.push(localCardImage(tool.imagePath, tool.kind === "image_generation" ? "生成图片" : "view_image 图片"));
  }
  return collapsiblePanel(toolPanelTitle(tool), elements, { elementId: toolPanelElementId(tool.id) });
}

function toolPanelElementId(toolId: string): string {
  const digest = createHash("sha256").update(toolId).digest("hex").slice(0, 16);
  return `turn_tool_${digest}`;
}

function collapsiblePanel(
  title: string,
  content: string | Record<string, unknown>[],
  options: {
    expanded?: boolean;
    borderColor?: string;
    elementId?: string;
    compact?: boolean;
  } = {},
): Record<string, unknown> {
  const compact = options.compact === true;
  return {
    tag: "collapsible_panel",
    ...(options.elementId ? { element_id: options.elementId } : {}),
    direction: "vertical",
    vertical_spacing: compact ? "2px" : "4px",
    padding: compact ? "4px 6px" : "8px",
    margin: "0px",
    expanded: options.expanded ?? false,
    header: {
      title: { tag: "plain_text", content: title },
      vertical_align: "center",
      padding: compact ? "2px 4px 2px 4px" : "4px 8px 4px 8px",
    },
    border: {
      color: options.borderColor ?? "grey",
      corner_radius: "5px",
    },
    elements: typeof content === "string" ? [markdown(content)] : content,
  };
}

function sessionTaskPanel(entry: SessionTaskCardEntry): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [markdown(entry.detailLines.join("\n"))];
  if (entry.actions?.length) elements.push(sessionActionOverflow(entry.actions));
  return collapsiblePanel(entry.summary, elements, {
    elementId: sessionTaskPanelElementId(entry.reference),
    borderColor: entry.current ? "green" : "grey",
    compact: true,
  });
}

function sessionProjectRow(group: SessionTaskCardGroup): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    vertical_align: "center",
    margin: "6px 0px 0px 0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [markdown(`**${escapeCardActionText(group.title)}**`)],
      },
      ...(group.actions ?? []).map((action) => ({
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [sessionActionButton(action)],
      })),
    ],
  };
}

function sessionTaskPanelElementId(reference: string): string {
  return `session_task_${createHash("sha256").update(reference).digest("hex").slice(0, 16)}`;
}

function sessionActionOverflow(actions: TaskListCardAction[]): Record<string, unknown> {
  return {
    tag: "overflow",
    options: actions.map((action) => ({
      text: { tag: "plain_text", content: action.text },
      value: JSON.stringify(action.value),
    })),
  };
}

function sessionActionButton(action: TaskListCardAction): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: action.text },
    type: action.type === "danger" ? "danger" : "default",
    size: "tiny",
    behaviors: [{
      type: "callback",
      value: action.value,
    }],
  };
}

function renderToolDetails(tool: ToolState, projectCwd?: string): string {
  const command = tool.command ?? tool.title;
  const fileSummary = tool.files?.length
    ? tool.files
      .map((file) => `${displayFilePath(file.path, projectCwd)}  +${file.additions ?? 0} -${file.deletions ?? 0}`)
      .join("\n")
    : undefined;
  const result = tool.error ?? tool.output ?? fileSummary;
  const normalizedCommand = stripAnsi(command).trim();
  const displayCommand = tool.kind === "command"
    ? unwrapPowerShellCommand(normalizedCommand) ?? normalizedCommand
    : normalizedCommand;
  const commandText = truncateText(displayCommand, 800);
  const resultText = result ? truncateMiddle(stripAnsi(result).trim(), 1_200) : undefined;
  return codeBlock([`$ ${commandText}`, resultText].filter((part): part is string => part !== undefined).join("\n"), 2_003);
}

function displayFilePath(filePath: string, projectCwd?: string): string {
  if (!projectCwd) return filePath;
  const pathApi = usesWindowsPaths(projectCwd, filePath) ? path.win32 : path;
  const normalizedCwd = pathApi.resolve(projectCwd);
  const absolutePath = pathApi.isAbsolute(filePath)
    ? pathApi.normalize(filePath)
    : pathApi.resolve(normalizedCwd, filePath);
  const relativePath = pathApi.relative(normalizedCwd, absolutePath);
  const isInsideProject = relativePath === ""
    || (!pathApi.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${pathApi.sep}`));
  return isInsideProject ? relativePath || "." : absolutePath;
}

function escapeMarkdownFilePath(filePath: string): string {
  return filePath.replaceAll("\\.", "\\\\.");
}

function usesWindowsPaths(...values: string[]): boolean {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value));
}

function toolPanelTitle(tool: ToolState): string {
  const icon = tool.status === "failed" ? "❌" : tool.status === "running" ? "⏳" : "✅";
  const command = stripAnsi(tool.command ?? tool.title).trim();
  const meaningfulCommand = tool.kind === "web_search"
    ? tool.title
    : unwrapPowerShellCommand(command) ?? tool.title;
  const duration = toolDuration(tool);
  const prefix = `${icon} `;
  const suffix = duration ? ` · ${duration}` : "";
  const title = truncateText(
    meaningfulCommand.replace(/\s+/g, " ").trim(),
    Math.max(20, 100 - prefix.length - suffix.length),
  );
  return `${prefix}${title}${suffix}`;
}

function toolDuration(tool: ToolState): string | undefined {
  if (tool.startedAt === undefined) return undefined;
  const endedAt = tool.status === "running" ? Date.now() : tool.completedAt;
  if (endedAt === undefined) return undefined;
  return formatCompactDuration(endedAt - tool.startedAt);
}

function formatCompactDuration(durationMs: number): string {
  const totalTenths = Math.max(0, Math.round(durationMs / 100));
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const secondsText = `${String(seconds).padStart(2, "0")}.${tenths}s`;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secondsText}`;
  }
  if (totalMinutes > 0) return `${String(totalMinutes).padStart(2, "0")}:${secondsText}`;
  return `${seconds}.${tenths}s`;
}

function formatTurnDuration(durationMs: number): string {
  const normalized = Math.max(0, durationMs);
  if (Math.round(normalized / 100) < 100) return formatCompactDuration(normalized);
  const totalSeconds = Math.round(normalized / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  if (totalMinutes > 0) return `${String(totalMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}

function unwrapPowerShellCommand(command: string): string | undefined {
  const executable = command.match(
    /^(?:"[^"]*(?:pwsh|powershell)\.exe"|(?:\S*[\\/])?(?:pwsh|powershell)(?:\.exe)?)(?=\s|$)/i,
  );
  if (!executable) return undefined;
  const args = command.slice(executable[0].length);
  const commandFlag = /(?:^|\s)-(?:Command|c)(?:\s+|$)/i.exec(args);
  if (!commandFlag) return undefined;
  const payload = args.slice(commandFlag.index + commandFlag[0].length).trim();
  if (!payload) return undefined;
  const quote = payload[0];
  if ((quote === "\"" || quote === "'") && payload.at(-1) === quote) return payload.slice(1, -1).trim();
  return payload;
}

function codeBlock(value: string, maxLength: number): string {
  const clean = stripAnsi(value).trim();
  return `\`\`\`\n${truncateText(clean, maxLength).replaceAll("```", "''' ")}\n\`\`\``;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function formatStartupTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

function permissionModeLabel(mode?: PermissionMode): string {
  return mode === "confirm" ? "执行前确认" : "自动执行";
}

function persistedTaskStatus(sessionStatus: string, lastTurnStatus?: string): string {
  if (sessionStatus === "running" || lastTurnStatus === "running") {
    return "上次运行中，可在下一条消息时恢复";
  }
  const labels: Record<string, string> = {
    starting: "上次正在启动",
    ready: "就绪",
    completed: "上次已完成",
    cancelled: "上次已停止",
    closed: "已关闭",
    failed: "上次失败",
  };
  return labels[lastTurnStatus ?? sessionStatus] ?? lastTurnStatus ?? sessionStatus;
}

function turnTitle(status: TurnViewStatus, prompt?: string): string {
  const reactionEmoji = status === "completed"
    ? "✅"
    : status === "failed"
      ? "❌"
      : status === "cancelled"
        ? "⏹️"
        : status === "waiting_for_approval"
          ? "🙋"
          : "⏳";
  const currentStatus = status === "completed"
    ? "已完成"
    : status === "failed"
      ? "执行失败"
      : status === "cancelled"
        ? "已停止"
        : status === "waiting_for_approval"
          ? "等待确认"
          : "正在处理";
  const compactPrompt = truncateTurnPrompt(prompt);
  const title = compactPrompt ? `${currentStatus}：${compactPrompt}` : currentStatus;
  return `${reactionEmoji} ${title}`;
}

function truncateTurnPrompt(prompt?: string): string {
  const characters = Array.from(prompt?.replace(/\s+/g, " ").trim() ?? "");
  if (characters.length <= 40) return characters.join("");
  return `${characters.slice(0, 37).join("")}...`;
}

function turnTemplate(status: TurnViewStatus): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "cancelled") return "grey";
  if (status === "waiting_for_approval") return "orange";
  return "blue";
}

function formatTokenCount(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 10_000) {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(rounded);
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumSignificantDigits: 3,
  }).format(rounded);
}

function markdown(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function escapeCardHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function approvalDecisionLabel(decision: ApprovalDecision): string {
  const labels: Record<ApprovalDecision, string> = {
    accept: "Allow Once",
    acceptForSession: "Allow for Session",
    decline: "Deny",
    cancel: "Cancel Task",
  };
  return labels[decision];
}

function acpPermissionOptionLabel(option: { name: string; kind: string }): string {
  const labels: Record<string, string> = {
    allow_once: "Allow Once",
    allow_always: "Always Allow",
    reject_once: "Deny Once",
    reject_always: "Always Deny",
  };
  return labels[option.kind] ?? (/^[\x20-\x7E]+$/.test(option.name) ? option.name : "Select");
}

function settingsTabRow(
  activeTab: ExecutionSettingsTab,
  baseAction: Record<string, string>,
  showAgentTab: boolean,
  showRuntimeTabs: boolean,
): Record<string, unknown> | undefined {
  const tabs: Array<{ id: ExecutionSettingsTab; label: string }> = [
    ...(showAgentTab ? [{ id: "agent" as const, label: "Agent" }] : []),
    ...(showRuntimeTabs
      ? [
          { id: "provider" as const, label: "Provider" },
          { id: "model" as const, label: "Model" },
          { id: "thinking" as const, label: "Thinking" },
          { id: "permission" as const, label: "Permission" },
        ]
      : []),
  ];
  if (tabs.length === 0) return undefined;
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "2px",
    margin: "8px 0 0 0",
    columns: tabs.flatMap((tab, index) => [
      ...(index > 0
        ? [{
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [{ ...markdown("·"), text_align: "center", text_size: "notation" }],
          }]
        : []),
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [settingsTabElement(tab.label, tab.id === activeTab, {
          action: "settings_tab_open",
          ...baseAction,
          tab: tab.id,
        })],
      },
    ]),
  };
}

function settingsTabElement(
  label: string,
  active: boolean,
  value: Record<string, string>,
): Record<string, unknown> {
  if (active) {
    return {
      ...markdown(escapeCardHtml(label)),
      text_align: "center",
      text_size: "notation",
    };
  }
  const action = taskActionElement({ text: label, value });
  return {
    ...action,
    padding: "6px 0px",
    elements: (action.elements as Array<Record<string, unknown>>).map((element) => ({
      ...element,
      text_align: "center",
      text_size: "notation",
    })),
  };
}

function settingsOptionRow(input: {
  label: string;
  current: boolean;
  action: TaskListCardAction;
}): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    vertical_align: "center",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [markdown(input.label)],
      },
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: input.current ? [markdown("✅ 当前")] : [taskActionElement(input.action)],
      },
    ],
  };
}

function resetHistoryEntryRow(
  graphNodeLine: string,
  graphConnectorLine: string | undefined,
  lines: string[],
  action: TaskListCardAction | undefined,
  current: boolean,
): Record<string, unknown> {
  const graph = [
    `<font color='${current ? "green" : "blue"}'>${escapeCardHtml(graphNodeLine)}</font>`,
    ...(graphConnectorLine
      ? [`<font color='grey'>${escapeCardHtml(graphConnectorLine)}</font>`]
      : []),
  ].join("\n");
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "top",
    columns: [
      {
        tag: "column",
        width: "auto",
        vertical_align: "top",
        elements: [{
          ...markdown(graph),
          text_align: "center",
        }],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [markdown(lines.join("\n"))],
      },
      {
        tag: "column",
        width: "auto",
        vertical_align: "top",
        elements: current
          ? [markdown("✅ 当前")]
          : action
            ? [taskActionElement(action)]
            : [],
      },
    ],
  };
}

function taskActionRow(actions: TaskListCardAction[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    margin: "2px 0 0 0",
    columns: actions.map((action) => ({
      tag: "column",
      width: "auto",
      vertical_align: "center",
      elements: [taskActionElement(action)],
    })),
  };
}

function directoryBrowserEntryRow(entry: DirectoryBrowserCardEntry): Record<string, unknown> {
  const label = `${directoryBrowserEntryIcon(entry.kind)} ${entry.name}`;
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "center",
    margin: "0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: entry.openAction
          ? [taskActionElement({ ...entry.openAction, text: label })]
          : [markdown(escapeCardHtml(label))],
      },
      ...(entry.actions ?? []).map((action) => ({
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [taskActionElement(action)],
      })),
    ],
  };
}

function directoryBrowserEmptyRow(): Record<string, unknown> {
  return directoryBrowserStaticRow("这个目录为空。");
}

function directoryBrowserPlaceholderRow(): Record<string, unknown> {
  return directoryBrowserStaticRow("\u00a0");
}

function directoryBrowserStaticRow(content: string): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "center",
    margin: "0px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "center",
      elements: [markdown(content)],
    }],
  };
}

function directoryBrowserEntryIcon(kind: DirectoryBrowserCardEntry["kind"]): string {
  switch (kind) {
    case "directory": return "📁";
    case "drive": return "💽";
    case "image": return "🖼️";
    case "binary": return "📦";
    case "file": return "📄";
  }
}

function taskActionElement(action: TaskListCardAction): Record<string, unknown> {
  return {
    tag: "interactive_container",
    margin: "0px",
    padding: "0px",
    has_border: false,
    elements: [markdown(
      `<font color='${action.type === "danger" ? "red" : "blue"}'>${escapeCardActionText(action.text)}</font>`,
    )],
    behaviors: [{
      type: "callback",
      value: action.value,
    }],
  };
}

function escapeCardActionText(value: string): string {
  return escapeCardHtml(value).replaceAll("\\", "&#92;");
}

function helpCommandRow(command: HelpCardCommand): Record<string, unknown> {
  const details = [
    command.usage ? `**${command.usage}**` : undefined,
    command.description,
  ].filter((line): line is string => Boolean(line)).join("　");
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    vertical_align: "top",
    margin: "2px 0 0 0",
    columns: [
      {
        tag: "column",
        width: "auto",
        vertical_align: "top",
        elements: [
          command.action
            ? taskActionElement(command.action)
            : markdown(`**${escapeCardHtml(command.text)}**`),
        ],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [markdown(details)],
      },
    ],
  };
}

function turnCard(
  title: string,
  template: string,
  elements: Record<string, unknown>[],
  subtitle: string,
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title,
      },
      subtitle: {
        tag: "plain_text",
        content: subtitle,
      },
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      vertical_spacing: "8px",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function sectionCard(
  title: string,
  elements: Record<string, unknown>[],
  template = "blue",
  verticalSpacing = "8px",
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title,
      },
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      vertical_spacing: verticalSpacing,
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function formatUpdate(update: Record<string, JsonValue>): string {
  const updateType = update.sessionUpdate;
  if (updateType === "agent_message_chunk" && isObject(update.content)) {
    const content = update.content;
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    return [
      update.title ? `**${String(update.title)}**` : undefined,
      update.status ? `状态：${String(update.status)}` : undefined,
      update.kind ? `类型：${String(update.kind)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `\`\`\`json\n${JSON.stringify(update, null, 2)}\n\`\`\``;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
