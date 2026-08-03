import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliText } from "./i18n.js";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";
import { isMap, isScalar, parseDocument, type YAMLMap } from "yaml";
import {
  agentBotHome,
  defaultConfigPath,
  defaultDotEnvPath,
  resolveUserPath,
} from "../config/paths.js";

export type InitializationStatus = "created" | "existing" | "updated" | "reset";

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
  reset?: {
    backupPath: string;
  };
}

export interface InitializationOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  configTemplatePath?: string;
  envTemplatePath?: string;
  reset?: boolean;
}

export interface ConfiguredAgentOption {
  name: string;
  title: string;
}

export interface ConfiguredAgentSelection {
  agents: ConfiguredAgentOption[];
  defaultAgent?: string;
}

export type FeishuCredentialStatus = "configured" | "missing" | "incomplete";

export interface FeishuCredentialState {
  status: FeishuCredentialStatus;
  appId?: string;
  appSecret?: string;
  userOpenId?: string;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  userOpenId?: string;
}

export interface InitializationLock {
  path: string;
  release(): void;
}

const DEFAULT_CONFIG_TEMPLATE = fileURLToPath(new URL("../../config.example.yaml", import.meta.url));
const DEFAULT_ENV_TEMPLATE = fileURLToPath(new URL("../../.env.example", import.meta.url));
const INITIALIZATION_LOCK_NAME = "init.lock";
const MAX_INITIALIZATION_LOCK_AGE_MS = 30 * 60_000;

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
  const reset = options.reset
    ? resetProfileContents(homePath, configPath, envPath, configDirectory)
    : undefined;

  const config = initializeConfig(configTemplatePath, configPath);
  const envFile = initializeEnv(envTemplatePath, envPath);
  restrictFilePermissions(envFile.path);
  const data = ensureDirectory(path.join(configDirectory, "data"));
  const logs = ensureDirectory(path.join(configDirectory, "logs"));

  return {
    home,
    config: withResetStatus(config, reset?.movedNames.has("config.yaml") ?? false),
    env: withResetStatus(envFile, reset?.movedNames.has(".env") ?? false),
    data: withResetStatus(data, reset?.movedNames.has("data") ?? false),
    logs: withResetStatus(logs, reset?.movedNames.has("logs") ?? false),
    ...(reset ? { reset: { backupPath: reset.backupPath } } : {}),
  };
}

export function readConfiguredAgentSelection(configPath: string): ConfiguredAgentSelection {
  const document = parseConfigurationDocument(fs.readFileSync(configPath, "utf8"), configPath);
  if (!isMap(document.contents)) {
    throw new Error(cliText(
      `Configuration file must contain a YAML mapping: ${configPath}`,
      `配置文件必须包含 YAML 映射：${configPath}`,
    ));
  }
  const configuredAgents = document.contents.get("agents", true);
  if (!isMap(configuredAgents)) {
    throw new Error(cliText(
      `Configuration file must contain an agents mapping: ${configPath}`,
      `配置文件必须包含 agents 映射：${configPath}`,
    ));
  }
  const agents = configuredAgents.items.flatMap((pair) => {
    const name = yamlMappingKey(pair.key);
    if (!name) return [];
    const titleNode = isMap(pair.value) ? pair.value.get("title", true) : undefined;
    const title = isScalar(titleNode) && typeof titleNode.value === "string"
      ? titleNode.value
      : name;
    return [{ name, title }];
  });
  const defaultAgent = document.getIn(["defaults", "agent"]);
  return {
    agents,
    ...(typeof defaultAgent === "string" && defaultAgent.trim() ? { defaultAgent } : {}),
  };
}

export function writeDefaultAgent(configPath: string, agentName: string): boolean {
  const original = fs.readFileSync(configPath, "utf8");
  const document = parseConfigurationDocument(original, configPath);
  if (!isMap(document.contents)) {
    throw new Error(cliText(
      `Configuration file must contain a YAML mapping: ${configPath}`,
      `配置文件必须包含 YAML 映射：${configPath}`,
    ));
  }
  const configuredAgents = document.contents.get("agents", true);
  if (!isMap(configuredAgents) || !configuredAgents.has(agentName)) {
    throw new Error(cliText(
      `Cannot select an Agent that is not configured: ${agentName}`,
      `不能选择尚未配置的 Agent：${agentName}`,
    ));
  }
  const defaults = document.contents.get("defaults", true);
  if (defaults !== undefined && !isMap(defaults)) {
    throw new Error(cliText(
      `Configuration defaults must contain a YAML mapping: ${configPath}`,
      `配置文件的 defaults 必须是 YAML 映射：${configPath}`,
    ));
  }
  const currentAgent = document.getIn(["defaults", "agent"]);
  if (currentAgent === agentName) return false;
  if (isMap(defaults)) defaults.set("agent", agentName);
  else document.setIn(["defaults"], { agent: agentName });
  writeFileAtomically(configPath, document.toString());
  return true;
}

export function readFeishuCredentials(envPath: string, env: NodeJS.ProcessEnv = process.env): FeishuCredentialState {
  const fileValues = fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};
  const appId = firstNonBlank(env.FEISHU_APP_ID, fileValues.FEISHU_APP_ID);
  const appSecret = firstNonBlank(env.FEISHU_APP_SECRET, fileValues.FEISHU_APP_SECRET);
  const userOpenId = firstNonBlank(env.FEISHU_USER_OPEN_ID, fileValues.FEISHU_USER_OPEN_ID);
  const user = userOpenId ? { userOpenId } : {};
  if (appId && appSecret) return { status: "configured", appId, appSecret, ...user };
  if (appId || appSecret) return { status: "incomplete", appId, appSecret, ...user };
  return { status: "missing", ...user };
}

export function writeFeishuCredentials(envPath: string, credentials: FeishuCredentials): void {
  assertDotEnvValue("FEISHU_APP_ID", credentials.appId);
  assertDotEnvValue("FEISHU_APP_SECRET", credentials.appSecret);
  if (credentials.userOpenId) assertDotEnvValue("FEISHU_USER_OPEN_ID", credentials.userOpenId);
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  let updated = upsertDotEnvValue(original, "FEISHU_APP_ID", credentials.appId);
  updated = upsertDotEnvValue(updated, "FEISHU_APP_SECRET", credentials.appSecret);
  updated = upsertDotEnvValue(updated, "FEISHU_USER_OPEN_ID", credentials.userOpenId ?? "");

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const temporaryPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  let temporaryFile: number | undefined;
  try {
    temporaryFile = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(temporaryFile, updated, "utf8");
    fs.fsyncSync(temporaryFile);
    fs.closeSync(temporaryFile);
    temporaryFile = undefined;
    fs.renameSync(temporaryPath, envPath);
    syncDirectory(path.dirname(envPath));
    restrictFilePermissions(envPath);
    const persisted = readFeishuCredentials(envPath, {});
    if (
      persisted.status !== "configured"
      || persisted.appId !== credentials.appId
      || persisted.appSecret !== credentials.appSecret
      || persisted.userOpenId !== credentials.userOpenId
    ) {
      throw new Error(cliText(
        "Lark credential verification failed after writing the environment file.",
        "写入环境文件后，飞书凭据校验失败。",
      ));
    }
  } finally {
    if (temporaryFile !== undefined) fs.closeSync(temporaryFile);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function shouldCreateFeishuApp(
  credentials: FeishuCredentialState,
  reconfigureFeishu: boolean,
): boolean {
  return reconfigureFeishu || credentials.status !== "configured";
}

export function acquireInitializationLock(lockDirectory: string): InitializationLock {
  fs.mkdirSync(lockDirectory, { recursive: true });
  const lockPath = path.join(lockDirectory, INITIALIZATION_LOCK_NAME);
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let lockFile: number | undefined;
    let created = false;
    try {
      lockFile = fs.openSync(lockPath, "wx", 0o600);
      created = true;
      fs.writeFileSync(lockFile, `${JSON.stringify(owner)}\n`, "utf8");
      fs.fsyncSync(lockFile);
      fs.closeSync(lockFile);
      lockFile = undefined;
      return {
        path: lockPath,
        release: () => {
          const current = readInitializationLock(lockPath);
          if (current?.token === owner.token) fs.rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (lockFile !== undefined) fs.closeSync(lockFile);
      if (created) fs.rmSync(lockPath, { force: true });
      if (!isFileExistsError(error)) throw error;
      if (!isStaleInitializationLock(lockPath)) {
        throw new Error(cliText(
          `Another agentbot init process is running (lock file: ${lockPath}).`,
          `另一个 agentbot init 进程正在运行（锁文件：${lockPath}）。`,
        ));
      }
      fs.rmSync(lockPath, { force: true });
    }
  }

  throw new Error(cliText(
    `Could not acquire the initialization lock: ${lockPath}`,
    `无法获取初始化锁：${lockPath}`,
  ));
}

export function cleanupFeishuCredentialTemporaryFiles(envPath: string): number {
  const directory = path.dirname(envPath);
  if (!fs.existsSync(directory)) return 0;
  const prefix = `${path.basename(envPath)}.`;
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
    const middle = entry.name.slice(prefix.length, -".tmp".length);
    if (!/^\d+\.\d+$/.test(middle)) continue;
    fs.rmSync(path.join(directory, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

function assertTemplate(templatePath: string): void {
  if (!fs.statSync(templatePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(cliText(
      `Initialization template does not exist: ${templatePath}`,
      `初始化模板不存在：${templatePath}`,
    ));
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
  try {
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    return { path: targetPath, status: "created" };
  } catch (error) {
    if (isFileExistsError(error)) return { path: targetPath, status: "existing" };
    throw error;
  }
}

function initializeConfig(templatePath: string, configPath: string): InitializedPath {
  if (!fs.existsSync(configPath)) {
    const copied = copyIfMissing(templatePath, configPath);
    if (copied.status === "created") return copied;
  }

  const original = fs.readFileSync(configPath, "utf8");
  const template = fs.readFileSync(templatePath, "utf8");
  const configDocument = parseConfigurationDocument(original, configPath);
  const templateDocument = parseConfigurationDocument(template, templatePath);
  if (!isMap(configDocument.contents) || !isMap(templateDocument.contents)) {
    throw new Error(cliText(
      `Configuration files must contain a YAML mapping: ${configPath}`,
      `配置文件必须包含 YAML 映射：${configPath}`,
    ));
  }

  const updated = mergeMissingConfiguration(
    configDocument.contents,
    templateDocument.contents,
    [],
  );
  if (!updated) return { path: configPath, status: "existing" };
  writeFileAtomically(configPath, configDocument.toString());
  return { path: configPath, status: "updated" };
}

function initializeEnv(templatePath: string, envPath: string): InitializedPath {
  if (!fs.existsSync(envPath)) {
    const copied = copyIfMissing(templatePath, envPath);
    if (copied.status === "created") return copied;
  }

  const original = fs.readFileSync(envPath, "utf8");
  const template = fs.readFileSync(templatePath, "utf8");
  const existingKeys = dotEnvKeys(original);
  const missingLines = template
    .split(/\r?\n/)
    .flatMap((line) => {
      const key = dotEnvAssignmentKey(line);
      if (!key || existingKeys.has(key)) return [];
      existingKeys.add(key);
      return [line];
    });
  if (missingLines.length === 0) return { path: envPath, status: "existing" };

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const separator = original.length === 0 || /\r?\n$/u.test(original) ? "" : newline;
  writeFileAtomically(envPath, `${original}${separator}${missingLines.join(newline)}${newline}`);
  return { path: envPath, status: "updated" };
}

function parseConfigurationDocument(contents: string, filePath: string) {
  const document = parseDocument(contents);
  if (document.errors.length === 0) return document;
  throw new Error(cliText(
    `Could not upgrade configuration file ${filePath}: ${document.errors[0]?.message ?? "invalid YAML"}`,
    `无法升级配置文件 ${filePath}：${document.errors[0]?.message ?? "YAML 无效"}`,
  ));
}

function mergeMissingConfiguration(
  config: YAMLMap,
  template: YAMLMap,
  parentPath: string[],
): boolean {
  let updated = false;
  for (const templatePair of template.items) {
    const key = yamlMappingKey(templatePair.key);
    if (!key) continue;
    if (!config.has(key)) {
      if (shouldPreserveMissingConfiguration(parentPath, key)) continue;
      const clonedPair = templatePair.clone();
      if (parentPath.length === 0 && key === "defaults" && isMap(clonedPair.value)) {
        clonedPair.value.delete("agent");
        if (clonedPair.value.items.length === 0) continue;
      }
      config.add(clonedPair);
      updated = true;
      continue;
    }

    const configValue = config.get(key, true);
    if (isMap(configValue) && isMap(templatePair.value)) {
      updated = mergeMissingConfiguration(configValue, templatePair.value, [...parentPath, key]) || updated;
    }
  }
  return updated;
}

function shouldPreserveMissingConfiguration(parentPath: string[], key: string): boolean {
  if (parentPath.length === 1 && parentPath[0] === "agents") return true;
  return parentPath.length === 1 && parentPath[0] === "defaults" && key === "agent";
}

function yamlMappingKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isScalar(value) && typeof value.value === "string" ? value.value : undefined;
}

function dotEnvKeys(contents: string): Set<string> {
  return new Set(contents.split(/\r?\n/).flatMap((line) => {
    const key = dotEnvAssignmentKey(line);
    return key ? [key] : [];
  }));
}

function dotEnvAssignmentKey(line: string): string | undefined {
  return /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1];
}

function writeFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let temporaryFile: number | undefined;
  try {
    temporaryFile = fs.openSync(temporaryPath, "wx", fs.statSync(filePath).mode);
    fs.writeFileSync(temporaryFile, contents, "utf8");
    fs.fsyncSync(temporaryFile);
    fs.closeSync(temporaryFile);
    temporaryFile = undefined;
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (temporaryFile !== undefined) fs.closeSync(temporaryFile);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function resetProfileContents(
  homePath: string,
  configPath: string,
  envPath: string,
  configDirectory: string,
): { backupPath: string; movedNames: Set<string> } | undefined {
  const resolvedHome = path.resolve(homePath);
  if (
    path.resolve(configDirectory) !== resolvedHome
    || path.dirname(path.resolve(configPath)) !== resolvedHome
    || path.dirname(path.resolve(envPath)) !== resolvedHome
  ) {
    throw new Error(cliText(
      "--reset only supports a profile-owned config.yaml and .env.",
      "--reset 仅支持由 Profile 管理的 config.yaml 和 .env。",
    ));
  }
  const targets = [
    { name: "config.yaml", sourcePath: configPath },
    { name: ".env", sourcePath: envPath },
    { name: "data", sourcePath: path.join(configDirectory, "data") },
    { name: "logs", sourcePath: path.join(configDirectory, "logs") },
  ].filter((target) => fs.existsSync(target.sourcePath));
  if (targets.length === 0) return undefined;

  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = path.join(homePath, ".reset-backups", `${timestamp}-${randomUUID()}`);
  fs.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  const moved: Array<{ sourcePath: string; backupPath: string }> = [];
  try {
    for (const target of targets) {
      const targetBackupPath = path.join(backupPath, target.name);
      fs.renameSync(target.sourcePath, targetBackupPath);
      moved.push({ sourcePath: target.sourcePath, backupPath: targetBackupPath });
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      if (!fs.existsSync(entry.sourcePath) && fs.existsSync(entry.backupPath)) {
        fs.renameSync(entry.backupPath, entry.sourcePath);
      }
    }
    try {
      fs.rmdirSync(backupPath);
      fs.rmdirSync(path.dirname(backupPath));
    } catch {
      // Keep a non-empty backup directory when rollback itself cannot fully restore it.
    }
    throw error;
  }
  return {
    backupPath,
    movedNames: new Set(targets.map((target) => target.name)),
  };
}

function withResetStatus(value: InitializedPath, reset: boolean): InitializedPath {
  return reset ? { ...value, status: "reset" } : value;
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
    throw new Error(cliText(
      `${key} is not a valid single-line environment variable value.`,
      `${key} 不是有效的单行环境变量值。`,
    ));
  }
}

function restrictFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function syncDirectory(directoryPath: string): void {
  let directory: number | undefined;
  try {
    directory = fs.openSync(directoryPath, "r");
    fs.fsyncSync(directory);
  } catch {
    // Directory fsync is not supported on every Windows or mounted filesystem.
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

interface InitializationLockOwner {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

function readInitializationLock(lockPath: string): InitializationLockOwner | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.token !== "string"
      || typeof value.pid !== "number"
      || typeof value.hostname !== "string"
      || typeof value.startedAt !== "string"
    ) {
      return undefined;
    }
    return {
      token: value.token,
      pid: value.pid,
      hostname: value.hostname,
      startedAt: value.startedAt,
    };
  } catch {
    return undefined;
  }
}

function isStaleInitializationLock(lockPath: string): boolean {
  const owner = readInitializationLock(lockPath);
  const modifiedAt = fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
  const ageMs = Date.now() - modifiedAt;
  if (!owner) return ageMs >= 5_000;
  if (owner.hostname === os.hostname()) return !isProcessRunning(owner.pid);
  const startedAt = Date.parse(owner.startedAt);
  const ownerAgeMs = Number.isFinite(startedAt) ? Date.now() - startedAt : ageMs;
  return ownerAgeMs >= MAX_INITIALIZATION_LOCK_AGE_MS;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}
