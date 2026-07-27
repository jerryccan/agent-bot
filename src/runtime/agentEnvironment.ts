export const AGENT_BOT_ENVIRONMENT = Object.freeze({
  AGENT_BOT: "1",
});

export function agentBotEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  agentEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...agentEnv,
    ...AGENT_BOT_ENVIRONMENT,
  };
}
