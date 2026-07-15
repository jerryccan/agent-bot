import { loadConfig } from "./config/loadConfig.js";
import { createLogger } from "./logging/logger.js";
import { StateStore } from "./state/StateStore.js";
import { AcpProcessManager } from "./acp/AcpProcessManager.js";
import { AcpSessionManager } from "./acp/AcpSessionManager.js";
import { FeishuConnector } from "./feishu/FeishuConnector.js";
import { FeishuMessageClient } from "./feishu/FeishuMessageClient.js";
import { ConsoleFeishuClient } from "./feishu/ConsoleFeishuClient.js";
import { resolveFeishuTransport } from "./feishu/transport.js";
import { ProxySessionController } from "./proxy/ProxySessionController.js";

const config = loadConfig();
const logger = createLogger(config);
const store = new StateStore(config.storage.sqlitePath);
const processManager = new AcpProcessManager(logger);
const acpSessionManager = new AcpSessionManager(config, processManager, logger);
const transport = resolveFeishuTransport(config.feishu);
const outbound =
  transport === "sdk" ? new FeishuMessageClient(config, logger) : new ConsoleFeishuClient();

const controller = new ProxySessionController(
  config,
  store,
  acpSessionManager,
  outbound,
  logger,
);
const connector = new FeishuConnector(config, controller, logger, transport);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await connector.start();

function shutdown(): void {
  logger.info("Shutting down ACP bot.");
  connector.stop();
  processManager.stopAll();
  store.close();
  process.exit(0);
}
