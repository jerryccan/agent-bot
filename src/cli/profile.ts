import path from "node:path";
import {
  AGENT_BOT_EXPLICIT_PROFILE_ENV,
  AGENT_BOT_HOME_ENV,
  DEFAULT_CONFIG_FILE,
  resolveUserPath,
} from "../config/paths.js";

export interface ParsedGlobalOptions {
  args: string[];
  configPath?: string;
  profilePath?: string;
}

export interface AppliedProfile {
  homePath: string;
  configPath: string;
}

export function parseGlobalOptions(input: string[]): ParsedGlobalOptions {
  const args = [...input];
  const configPath = removeOption(args, "--config");
  const profilePath = removeOption(args, "--profile");
  if (configPath && profilePath) {
    throw new Error("--profile and --config cannot be used together. A profile always uses config.yaml in its directory.");
  }
  return {
    args,
    ...(configPath ? { configPath } : {}),
    ...(profilePath ? { profilePath } : {}),
  };
}

export function applyExplicitProfile(
  profilePath: string,
  env: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
): AppliedProfile {
  const homePath = resolveUserPath(profilePath, baseDirectory);
  const configPath = path.join(homePath, DEFAULT_CONFIG_FILE);
  env[AGENT_BOT_HOME_ENV] = homePath;
  env.AGENT_BOT_CONFIG = configPath;
  env[AGENT_BOT_EXPLICIT_PROFILE_ENV] = "1";
  delete env.FEISHU_APP_ID;
  delete env.FEISHU_APP_SECRET;
  delete env.FEISHU_USER_OPEN_ID;
  return { homePath, configPath };
}

function removeOption(args: string[], option: string): string | undefined {
  const indexes = args.flatMap((value, index) => value === option ? [index] : []);
  if (indexes.length > 1) throw new Error(`${option} can only be specified once.`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a directory or file path.`);
  args.splice(index, 2);
  return value;
}
