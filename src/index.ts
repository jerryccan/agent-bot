import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AcpProcessManager } from "./acp/AcpProcessManager.js";
import { AcpSessionManager } from "./acp/AcpSessionManager.js";
import { CodexProcessManager } from "./codex/CodexProcessManager.js";
import { CodexRuntime } from "./codex/CodexRuntime.js";
import { LocalControlServer } from "./cli/LocalControlServer.js";
import { controlEndpoint, type ControlRequest, type ControlResponse } from "./cli/controlProtocol.js";
import { loadConfig } from "./config/loadConfig.js";
import { ConsoleConnector } from "./console/ConsoleConnector.js";
import { ConsoleTurnPresenter } from "./console/ConsoleTurnPresenter.js";
import { CardRenderer } from "./feishu/CardRenderer.js";
import { ConsoleFeishuClient } from "./feishu/ConsoleFeishuClient.js";
import { FeishuConnector } from "./feishu/FeishuConnector.js";
import { FeishuMessageClient } from "./feishu/FeishuMessageClient.js";
import { FeishuTurnPresenter } from "./feishu/FeishuTurnPresenter.js";
import { resolveFeishuTransport } from "./feishu/transport.js";
import { createLogger } from "./logging/logger.js";
import { OutboundRouter, type OutboundRoute } from "./presentation/OutboundRouter.js";
import { ProxySessionController } from "./proxy/ProxySessionController.js";
import { AcpRuntimeAdapter } from "./runtime/AcpRuntimeAdapter.js";
import { AgentRuntimeRegistry } from "./runtime/AgentRuntimeRegistry.js";
import { StateStore } from "./state/StateStore.js";
import { StartupNotifier } from "./startup/StartupNotifier.js";
import { SessionMetadataHydrator } from "./startup/SessionMetadataHydrator.js";
import { startFeishu } from "./startup/startFeishu.js";
import { RESTART_EXIT_CODE, STOP_EXIT_CODE } from "./supervision/restartPolicy.js";
import { saveRestartReason } from "./supervision/restartReasonStore.js";
import { SafeRestartScheduler } from "./supervision/SafeRestartScheduler.js";

const processStartedAt = new Date();
const startupReason = process.env.ACP_BOT_RESTART_REASON?.trim()
  || (process.env.ACP_BOT_SUPERVISED === "1" ? "Supervisor 启动" : "直接启动");
const consoleOnly = process.env.ACP_BOT_CONSOLE_ONLY === "1";
const config = loadConfig();
const logger = createLogger(config);
const store = new StateStore(config.storage.sqlitePath);

const acpProcessManager = new AcpProcessManager(logger);
const acpSessionManager = new AcpSessionManager(config, acpProcessManager, logger);
const acpRuntime = new AcpRuntimeAdapter(acpSessionManager);
const codexAgent = Object.values(config.agents).find((agent) => agent.kind === "codex");
const codexProcessManager = new CodexProcessManager(
  codexAgent?.command ?? "codex",
  codexAgent?.args ?? ["app-server", "--listen", "stdio://"],
  codexAgent?.env ?? {},
  logger,
);
const codexRuntime = new CodexRuntime(codexProcessManager, logger);
const runtimes = new AgentRuntimeRegistry({ acp: acpRuntime, codex: codexRuntime });

const transport = consoleOnly ? "console" : resolveFeishuTransport(config.feishu);
const routes: OutboundRoute[] = [];
let feishuConnector: FeishuConnector | undefined;
let consoleConnector: ConsoleConnector | undefined;
let startupNotifier: StartupNotifier | undefined;
let controlServer: LocalControlServer | undefined;

const feishuOutbound = transport === "sdk" ? new FeishuMessageClient(config, logger) : undefined;
if (feishuOutbound) {
  const renderer = new CardRenderer();
  const presenter = new FeishuTurnPresenter(feishuOutbound, store, renderer, {
    normalIntervalMs: 2_000,
    criticalGapMs: 500,
    onError: (error) => logger.warn({ error }, "Failed to update Codex progress card."),
  });
  routes.push({ matches: (contextKey) => !contextKey.startsWith("console:"), outbound: feishuOutbound, presenter });
  const defaultAgentName = config.defaults.agent!;
  const defaultAgent = config.agents[defaultAgentName];
  const metadataHydrator = new SessionMetadataHydrator(store, runtimes);
  startupNotifier = new StartupNotifier(store, feishuOutbound, renderer, logger, {
    defaultAgentName,
    defaultAgentTitle: defaultAgent?.title ?? defaultAgentName,
    cwd: path.resolve(config.defaults.cwd),
    workspaceKind: defaultAgent?.kind === "codex" ? "projectless" : "project",
  }, metadataHydrator);
}

const consoleEnabled = consoleOnly || config.console.enabled || transport === "console";
const consoleOutbound = consoleEnabled ? new ConsoleFeishuClient() : undefined;
if (consoleOutbound) {
  routes.push({
    matches: (contextKey) => contextKey.startsWith("console:"),
    outbound: consoleOutbound,
    presenter: new ConsoleTurnPresenter(consoleOutbound),
  });
}

if (routes.length === 0) throw new Error("Neither Feishu nor console input is enabled.");
const outbound = new OutboundRouter(routes);
let shuttingDown = false;
let restartRequested = false;
const controller = new ProxySessionController(config, store, runtimes, outbound, logger, {
  supervised: process.env.ACP_BOT_SUPERVISED === "1",
  restart: requestRestart,
});
const safeRestart = new SafeRestartScheduler({
  readActivity: () => store.getServerActivityState(),
  onReady: (reason) => initiateRestart(reason),
});

if (feishuOutbound) feishuConnector = new FeishuConnector(config, controller, logger);
if (consoleEnabled) consoleConnector = new ConsoleConnector(controller, logger);

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

if (feishuConnector && startupNotifier) {
  await startFeishu(feishuConnector, startupNotifier, processStartedAt, startupReason);
} else {
  await feishuConnector?.start();
}
consoleConnector?.start();

if (!consoleOnly) {
  controlServer = new LocalControlServer(
    controlEndpoint(config.storage.sqlitePath),
    handleControlRequest,
  );
  await controlServer.start();
  logger.info({ endpoint: controlEndpoint(config.storage.sqlitePath) }, "Local acp-bot control endpoint started.");
}

async function requestRestart(contextKey: string): Promise<void> {
  await initiateRestart("用户执行 /restart 命令", contextKey);
}

async function initiateRestart(reason: string, contextKey?: string): Promise<void> {
  if (restartRequested) {
    if (contextKey) await outbound.sendText(contextKey, "acp-bot 已在重启中，请稍候。").catch(() => undefined);
    return;
  }
  restartRequested = true;
  safeRestart.cancel();
  saveRestartReason(config.storage.sqlitePath, reason);
  if (contextKey) {
    await outbound.sendText(contextKey, "acp-bot 正在重启，恢复在线后会发送启动状态通知。").catch((error: unknown) => {
      logger.warn({ error, contextKey }, "Failed to send restart acknowledgement.");
    });
  }
  setTimeout(() => {
    if (process.env.ACP_BOT_SUPERVISED === "1") {
      void shutdown(RESTART_EXIT_CODE);
      return;
    }
    const supervisorEntry = fileURLToPath(new URL("./supervisor.js", import.meta.url));
    const supervisor = spawn(process.execPath, [supervisorEntry], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ACP_BOT_START_DELAY_MS: "1000",
        ACP_BOT_RESTART_REASON: "用户执行 /restart 命令",
      },
    });
    supervisor.unref();
    void shutdown(0);
  }, 100);
}

async function handleControlRequest(request: ControlRequest): Promise<ControlResponse> {
  switch (request.action) {
    case "health":
      return {
        ok: true,
        data: {
          pid: process.pid,
          startedAt: processStartedAt.toISOString(),
          supervised: process.env.ACP_BOT_SUPERVISED === "1",
          safeRestartScheduled: safeRestart.scheduled,
          safeRestartReason: safeRestart.pendingReason,
          activity: store.getServerActivityState(),
        },
      };
    case "server_restart":
      if (request.mode === "safe") {
        const newlyScheduled = safeRestart.schedule(request.reason);
        return {
          ok: true,
          message: newlyScheduled
            ? "已安排安全重启；将在全部任务完成并持续空闲 15 秒后执行。"
            : "安全重启已在等待中，已更新重启原因。",
        };
      }
      setTimeout(() => void initiateRestart(request.reason), 25);
      return { ok: true, message: "已请求立即重启。" };
    case "server_stop":
      safeRestart.cancel();
      setTimeout(() => void shutdown(STOP_EXIT_CODE), 25);
      return { ok: true, message: "已请求停止 acp-bot server。" };
    case "task_stop":
      return { ok: true, message: await controller.controlStopTask(request.localSessionId) };
    case "task_title":
      return { ok: true, message: await controller.controlSetTaskTitle(request.localSessionId, request.title) };
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ exitCode }, "Shutting down ACP bot.");
  safeRestart.cancel();
  feishuConnector?.stop();
  consoleConnector?.stop();
  controller.close();
  await Promise.race([
    outbound.flushAll().catch((error: unknown) => logger.warn({ error }, "Failed to flush presenters.")),
    delay(5_000),
  ]);
  runtimes.close();
  acpProcessManager.stopAll();
  await controlServer?.close().catch((error: unknown) => logger.warn({ error }, "Failed to close local control endpoint."));
  store.close();
  process.exit(exitCode);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
