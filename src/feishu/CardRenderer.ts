import type { JsonValue } from "../acp/acpTypes.js";
import type { RuntimeSession } from "../acp/AcpSessionManager.js";
import type { ToolState } from "../runtime/types.js";
import type { TurnViewState, TurnViewStatus } from "../presentation/turnViewTypes.js";
import { truncateText } from "../utils/markdown.js";

export class CardRenderer {
  renderTurn(state: TurnViewState): Record<string, unknown> {
    const elements: unknown[] = [
      markdown(renderTurnSummary(state)),
    ];

    if (state.plan.length > 0) {
      elements.push(markdown(`**计划**\n${state.plan.map(renderPlanStep).join("\n")}`));
    }
    if (state.progressText) {
      elements.push(markdown(`**当前进展**\n${truncateText(state.progressText, 2_000)}`));
    }
    if (state.activeTool) {
      elements.push(toolPanel("正在执行", [state.activeTool], true, "blue"));
    }
    if (state.failedTools.length > 0) {
      elements.push(toolPanel(`失败的工具（${state.failedTools.length}）`, state.failedTools, true, "red"));
    }
    if (state.completedTools.length > 0) {
      elements.push(toolPanel(`已完成的工具（${state.completedTools.length}）`, state.completedTools, false, "green"));
    }
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
        `**需要确认：${request.title}**`,
        request.command ? `\`${request.command.replaceAll("`", "'")}\`` : undefined,
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
      elements.push(markdown(`**错误**\n${truncateText(state.error, 2_000)}`));
    }

    if (!isTerminal(state.status)) {
      elements.push({
        tag: "action",
        actions: [{
          tag: "button",
          text: { tag: "plain_text", content: "停止" },
          type: "danger",
          value: { action: "turn_cancel", sessionId: state.sessionId, turnId: state.turnId },
        }],
      });
    }

    return this.baseCard(turnTitle(state.status), turnTemplate(state.status), elements);
  }

  renderTurnDetails(state: TurnViewState): Record<string, unknown> {
    const tools = [...state.completedTools, ...state.failedTools];
    return this.baseCard("Codex 执行详情", "blue", [
      markdown(renderTurnSummary(state)),
      ...(state.plan.length ? [markdown(`**计划**\n${state.plan.map(renderPlanStep).join("\n")}`)] : []),
      ...(tools.length ? [toolPanel(`工具调用（${tools.length}）`, tools, true, "blue")] : []),
      ...(state.assistantText ? [markdown(`**生成中的回复**\n${truncateText(state.assistantText, 3_000)}`)] : []),
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
  return `**状态**：${statusLabel(state.status)}\n**耗时**：${formatDuration(elapsed)}`;
}

function renderPlanStep(step: TurnViewState["plan"][number]): string {
  const marker = step.status === "completed" ? "✅" : step.status === "in_progress" ? "🔄" : "○";
  return `${marker} ${step.text}`;
}

function toolPanel(title: string, tools: ToolState[], expanded: boolean, template: string): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded,
    header: { title: { tag: "plain_text", content: title }, template, vertical_align: "center" },
    elements: tools.map((tool) => markdown(renderTool(tool))),
  };
}

function renderTool(tool: ToolState): string {
  const parts = [`**${tool.status === "failed" ? "❌" : tool.status === "running" ? "⏳" : "✅"} ${tool.title}**`];
  const command = tool.command ?? (tool.kind === "command" ? tool.title : undefined);
  if (command) parts.push(`**命令**\n${codeBlock(command, 800)}`);
  if (tool.exitCode !== undefined) parts.push(`**退出码**：${tool.exitCode}`);
  if (tool.error) parts.push(`**错误摘要**\n${codeBlock(tool.error, 1_200)}`);
  else if (tool.output) parts.push(`**结果摘要**\n${codeBlock(tool.output, 1_200)}`);
  return parts.join("\n");
}

function codeBlock(value: string, maxLength: number): string {
  return `\`\`\`\n${truncateText(value.trim(), maxLength).replaceAll("```", "''' ")}\n\`\`\``;
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

function statusLabel(status: TurnViewStatus): string {
  const labels: Record<TurnViewStatus, string> = {
    starting: "正在启动",
    running: "正在思考",
    tool_running: "正在执行工具",
    waiting_for_approval: "等待确认",
    completed: "已完成",
    cancelled: "已停止",
    failed: "失败",
  };
  return labels[status];
}

function isTerminal(status: TurnViewStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
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
