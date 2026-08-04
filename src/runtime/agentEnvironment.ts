export const AGENT_BOT_ENVIRONMENT = Object.freeze({
  AGENT_BOT: "1",
});

export interface AgentEnvironmentContext {
  profilePath?: string;
  configPath?: string;
  agentName?: string;
  larkAppId?: string;
  larkBotOpenId?: string;
  larkUserOpenId?: string;
}

const RESERVED_ENVIRONMENT_PREFIXES = ["AGENT_BOT_", "FEISHU_"];

export function agentBotEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  agentEnv: Record<string, string>,
  context: AgentEnvironmentContext = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...withoutReservedEnvironment(baseEnv),
    ...withoutReservedEnvironment(agentEnv),
    ...AGENT_BOT_ENVIRONMENT,
  };
  setNonBlank(environment, "AGENT_BOT_HOME", context.profilePath);
  setNonBlank(environment, "AGENT_BOT_CONFIG", context.configPath);
  setNonBlank(environment, "AGENT_BOT_AGENT_NAME", context.agentName);
  setNonBlank(environment, "AGENT_BOT_LARK_APP_ID", context.larkAppId);
  setNonBlank(environment, "AGENT_BOT_LARK_BOT_OPEN_ID", context.larkBotOpenId);
  setNonBlank(environment, "AGENT_BOT_LARK_USER_OPEN_ID", context.larkUserOpenId);
  return environment;
}

function withoutReservedEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) =>
      value !== undefined && !isReservedEnvironmentName(name)),
  );
}

function isReservedEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized === "AGENT_BOT"
    || RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function setNonBlank(environment: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (value?.trim()) environment[name] = value;
}
