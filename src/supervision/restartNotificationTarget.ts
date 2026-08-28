import type { RestartNotificationTarget } from "./SafeRestartScheduler.js";

export function privateRestartNotificationTarget(userOpenId: string | undefined): RestartNotificationTarget {
  const normalizedUserOpenId = userOpenId?.trim();
  if (!normalizedUserOpenId) {
    throw new Error(
      "Cannot send CLI restart notifications to private chat because feishu.userOpenId is not configured. "
      + "Run agentbot init or pass --task <task>.",
    );
  }
  return { contextKey: `open_id:${normalizedUserOpenId}` };
}
