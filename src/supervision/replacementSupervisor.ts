export function replacementSupervisorEnvironment(
  restartReason: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    AGENT_BOT_START_DELAY_MS: "250",
    AGENT_BOT_RESTART_REASON: restartReason,
  };
}
