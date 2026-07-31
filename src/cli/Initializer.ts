import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";
import {
  agentBotHome,
  defaultConfigPath,
  defaultDotEnvPath,
  resolveUserPath,
} from "../config/paths.js";

export type InitializationStatus = "created" | "existing" | "reset";

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

  const config = copyIfMissing(configTemplatePath, configPath);
  const envFile = copyIfMissing(envTemplatePath, envPath);
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
      throw new Error("Lark credential verification failed after writing the environment file.");
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
        throw new Error(`Another agent-bot init process is running (lock file: ${lockPath}).`);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }

  throw new Error(`Could not acquire the initialization lock: ${lockPath}`);
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
  try {
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    return { path: targetPath, status: "created" };
  } catch (error) {
    if (isFileExistsError(error)) return { path: targetPath, status: "existing" };
    throw error;
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
    throw new Error("--reset only supports a profile-owned config.yaml and .env.");
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
    throw new Error(`${key} is not a valid single-line environment variable value.`);
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
