import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonValue } from "../acp/acpTypes.js";
import type { RuntimeSession } from "../acp/AcpSessionManager.js";
import type {
  ModelOption,
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
  defaultAgentName: string;
  defaultAgentTitle: string;
  cwd: string;
  workspaceKind?: "project" | "projectless";
  currentTask?: {
    id: string;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: PermissionMode;
    agentName: string;
    sessionStatus: string;
    lastTurnStatus?: string;
  };
}

export interface SafeRestartStatusView {
  reason: string;
  phase: "waiting_tasks" | "waiting_delivery" | "countdown" | "restarting";
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
  notice?: string;
}

export interface ReasoningSelectorCardView {
  sessionId: string;
  contextKey: string;
  model: string;
  currentEffort?: string;
  options: ReasoningEffortOption[];
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

export interface TaskListCardEntry {
  lines: string[];
  actions?: TaskListCardAction[];
}

export class CardRenderer {
  renderReasoningSelector(view: ReasoningSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
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
              elements: isCurrent
                ? [markdown("✅ 当前")]
                : [taskActionElement({
                    text: "切换",
                    value: {
                      action: "reasoning_select",
                      sessionId: view.sessionId,
                      contextKey: view.contextKey,
                      model: view.model,
                      effort: option.value,
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
        text: "返回模型",
        value: {
          action: "model_open",
          sessionId: view.sessionId,
          contextKey: view.contextKey,
        },
      }]),
    );
    return sectionCard("思考模式", elements, view.notice ? "green" : "blue");
  }

  renderModelSelector(view: ModelSelectorCardView): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      markdown([
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
              elements: isCurrent
                ? [markdown("✅ 当前")]
                : [taskActionElement({
                    text: "切换",
                    value: {
                      action: "model_select",
                      sessionId: view.sessionId,
                      contextKey: view.contextKey,
                      model: model.id,
                    },
                  })],
            },
          ],
        };
      }));
    }
    return sectionCard("模型", elements, view.notice ? "green" : "blue");
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
        : "等待阻塞项清空后开始";
    const status = view.phase === "waiting_tasks"
      ? "🟠 等待任务完成"
      : view.phase === "waiting_delivery"
        ? "🟠 等待最终结果投递"
        : view.phase === "countdown"
          ? "🟡 空闲确认中"
          : "🔄 正在重启";
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
    return sectionCard("Agent Bot 安全重启", elements, view.phase === "restarting" ? "blue" : "orange");
  }

  renderStartupStatus(view: StartupStatusView): Record<string, unknown> {
    const workspaceLine = view.workspaceKind === "projectless"
      ? "**任务范围**：未指定项目"
      : `**工作目录**：${inlineCode(view.cwd)}`;
    const lines = view.currentTask
      ? [
        `**当前任务**：${inlineCode(view.currentTask.title ?? view.currentTask.id)}`,
        workspaceLine,
        `**模型 / 思考强度 / 权限**：${inlineCode(view.currentTask.model ?? "默认")} / ${inlineCode(view.currentTask.reasoningEffort ?? "自动")} / ${inlineCode(permissionModeLabel(view.currentTask.permissionMode))}`,
        `**任务状态 / Agent**：${persistedTaskStatus(view.currentTask.sessionStatus, view.currentTask.lastTurnStatus)} / ${inlineCode(view.currentTask.agentName)}`,
        `**任务 ID**：${inlineCode(view.currentTask.id)}`,
      ]
      : [
        "**当前任务**：无，下一条普通消息会创建新任务",
        workspaceLine,
        `**模型 / 思考强度 / 权限**：${inlineCode("默认")} / ${inlineCode("自动")} / ${inlineCode(permissionModeLabel())}`,
        `**默认 Agent**：${view.defaultAgentTitle} (${inlineCode(view.defaultAgentName)})`,
      ];
    lines.push(
      `**服务状态 / 启动时间**：🟢 在线 / ${formatStartupTime(view.startedAt)}`,
      `**重启原因**：${inlineCode(view.restartReason)}`,
      "发送普通消息继续当前任务；发送 `/new` 创建新任务；发送 `/status` 查看详情。",
    );
    return sectionCard("Agent Bot 已启动", [markdown(lines.join("\n"))], "green");
  }

  renderTurn(state: TurnViewState): Record<string, unknown> {
    const elements = renderTurnElements(state, "hidden");
    if (isTurnStoppable(state.status)) {
      elements.push({ tag: "hr" }, taskActionRow([{
        text: "Stop",
        type: "danger",
        value: { action: "turn_cancel", sessionId: state.sessionId, turnId: state.turnId },
      }]));
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
      ? `Codex 执行详情：${truncateText(state.taskTitle.replace(/\s+/g, " ").trim(), 60)}`
      : "Codex 执行详情";
    return turnCard(title, "blue", renderTurnElements(state, "always"), renderTurnSubtitle(state));
  }

  renderActivityHistory(state: TurnViewState, requestedPage: number): Record<string, unknown> {
    const pages = activityPages(turnActivities(state));
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
    elements.push(...renderActivities(pages[page] ?? [], state.projectCwd, true));
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
            content: option.name,
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

  renderTaskListCard(
    title: string,
    sectionTitle: string,
    entries: TaskListCardEntry[],
    footerLines: string[],
    footerAction?: TaskListCardAction,
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
    if (footerLines.length > 0) {
      elements.push({ tag: "hr" }, markdown(footerLines.join("\n")));
    }
    if (footerAction) {
      elements.push({
        tag: "column_set",
        flex_mode: "none",
        columns: [{
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [{
            tag: "button",
            text: { tag: "plain_text", content: footerAction.text },
            type: footerAction.type ?? "default",
            width: "fill",
            behaviors: [{
              type: "callback",
              value: footerAction.value,
            }],
          }],
        }],
      });
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
          text: { tag: "plain_text", content: option.label },
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
  if (elements.length === 0) elements.push(markdown(emptyTurnText(state.status)));
  return elements;
}

function emptyTurnText(status: TurnViewStatus): string {
  if (status === "starting") return "正在连接 Codex…";
  if (status === "completed") return "本轮已完成。";
  if (status === "cancelled") return "本轮已停止。";
  return "正在等待 Codex 返回进度…";
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
      .map((file) => `- ${displayFilePath(file.path, state.projectCwd)}  +${file.additions ?? 0} -${file.deletions ?? 0}`)
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
  if (tool.kind === "image_view" && tool.imagePath) {
    elements.push(localCardImage(tool.imagePath, "view_image 图片"));
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
  options: { expanded?: boolean; borderColor?: string; elementId?: string } = {},
): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    ...(options.elementId ? { element_id: options.elementId } : {}),
    direction: "vertical",
    vertical_spacing: "4px",
    padding: "8px",
    margin: "0px",
    expanded: options.expanded ?? false,
    header: {
      title: { tag: "plain_text", content: title },
      vertical_align: "center",
      padding: "4px 8px 4px 8px",
    },
    border: {
      color: options.borderColor ?? "grey",
      corner_radius: "5px",
    },
    elements: typeof content === "string" ? [markdown(content)] : content,
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
  return compactPrompt ? `${currentStatus}：${compactPrompt}` : currentStatus;
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

function taskActionElement(action: TaskListCardAction): Record<string, unknown> {
  return {
    tag: "interactive_container",
    margin: "0px",
    padding: "0px",
    has_border: false,
    elements: [markdown(
      `<font color='${action.type === "danger" ? "red" : "blue"}'>${escapeCardHtml(action.text)}</font>`,
    )],
    behaviors: [{
      type: "callback",
      value: action.value,
    }],
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
      vertical_spacing: "8px",
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
