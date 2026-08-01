import path from "node:path";
import { cliText } from "./i18n.js";
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
    throw new Error(cliText(
      "--profile and --config cannot be used together. A profile always uses config.yaml in its directory.",
      "--profile 和 --config 不能同时使用。Profile 始终使用其目录中的 config.yaml。",
    ));
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
  if (indexes.length > 1) throw new Error(cliText(
    `${option} can only be specified once.`,
    `${option} 只能指定一次。`,
  ));
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(cliText(
    `${option} requires a directory or file path.`,
    `${option} 需要目录或文件路径。`,
  ));
  args.splice(index, 2);
  return value;
}
