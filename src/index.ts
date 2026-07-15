import os from "node:os";
import path from "node:path";
import { AcpProcessManager } from "./acp/AcpProcessManager.js";
import { AcpSessionManager } from "./acp/AcpSessionManager.js";
import { CodexProcessManager } from "./codex/CodexProcessManager.js";
import { CodexRuntime } from "./codex/CodexRuntime.js";
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

const processStartedAt = new Date();
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

const transport = resolveFeishuTransport(config.feishu);
const routes: OutboundRoute[] = [];
let feishuConnector: FeishuConnector | undefined;
let consoleConnector: ConsoleConnector | undefined;
let startupNotifier: StartupNotifier | undefined;

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
    cwd: defaultAgent?.kind === "codex"
      ? path.join(os.homedir(), "Documents", "Codex")
      : path.resolve(config.defaults.cwd),
  }, metadataHydrator);
}

const consoleEnabled = config.console.enabled || transport === "console";
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
const controller = new ProxySessionController(config, store, runtimes, outbound, logger);

if (feishuOutbound) feishuConnector = new FeishuConnector(config, controller, logger);
if (consoleEnabled) consoleConnector = new ConsoleConnector(controller, logger);

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (feishuConnector && startupNotifier) {
  await startFeishu(feishuConnector, startupNotifier, processStartedAt);
} else {
  await feishuConnector?.start();
}
consoleConnector?.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutting down ACP bot.");
  feishuConnector?.stop();
  consoleConnector?.stop();
  controller.close();
  await outbound.flushAll().catch((error: unknown) => logger.warn({ error }, "Failed to flush presenters."));
  runtimes.close();
  acpProcessManager.stopAll();
  store.close();
  process.exit(0);
}
