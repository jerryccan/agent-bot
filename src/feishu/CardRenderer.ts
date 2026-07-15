import type { JsonValue } from "../acp/acpTypes.js";
import type { RuntimeSession } from "../acp/AcpSessionManager.js";
import { truncateText } from "../utils/markdown.js";

export class CardRenderer {
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
