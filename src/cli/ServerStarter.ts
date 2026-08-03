import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/loadConfig.js";
import type { AppConfig } from "../config/schema.js";
import { requireServerFeishuTransport } from "../feishu/transport.js";
import {
  nodeDiagnosticReportArguments,
  prepareCrashReportDirectory,
  resolveSupervisorDiagnosticsPaths,
} from "../supervision/SupervisorDiagnostics.js";
import { refreshedSystemEnvironment } from "../supervision/systemEnvironment.js";
import { controlEndpoint } from "./controlProtocol.js";
import { cliText } from "./i18n.js";
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
  spawnSupervisor(config: AppConfig): void;
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
  try {
    requireServerFeishuTransport(config.feishu);
  } catch (error) {
    if (error instanceof Error && /Lark bot is not configured/.test(error.message)) {
      throw new Error(cliText(
        "The Lark bot is not configured. Run agentbot init first, or use agentbot console for local-only testing.",
        "尚未配置飞书机器人。请先运行 agentbot init，或使用 agentbot console 进行纯本地测试。",
      ));
    }
    throw error;
  }
  const endpoint = controlEndpoint(config.storage.sqlitePath);

  if (await dependencies.isRunning(endpoint)) {
    return { status: "already-running" };
  }
  if (await dependencies.isReachable(endpoint)) {
    const running = await dependencies.waitUntilRunning(endpoint, SERVER_START_TIMEOUT_MS);
    if (!running) {
      throw new Error(cliText(
        "The Agent Bot server started but could not connect to Lark. Check the logs.",
        "Agent Bot 服务已启动，但无法连接飞书。请检查日志。",
      ));
    }
    return { status: "started" };
  }

  dependencies.spawnSupervisor(config);
  const running = await dependencies.waitUntilRunning(endpoint, SERVER_START_TIMEOUT_MS);
  if (!running) {
    throw new Error(cliText(
      "The Supervisor started, but the server did not connect to Lark within 45 seconds. Check the logs.",
      "Supervisor 已启动，但服务未能在 45 秒内连接飞书。请检查日志。",
    ));
  }
  return { status: "started" };
}

const defaultDependencies: ServerStarterDependencies = {
  isRunning: isServerRunning,
  isReachable: isServerReachable,
  waitUntilRunning: waitForServer,
  spawnSupervisor: (config) => {
    const entry = fileURLToPath(new URL("../supervisor.js", import.meta.url));
    const reportDirectory = resolveSupervisorDiagnosticsPaths(config).crashReportDirectory;
    prepareCrashReportDirectory(reportDirectory);
    const environmentRefresh = refreshedSystemEnvironment();
    const child = spawn(process.execPath, [
      ...nodeDiagnosticReportArguments(reportDirectory),
      entry,
    ], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...environmentRefresh.environment,
        AGENT_BOT_RESTART_REASON: "通过 Agent Bot CLI 启动",
      },
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
