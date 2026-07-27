import os from "node:os";
import path from "node:path";

export const AGENT_BOT_HOME_ENV = "AGENT_BOT_HOME";
export const DEFAULT_CONFIG_FILE = "config.yaml";
export const DEFAULT_ENV_FILE = ".env";
export const DEFAULT_SQLITE_PATH = "./data/agent-bot.sqlite";
export const DEFAULT_LOG_PATH = "./logs/agent-bot.log";

export function agentBotHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(expandHome(env[AGENT_BOT_HOME_ENV] ?? path.join(os.homedir(), ".agent-bot")));
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentBotHome(env), DEFAULT_CONFIG_FILE);
}

export function defaultDotEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentBotHome(env), DEFAULT_ENV_FILE);
}

export function defaultSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentBotHome(env), "data", "agent-bot.sqlite");
}

export function resolveUserPath(input: string, baseDirectory = process.cwd()): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDirectory, expanded);
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}
