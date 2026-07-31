import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AcpProcessManager } from "./acp/AcpProcessManager.js";
import { AcpSessionManager } from "./acp/AcpSessionManager.js";
import { CodexProcessManager } from "./codex/CodexProcessManager.js";
import { CodexRuntime } from "./codex/CodexRuntime.js";
import { LocalControlServer } from "./cli/LocalControlServer.js";
import { controlEndpoint, type ControlRequest, type ControlResponse } from "./cli/controlProtocol.js";
import { readPackageVersion } from "./cli/packageVersion.js";
import { loadConfig } from "./config/loadConfig.js";
import { ConsoleConnector } from "./console/ConsoleConnector.js";
import { ConsoleTurnPresenter } from "./console/ConsoleTurnPresenter.js";
import { CardRenderer } from "./feishu/CardRenderer.js";
import { ConsoleFeishuClient } from "./feishu/ConsoleFeishuClient.js";
import { FeishuConnector } from "./feishu/FeishuConnector.js";
import { FeishuMessageClient } from "./feishu/FeishuMessageClient.js";
import { FeishuTurnPresenter } from "./feishu/FeishuTurnPresenter.js";
import { requireServerFeishuTransport } from "./feishu/transport.js";
import { createLogger } from "./logging/logger.js";
import { OutboundRouter, type OutboundRoute } from "./presentation/OutboundRouter.js";
import { ProxySessionController } from "./proxy/ProxySessionController.js";
import { AcpRuntimeAdapter } from "./runtime/AcpRuntimeAdapter.js";
import { AgentRuntimeRegistry } from "./runtime/AgentRuntimeRegistry.js";
import { StateStore } from "./state/StateStore.js";
import { StartupNotifier } from "./startup/StartupNotifier.js";
import { SessionMetadataHydrator } from "./startup/SessionMetadataHydrator.js";
import { startFeishu } from "./startup/startFeishu.js";
import { STOP_EXIT_CODE } from "./supervision/restartPolicy.js";
import { replacementSupervisorEnvironment } from "./supervision/replacementSupervisor.js";
import { SafeRestartScheduler } from "./supervision/SafeRestartScheduler.js";
import { SafeRestartNotifier } from "./supervision/SafeRestartNotifier.js";
import {
  nodeDiagnosticReportArguments,
  prepareCrashReportDirectory,
  resolveSupervisorDiagnosticsPaths,
} from "./supervision/SupervisorDiagnostics.js";

const processStartedAt = new Date();
const agentBotVersion = readPackageVersion();
const supervised = process.env.AGENT_BOT_SUPERVISED === "1";
const startupReason = process.env.AGENT_BOT_RESTART_REASON?.trim()
  || (supervised ? "Supervisor 启动" : "直接启动");
const consoleOnly = process.env.AGENT_BOT_CONSOLE_ONLY === "1";
const config = loadConfig();
const transport = consoleOnly ? "console" : requireServerFeishuTransport(config.feishu);
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

const routes: OutboundRoute[] = [];
let feishuConnector: FeishuConnector | undefined;
let consoleConnector: ConsoleConnector | undefined;
let startupNotifier: StartupNotifier | undefined;
let safeRestartNotifier: SafeRestartNotifier | undefined;
let controlServer: LocalControlServer | undefined;
let serverReady = false;

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
    agentBotVersion,
    defaultAgentName,
    defaultAgentTitle: defaultAgent?.title ?? defaultAgentName,
    cwd: path.resolve(config.defaults.cwd),
    workspaceKind: defaultAgent?.kind === "codex" ? "projectless" : "project",
    defaultUserOpenId: config.feishu.userOpenId,
  }, metadataHydrator);
  safeRestartNotifier = new SafeRestartNotifier(store, feishuOutbound, renderer, logger);
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
const safeRestart = new SafeRestartScheduler({
  readActivity: () => store.getServerActivityState(),
  onReady: (reason) => initiateRestart(reason),
  onStatus: (status) => safeRestartNotifier?.update(status),
  onStatusError: (error) => logger.warn({ error }, "Failed to publish safe restart status."),
});
const controller = new ProxySessionController(config, store, runtimes, outbound, logger, {
  supervised,
  restart: requestRestart,
  cancelSafeRestart: (scheduleId) => safeRestart.cancelScheduled(scheduleId),
});

if (feishuOutbound) feishuConnector = new FeishuConnector(config, controller, logger);
if (consoleEnabled) consoleConnector = new ConsoleConnector(controller, logger);

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const startControlServer = async (): Promise<void> => {
  if (consoleOnly || controlServer) return;
  controlServer = new LocalControlServer(
    controlEndpoint(config.storage.sqlitePath),
    handleControlRequest,
  );
  await controlServer.start();
  logger.info({ endpoint: controlEndpoint(config.storage.sqlitePath) }, "Local Agent Bot control endpoint started.");
};

if (feishuConnector && startupNotifier) {
  await startFeishu(
    feishuConnector,
    startupNotifier,
    processStartedAt,
    startupReason,
    startControlServer,
    () => { serverReady = true; },
  );
} else {
  await startControlServer();
  await feishuConnector?.start();
  serverReady = true;
}
consoleConnector?.start();

async function requestRestart(contextKey: string): Promise<void> {
  await initiateRestart("用户执行 /restart 命令", contextKey);
}

async function initiateRestart(reason: string, contextKey?: string): Promise<void> {
  if (restartRequested) {
    if (contextKey) await outbound.sendText(contextKey, "Agent Bot 已在重启中，请稍候。").catch(() => undefined);
    return;
  }
  restartRequested = true;
  safeRestart.cancel();
  await safeRestartNotifier?.flush();
  if (contextKey) {
    await outbound.sendText(contextKey, "Agent Bot 正在重启，恢复在线后会发送启动状态通知。").catch((error: unknown) => {
      logger.warn({ error, contextKey }, "Failed to send restart acknowledgement.");
    });
  }
  setTimeout(() => void shutdown(supervised ? STOP_EXIT_CODE : 0, reason), 100);
}

async function handleControlRequest(request: ControlRequest): Promise<ControlResponse> {
  switch (request.action) {
    case "health":
      return {
        ok: true,
        data: {
          ready: serverReady,
          phase: serverReady ? "ready" : "connecting_feishu",
          pid: process.pid,
          startedAt: processStartedAt.toISOString(),
          supervised,
          feishuAppId: config.feishu.appId ?? null,
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
            ? "Safe restart scheduled. It will run after all tasks finish and the server stays idle for 15 seconds."
            : "A safe restart is already pending. Its reason has been updated.",
        };
      }
      setTimeout(() => void initiateRestart(request.reason), 25);
      return { ok: true, message: "Immediate restart requested." };
    case "server_stop":
      safeRestart.cancel();
      setTimeout(() => void shutdown(STOP_EXIT_CODE), 25);
      return { ok: true, message: "Agent Bot server stop requested." };
    case "task_status":
      return { ok: true, data: await controller.controlGetTaskStatus(request.localSessionId) };
    case "task_stop":
      return { ok: true, message: await controller.controlStopTask(request.localSessionId) };
    case "task_title":
      return { ok: true, message: await controller.controlSetTaskTitle(request.localSessionId, request.title) };
    case "task_prompt":
      return { ok: true, message: await controller.controlSendTaskPrompt(request.localSessionId, request.text) };
  }
}

async function shutdown(exitCode: number, restartReason?: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ exitCode }, "Shutting down Agent Bot.");
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
  if (restartReason) startReplacementSupervisor(restartReason);
  process.exit(exitCode);
}

function startReplacementSupervisor(restartReason: string): void {
  const supervisorEntry = fileURLToPath(new URL("./supervisor.js", import.meta.url));
  const reportDirectory = resolveSupervisorDiagnosticsPaths(config).crashReportDirectory;
  prepareCrashReportDirectory(reportDirectory);
  const supervisor = spawn(process.execPath, [
    ...nodeDiagnosticReportArguments(reportDirectory),
    supervisorEntry,
  ], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: replacementSupervisorEnvironment(restartReason),
  });
  supervisor.unref();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
