import type { RestartNotificationTarget } from "./SafeRestartScheduler.js";

export const RESTART_GROUP_CONTEXTS_ENV = "AGENT_BOT_RESTART_GROUP_CONTEXTS";
export const RESTART_NOTIFICATION_TARGETS_ENV = "AGENT_BOT_RESTART_NOTIFICATION_TARGETS";

export function replacementSupervisorEnvironment(
  restartReason: string,
  environment: NodeJS.ProcessEnv = process.env,
  restartNotificationTargets: readonly RestartNotificationTarget[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...environment,
    AGENT_BOT_START_DELAY_MS: "250",
    AGENT_BOT_RESTART_REASON: restartReason,
  };
  const normalized = normalizedNotificationTargets(restartNotificationTargets);
  if (normalized.length > 0) {
    result[RESTART_NOTIFICATION_TARGETS_ENV] = JSON.stringify(normalized);
  } else {
    delete result[RESTART_NOTIFICATION_TARGETS_ENV];
  }
  delete result[RESTART_GROUP_CONTEXTS_ENV];
  return result;
}

export function restartNotificationTargetsFromEnvironment(
  value: string | undefined,
): RestartNotificationTarget[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizedNotificationTargets(parsed.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const contextKey = typeof entry.contextKey === "string" ? entry.contextKey : "";
          const replyMessageId = typeof entry.replyMessageId === "string" ? entry.replyMessageId : undefined;
          return [{ contextKey, ...(replyMessageId ? { replyMessageId } : {}) }];
        }))
      : [];
  } catch {
    return [];
  }
}

export function restartGroupContextKeysFromEnvironment(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizedContextKeys(parsed.filter((entry): entry is string => typeof entry === "string"))
      : [];
  } catch {
    return [];
  }
}

function normalizedContextKeys(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedNotificationTargets(
  values: readonly RestartNotificationTarget[],
): RestartNotificationTarget[] {
  const targets = new Map<string, RestartNotificationTarget>();
  for (const value of values) {
    const contextKey = value.contextKey.trim();
    if (!contextKey) continue;
    const replyMessageId = value.replyMessageId?.trim();
    const existing = targets.get(contextKey);
    targets.set(contextKey, {
      contextKey,
      ...(existing?.replyMessageId || replyMessageId
        ? { replyMessageId: existing?.replyMessageId ?? replyMessageId }
        : {}),
    });
  }
  return [...targets.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
