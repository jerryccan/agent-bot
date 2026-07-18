import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonValue } from "../acp/acpTypes.js";
import type { RuntimeSession } from "../acp/AcpSessionManager.js";
import type { ToolState } from "../runtime/types.js";
import type { TurnActivity, TurnViewState, TurnViewStatus } from "../presentation/turnViewTypes.js";
import { truncateMiddle, truncateText } from "../utils/markdown.js";
import { localCardImage } from "./LocalCardImage.js";

export interface StartupStatusView {
  startedAt: Date;
  defaultAgentName: string;
  defaultAgentTitle: string;
  cwd: string;
  workspaceKind?: "project" | "projectless";
  currentTask?: {
    id: string;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    agentName: string;
    sessionStatus: string;
    lastTurnStatus?: string;
  };
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
  renderStartupStatus(view: StartupStatusView): Record<string, unknown> {
    const lines = [
      "**状态**：🟢 在线",
      `**启动时间**：${formatStartupTime(view.startedAt)}`,
      `**默认 Agent**：${view.defaultAgentTitle} (${inlineCode(view.defaultAgentName)})`,
      view.workspaceKind === "projectless"
        ? "**任务范围**：未指定项目"
        : `**工作目录**：${inlineCode(view.cwd)}`,
      `**当前模型**：${inlineCode(view.currentTask?.model ?? "默认")}`,
      `**思考强度**：${inlineCode(view.currentTask?.reasoningEffort ?? "自动")}`,
    ];
    if (view.currentTask) {
      lines.push(
        `**当前任务**：${inlineCode(view.currentTask.title ?? view.currentTask.id)}`,
        `**任务 ID**：${inlineCode(view.currentTask.id)}`,
        `**任务 Agent**：${inlineCode(view.currentTask.agentName)}`,
        `**任务状态**：${persistedTaskStatus(view.currentTask.sessionStatus, view.currentTask.lastTurnStatus)}`,
      );
    } else {
      lines.push("**当前任务**：无，下一条普通消息会创建新任务");
    }
    lines.push("发送普通消息继续当前任务；发送 `/new` 创建新任务；发送 `/status` 查看详情。");
    return sectionCard("acp-bot 已启动", [markdown(lines.join("\n"))], "green");
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
      turnTitle(state.status, state.taskTitle),
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
    return this.baseCard("ACP Gateway 状态", "blue", [markdown(status)]);
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
  return [
    `耗时 ${formatCompactDuration(elapsed)}`,
    state.totalTokens !== undefined ? `${formatTokenCount(state.totalTokens)} tokens` : undefined,
    activityTools > 0 ? `${activityTools} 个工具` : undefined,
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
  if (state.plan.length > 0) elements.push(planPanel(state.plan));
  if (state.activitiesTruncated) elements.push(markdown("…"));
  elements.push(...turnActivities(state).flatMap((activity) => renderActivity(activity, state.projectCwd)));
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

function renderActivity(activity: TurnActivity, projectCwd?: string): Record<string, unknown>[] {
  if (activity.kind === "reasoning") {
    const text = activity.text.trim();
    if (!text) return [];
    const content = truncateText(text, 2_000);
    if (activity.id.startsWith("commentary:")) return [markdown(content)];
    const plainReasoning = removeMarkdownBold(content);
    return [markdown(`> 💭 ${plainReasoning.replaceAll("\n", "\n> ")}`)];
  }
  return [toolPanel(activity.tool, projectCwd)];
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
  const commandText = truncateText(stripAnsi(command).trim(), 800);
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
  const meaningfulCommand = unwrapPowerShellCommand(command) ?? tool.title;
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

function turnTitle(status: TurnViewStatus, taskTitle?: string): string {
  const prefix = status === "completed"
    ? "Codex 已完成"
    : status === "failed"
      ? "Codex 执行失败"
      : status === "cancelled"
        ? "Codex 已停止"
        : status === "waiting_for_approval"
          ? "Codex 等待确认"
          : "Codex 正在处理";
  const compactTitle = taskTitle ? truncateText(taskTitle.replace(/\s+/g, " ").trim(), 60) : "";
  return compactTitle ? `${prefix}：${compactTitle}` : prefix;
}

function turnTemplate(status: TurnViewStatus): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "cancelled") return "grey";
  if (status === "waiting_for_approval") return "orange";
  return "blue";
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Math.max(0, Math.round(tokens)));
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
      elements: [{
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
      }],
    })),
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
