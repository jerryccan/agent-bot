export function withConfiguredFeishuAppId(
  data: unknown,
  configuredFeishuAppId?: string,
): Record<string, unknown> {
  const value = data && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  if (Object.hasOwn(value, "feishuAppId")) return value;
  return {
    ...value,
    feishuAppId: configuredFeishuAppId ?? null,
  };
}

export function formatServerStatus(data: unknown): string {
  const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const activity = value.activity && typeof value.activity === "object"
    ? value.activity as Record<string, unknown>
    : {};
  const state = value.running === false
    ? "not running"
    : value.ready === false
      ? "starting (connecting to Lark)"
      : "running";
  const safeRestart = value.safeRestartScheduled
    ? `pending (${String(value.safeRestartReason ?? "no reason provided")})`
    : "not scheduled";
  return [
    `Agent Bot server: ${state}`,
    `Lark App ID: ${value.feishuAppId ?? "not configured"}`,
    `PID: ${value.pid ?? "-"}`,
    `Started at: ${value.startedAt ?? "-"}`,
    `Supervisor: ${value.supervised ? "enabled" : "disabled"}`,
    `Running tasks: ${activity.runningSessions ?? 0}`,
    `Pending final deliveries: ${activity.pendingFinalDeliveries ?? 0}`,
    `Safe restart: ${safeRestart}`,
    "",
  ].join("\n");
}
