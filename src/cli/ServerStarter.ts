import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/loadConfig.js";
import type { AppConfig } from "../config/schema.js";
import { requireServerFeishuTransport } from "../feishu/transport.js";
import { controlEndpoint } from "./controlProtocol.js";
import { isServerReachable, isServerRunning } from "./LocalControlClient.js";

export interface ServerStartResult {
  status: "started" | "already-running";
}

export type InitializationServerResult =
  | ServerStartResult
  | { status: "skipped"; reason: "feishu-skipped" };

export interface ServerStarterDependencies {
  isRunning(endpoint: string): Promise<boolean>;
  isReachable(endpoint: string): Promise<boolean>;
  waitUntilRunning(endpoint: string, timeoutMs: number): Promise<boolean>;
  spawnSupervisor(): void;
}

const SERVER_START_TIMEOUT_MS = 45_000;

interface InitializationServerDependencies {
  loadConfig(configPath?: string): AppConfig;
  startServer(config: AppConfig): Promise<ServerStartResult>;
}

export async function startInitializedServer(
  options: { skipFeishu: boolean; configPath?: string },
  dependencies: InitializationServerDependencies = defaultInitializationDependencies,
): Promise<InitializationServerResult> {
  if (options.skipFeishu) {
    return { status: "skipped", reason: "feishu-skipped" };
  }
  return dependencies.startServer(dependencies.loadConfig(options.configPath));
}

export async function startServer(
  config: AppConfig,
  dependencies: ServerStarterDependencies = defaultDependencies,
): Promise<ServerStartResult> {
  requireServerFeishuTransport(config.feishu);
  const endpoint = controlEndpoint(config.storage.sqlitePath);

  if (await dependencies.isRunning(endpoint)) {
    return { status: "already-running" };
  }
  if (await dependencies.isReachable(endpoint)) {
    const running = await dependencies.waitUntilRunning(endpoint, SERVER_START_TIMEOUT_MS);
    if (!running) {
      throw new Error("agent-bot server 已启动，但未能连接飞书机器人。请检查日志。");
    }
    return { status: "started" };
  }

  dependencies.spawnSupervisor();
  const running = await dependencies.waitUntilRunning(endpoint, SERVER_START_TIMEOUT_MS);
  if (!running) {
    throw new Error("已启动 Supervisor，但 server 未在 45 秒内连接飞书机器人。请检查日志。");
  }
  return { status: "started" };
}

const defaultDependencies: ServerStarterDependencies = {
  isRunning: isServerRunning,
  isReachable: isServerReachable,
  waitUntilRunning: waitForServer,
  spawnSupervisor: () => {
    const entry = fileURLToPath(new URL("../supervisor.js", import.meta.url));
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, AGENT_BOT_RESTART_REASON: "通过 agent-bot CLI 启动" },
    });
    child.unref();
  },
};

const defaultInitializationDependencies: InitializationServerDependencies = {
  loadConfig,
  startServer: (config) => startServer(config),
};

async function waitForServer(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerRunning(endpoint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
