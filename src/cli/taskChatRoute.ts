import { baseChatContextKey, isThreadContextKey } from "../feishu/contextKey.js";
import type { SessionRecord } from "../state/StateStore.js";
import { cliText } from "./i18n.js";

const CHAT_CONTEXT_PREFIX = "chat_id:";
const THREAD_CONTEXT_MARKER = ":thread_id:";

export interface TaskChatRoute {
  taskId: string;
  chatId: string;
  contextKey: string;
  threadId?: string;
}

export function taskChatRoute(session: SessionRecord): TaskChatRoute {
  const contextKey = session.contextKey;
  const baseContextKey = baseChatContextKey(contextKey);
  if (!baseContextKey.startsWith(CHAT_CONTEXT_PREFIX)) {
    throw new Error(cliText(
      `The task is not bound to a Lark chat: ${session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId}`,
      `任务未绑定飞书会话：${session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId}`,
    ));
  }
  const chatId = baseContextKey.slice(CHAT_CONTEXT_PREFIX.length);
  if (!chatId) throw new Error(cliText(
    `The task has an invalid Lark chat ID: ${contextKey}`,
    `任务的飞书会话 ID 无效：${contextKey}`,
  ));
  const threadId = isThreadContextKey(contextKey)
    ? contextKey.slice(contextKey.indexOf(THREAD_CONTEXT_MARKER) + THREAD_CONTEXT_MARKER.length)
    : undefined;
  return {
    taskId: session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId,
    chatId,
    contextKey,
    ...(threadId ? { threadId } : {}),
  };
}
