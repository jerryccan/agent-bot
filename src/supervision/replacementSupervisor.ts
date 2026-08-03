export const RESTART_GROUP_CONTEXTS_ENV = "AGENT_BOT_RESTART_GROUP_CONTEXTS";

export function replacementSupervisorEnvironment(
  restartReason: string,
  environment: NodeJS.ProcessEnv = process.env,
  restartGroupContextKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...environment,
    AGENT_BOT_START_DELAY_MS: "250",
    AGENT_BOT_RESTART_REASON: restartReason,
  };
  const normalized = normalizedContextKeys(restartGroupContextKeys);
  if (normalized.length > 0) {
    result[RESTART_GROUP_CONTEXTS_ENV] = JSON.stringify(normalized);
  } else {
    delete result[RESTART_GROUP_CONTEXTS_ENV];
  }
  return result;
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
