import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";
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

export type FeishuCredentialStatus = "configured" | "missing" | "incomplete";

export interface FeishuCredentialState {
  status: FeishuCredentialStatus;
  appId?: string;
  appSecret?: string;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
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
  restrictFilePermissions(envFile.path);
  const data = ensureDirectory(path.join(configDirectory, "data"));
  const logs = ensureDirectory(path.join(configDirectory, "logs"));

  return { home, config, env: envFile, data, logs };
}

export function readFeishuCredentials(envPath: string, env: NodeJS.ProcessEnv = process.env): FeishuCredentialState {
  const fileValues = fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};
  const appId = firstNonBlank(env.FEISHU_APP_ID, fileValues.FEISHU_APP_ID);
  const appSecret = firstNonBlank(env.FEISHU_APP_SECRET, fileValues.FEISHU_APP_SECRET);
  if (appId && appSecret) return { status: "configured", appId, appSecret };
  if (appId || appSecret) return { status: "incomplete", appId, appSecret };
  return { status: "missing" };
}

export function writeFeishuCredentials(envPath: string, credentials: FeishuCredentials): void {
  assertDotEnvValue("FEISHU_APP_ID", credentials.appId);
  assertDotEnvValue("FEISHU_APP_SECRET", credentials.appSecret);
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  let updated = upsertDotEnvValue(original, "FEISHU_APP_ID", credentials.appId);
  updated = upsertDotEnvValue(updated, "FEISHU_APP_SECRET", credentials.appSecret);

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const temporaryPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, envPath);
    restrictFilePermissions(envPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
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

function upsertDotEnvValue(contents: string, key: string, value: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.length > 0 ? contents.split(/\r?\n/) : [];
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const index = lines.findIndex((line) => matcher.test(line));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    lines.push(`${key}=${value}`);
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return `${lines.join(newline)}${newline}`;
}

function assertDotEnvValue(key: string, value: string): void {
  if (!value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${key} 不是有效的单行环境变量值。`);
  }
}

function restrictFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}
