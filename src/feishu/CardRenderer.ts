import type { JsonValue } from "../acp/acpTypes.js";
import type { RuntimeSession } from "../acp/AcpSessionManager.js";
import type { ToolState } from "../runtime/types.js";
import type { TurnActivity, TurnViewState, TurnViewStatus } from "../presentation/turnViewTypes.js";
import { truncateMiddle, truncateText } from "../utils/markdown.js";

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
    return this.baseCard("acp-bot 已启动", "green", [markdown(lines.join("\n"))]);
  }

  renderTurn(state: TurnViewState): Record<string, unknown> {
    const elements: unknown[] = [
      markdown(renderTurnSummary(state)),
    ];

    if (state.plan.length > 0) {
      elements.push(markdown(state.plan.map(renderPlanStep).join("\n")));
    }
    elements.push(...turnActivities(state).flatMap(renderActivity));
    if (state.fileSummary.length > 0) {
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        header: { title: { tag: "plain_text", content: `文件变更（${state.fileSummary.length}）` }, vertical_align: "center" },
        elements: [markdown(state.fileSummary.map((file) => `- ${file.path}  +${file.additions ?? 0} -${file.deletions ?? 0}`).join("\n"))],
      });
    }
    if (state.approval) {
      const request = state.approval;
      elements.push(markdown([
        request.title,
        request.command ? codeBlock(request.command, 800) : undefined,
        request.reason,
      ].filter(Boolean).join("\n")));
      elements.push({
        tag: "action",
        actions: request.options.map((option) => ({
          tag: "button",
          text: { tag: "plain_text", content: option.label },
          type: option.id === "accept" || option.id === "acceptForSession" ? "primary" : option.id === "cancel" ? "danger" : "default",
          value: {
            action: "approval",
            sessionId: state.sessionId,
            turnId: state.turnId,
            requestId: request.id,
            decision: option.id,
          },
        })),
      });
    }
    if (state.error) {
      elements.push(markdown(codeBlock(state.error, 2_000)));
    }

    return this.baseCard(turnTitle(state.status), turnTemplate(state.status), elements);
  }

  renderTurnDetails(state: TurnViewState): Record<string, unknown> {
    return this.baseCard("Codex 执行详情", "blue", [
      markdown(renderTurnSummary(state)),
      ...(state.plan.length ? [markdown(state.plan.map(renderPlanStep).join("\n"))] : []),
      ...turnActivities(state).flatMap(renderActivity),
      ...(state.assistantText ? [markdown(truncateText(state.assistantText, 3_000))] : []),
    ]);
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

function renderTurnSummary(state: TurnViewState): string {
  const elapsed = state.durationMs ?? Math.max(0, Date.now() - state.startedAt);
  return `耗时：${formatDuration(elapsed)}`;
}

function renderPlanStep(step: TurnViewState["plan"][number]): string {
  const marker = step.status === "completed" ? "✅" : step.status === "in_progress" ? "🔄" : "○";
  return `${marker} ${step.text}`;
}

function renderActivity(activity: TurnActivity): Record<string, unknown>[] {
  if (activity.kind === "reasoning") {
    const text = activity.text.trim();
    return text ? [markdown(truncateText(text, 2_000))] : [];
  }
  return [toolPanel(activity.tool)];
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

function toolPanel(tool: ToolState): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "plain_text", content: toolPanelTitle(tool) },
      template: toolTemplate(tool),
      vertical_align: "center",
    },
    elements: [markdown(renderToolDetails(tool))],
  };
}

function renderToolDetails(tool: ToolState): string {
  const command = tool.command ?? tool.title;
  const fileSummary = tool.files?.length
    ? tool.files.map((file) => `${file.path}  +${file.additions ?? 0} -${file.deletions ?? 0}`).join("\n")
    : undefined;
  const result = tool.error ?? tool.output ?? fileSummary;
  const commandText = truncateText(stripAnsi(command).trim(), 800);
  const resultText = result ? truncateMiddle(stripAnsi(result).trim(), 1_200) : undefined;
  return codeBlock([`$ ${commandText}`, resultText].filter((part): part is string => part !== undefined).join("\n"), 2_003);
}

function toolPanelTitle(tool: ToolState): string {
  const icon = tool.status === "failed" ? "❌" : tool.status === "running" ? "⏳" : "✅";
  const title = truncateText(tool.title.replace(/\s+/g, " ").trim(), 100);
  return `${icon} ${title}`;
}

function toolTemplate(tool: ToolState): string {
  if (tool.status === "failed") return "red";
  if (tool.status === "running") return "blue";
  return "green";
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

function turnTitle(status: TurnViewStatus): string {
  if (status === "completed") return "Codex 已完成";
  if (status === "failed") return "Codex 执行失败";
  if (status === "cancelled") return "Codex 已停止";
  if (status === "waiting_for_approval") return "Codex 等待确认";
  return "Codex 正在处理";
}

function turnTemplate(status: TurnViewStatus): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "cancelled") return "grey";
  if (status === "waiting_for_approval") return "orange";
  return "blue";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 100) / 10;
  return `${seconds}s`;
}

function markdown(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
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
