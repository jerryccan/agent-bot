import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentBotHome,
  defaultConfigPath,
  defaultDotEnvPath,
  resolveUserPath,
} from "../config/paths.js";

export type InitializationStatus = "created" | "existing";

export interface InitializedPath {
  path: string;
  status: InitializationStatus;
}

export interface InitializationResult {
  home: InitializedPath;
  config: InitializedPath;
  env: InitializedPath;
  data: InitializedPath;
  logs: InitializedPath;
}

export interface InitializationOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  configTemplatePath?: string;
  envTemplatePath?: string;
}

const DEFAULT_CONFIG_TEMPLATE = fileURLToPath(new URL("../../config.example.yaml", import.meta.url));
const DEFAULT_ENV_TEMPLATE = fileURLToPath(new URL("../../.env.example", import.meta.url));

export function initializeAgentBot(options: InitializationOptions = {}): InitializationResult {
  const env = options.env ?? process.env;
  const configTemplatePath = path.resolve(options.configTemplatePath ?? DEFAULT_CONFIG_TEMPLATE);
  const envTemplatePath = path.resolve(options.envTemplatePath ?? DEFAULT_ENV_TEMPLATE);
  assertTemplate(configTemplatePath);
  assertTemplate(envTemplatePath);

  const homePath = agentBotHome(env);
  const configuredPath = firstNonBlank(options.configPath, env.AGENT_BOT_CONFIG);
  const configPath = resolveUserPath(configuredPath ?? defaultConfigPath(env));
  const envPath = defaultDotEnvPath(env);
  const configDirectory = path.dirname(configPath);

  const home = ensureDirectory(homePath);
  fs.mkdirSync(configDirectory, { recursive: true });

  let config: InitializedPath;
  if (fs.existsSync(configPath)) {
    config = { path: configPath, status: "existing" };
  } else {
    fs.copyFileSync(configTemplatePath, configPath, fs.constants.COPYFILE_EXCL);
    config = { path: configPath, status: "created" };
  }

  const envFile = copyIfMissing(envTemplatePath, envPath);
  const data = ensureDirectory(path.join(configDirectory, "data"));
  const logs = ensureDirectory(path.join(configDirectory, "logs"));

  return { home, config, env: envFile, data, logs };
}

function assertTemplate(templatePath: string): void {
  if (!fs.statSync(templatePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Initialization template does not exist: ${templatePath}`);
  }
}

function ensureDirectory(directoryPath: string): InitializedPath {
  const status = fs.existsSync(directoryPath) ? "existing" : "created";
  fs.mkdirSync(directoryPath, { recursive: true });
  return { path: directoryPath, status };
}

function copyIfMissing(sourcePath: string, targetPath: string): InitializedPath {
  if (fs.existsSync(targetPath)) return { path: targetPath, status: "existing" };
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  return { path: targetPath, status: "created" };
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}
