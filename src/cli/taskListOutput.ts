import type { SessionRecord } from "../state/StateStore.js";
import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";

export type CurrentTaskResolution =
  | { status: "found"; session: SessionRecord }
  | { status: "missing-thread-id" }
  | { status: "not-found"; threadIds: string[] }
  | { status: "ambiguous"; sessions: SessionRecord[]; threadIds: string[] };

export function formatTaskList(
  sessions: SessionRecord[],
  language: CliLanguage = cliLanguage,
  currentThreadIds: readonly string[] = [],
): string {
  if (sessions.length === 0) return cliText("No tasks.\n", "没有任务。\n", language);

  const current = resolveCurrentTask(sessions, currentThreadIds);
  const currentLocalSessionId = current.status === "found" ? current.session.localSessionId : undefined;
  return sessions.map((session, index) => {
    const title = session.title ?? cliText("Untitled task", "未命名任务", language);
    const current = session.localSessionId === currentLocalSessionId
      ? ` [${cliText("Current", "当前任务", language)}]`
      : "";
    const nativeId = nativeTaskIdLabel(session, language);
    return [
      `${index + 1}.${current} [${taskStateLabel(session.status, language)}/${taskStateLabel(session.lastTurnStatus, language)}] ${title}`,
      `   ${cliText("Agent: ", "Agent：", language)}${session.agentName} · ${cliText("AgentBot task ID: ", "AgentBot 任务 ID：", language)}${session.localSessionId}`,
      `   ${nativeId ? `${nativeId} · ` : ""}${session.contextKey} · ${session.updatedAt}`,
    ].join("\n");
  }).join("\n") + "\n";
}

export function currentAppServerThreadIds(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([
    env.CODEX_THREAD_ID?.trim(),
    env.TRAECLI_THREAD_ID?.trim(),
  ].filter((value): value is string => Boolean(value)))];
}

export function taskCurrentExternalInvocationMessage(
  language: CliLanguage = cliLanguage,
): string {
  return cliText(
    "agentbot task current is designed for an Agent running inside Agent Bot. A regular terminal has no current Agent task. Use agentbot task list to find a task, then run agentbot task status <task>.",
    "agentbot task current 是为 Agent Bot 中运行的 Agent 调用设计的。普通终端没有可自动识别的当前 Agent 任务；请先使用 agentbot task list 查找任务，再运行 agentbot task status <任务>。",
    language,
  );
}

export function resolveCurrentTask(
  sessions: SessionRecord[],
  currentThreadIds: readonly string[],
): CurrentTaskResolution {
  const threadIds = [...new Set(currentThreadIds.map((value) => value.trim()).filter(Boolean))];
  if (threadIds.length === 0) return { status: "missing-thread-id" };

  const candidates = new Set(threadIds);
  const matches = sessions.filter((session) => session.remoteSessionId && candidates.has(session.remoteSessionId));
  if (matches.length === 0) return { status: "not-found", threadIds };
  if (matches.length === 1) return { status: "found", session: matches[0]! };

  const running = matches.filter((session) =>
    session.status === "running" || session.lastTurnStatus === "running");
  if (running.length === 1) return { status: "found", session: running[0]! };
  return { status: "ambiguous", sessions: matches, threadIds };
}

export function taskStateLabel(
  status: string | undefined,
  language: CliLanguage = cliLanguage,
): string {
  if (!status) return "-";
  const chinese: Record<string, string> = {
    starting: "启动中",
    ready: "就绪",
    running: "运行中",
    closed: "已关闭",
    failed: "失败",
    completed: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
    inProgress: "进行中",
    active: "活动中",
    idle: "空闲",
    not_loaded: "未加载",
    error: "错误",
  };
  return language === "zh" ? chinese[status] ?? status : status;
}

function nativeTaskIdLabel(session: SessionRecord, language: CliLanguage): string | undefined {
  if (session.runtimeKind === "acp" || session.acpSessionId) {
    const sessionId = session.acpSessionId ?? session.remoteSessionId;
    return sessionId
      ? `${cliText("ACP session ID: ", "ACP Session ID：", language)}${sessionId}`
      : undefined;
  }
  return session.remoteSessionId
    ? `${cliText("App Server thread ID: ", "App Server 原生任务 ID（Thread ID）：", language)}${session.remoteSessionId}`
    : undefined;
}
