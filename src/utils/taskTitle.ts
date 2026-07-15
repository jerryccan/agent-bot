const MAX_TASK_TITLE_LENGTH = 120;

export function normalizeTaskTitle(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= MAX_TASK_TITLE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TASK_TITLE_LENGTH - 3)}...`;
}
