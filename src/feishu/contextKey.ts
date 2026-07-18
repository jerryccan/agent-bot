const THREAD_CONTEXT_MARKER = ":thread_id:";

export function threadContextKey(chatId: string, threadId: string): string {
  return `chat_id:${chatId}${THREAD_CONTEXT_MARKER}${threadId}`;
}

export function isThreadContextKey(contextKey: string): boolean {
  return contextKey.startsWith("chat_id:") && contextKey.includes(THREAD_CONTEXT_MARKER);
}

export function baseChatContextKey(contextKey: string): string {
  const markerIndex = contextKey.indexOf(THREAD_CONTEXT_MARKER);
  return markerIndex < 0 ? contextKey : contextKey.slice(0, markerIndex);
}
