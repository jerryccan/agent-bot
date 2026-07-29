import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isServerReachable } from "./cli/LocalControlClient.js";
import { controlEndpoint } from "./cli/controlProtocol.js";
import { loadConfig } from "./config/loadConfig.js";
import { requireServerFeishuTransport } from "./feishu/transport.js";
import {
  crashRestartDelayMs,
  describeRestartReason,
  INTENTIONAL_RESTART_DELAY_MS,
  RESTART_EXIT_CODE,
  STABLE_UPTIME_MS,
  STOP_EXIT_CODE,
} from "./supervision/restartPolicy.js";

const childEntry = fileURLToPath(new URL("./index.js", import.meta.url));
const config = loadConfig();
requireServerFeishuTransport(config.feishu);
const sqlitePath = config.storage.sqlitePath;
const serverEndpoint = controlEndpoint(sqlitePath);
let child: ChildProcess | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let stopping = false;
let consecutiveFailures = 0;
let nextStartReason = process.env.AGENT_BOT_RESTART_REASON?.trim() || "Supervisor 启动";

async function startChild(): Promise<void> {
  if (stopping || child) return;
  if (await isServerReachable(serverEndpoint)) {
    writeSupervisorLog("existing_server_detected", { endpoint: serverEndpoint });
    process.exit(0);
    return;
  }
  const startedAt = Date.now();
  const restartReason = nextStartReason;
  nextStartReason = "Supervisor 重新拉起进程";
  child = spawn(process.execPath, [childEntry], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_BOT_SUPERVISED: "1", AGENT_BOT_RESTART_REASON: restartReason },
    stdio: "inherit",
    windowsHide: true,
  });
  writeSupervisorLog("started", { pid: child.pid, restartReason });

  child.once("error", (error) => {
    writeSupervisorLog("spawn_error", { error: error.message });
  });
  child.once("exit", (code, signal) => {
    void handleChildExit(code, signal, startedAt);
  });
}

async function handleChildExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  startedAt: number,
): Promise<void> {
  child = undefined;
  const uptimeMs = Date.now() - startedAt;
  writeSupervisorLog("exited", { code, signal, uptimeMs });
  if (stopping) {
    process.exit(0);
    return;
  }
  if (code === STOP_EXIT_CODE) {
    writeSupervisorLog("stopped_by_request", { code });
    process.exit(0);
    return;
  }
  if (await isServerReachable(serverEndpoint)) {
    writeSupervisorLog("duplicate_supervisor_stopped", { endpoint: serverEndpoint });
    process.exit(0);
    return;
  }

  const intentional = code === RESTART_EXIT_CODE;
  nextStartReason = describeRestartReason(code, signal, intentional);
  if (intentional || uptimeMs >= STABLE_UPTIME_MS) consecutiveFailures = 0;
  else consecutiveFailures += 1;
  const delayMs = intentional
    ? INTENTIONAL_RESTART_DELAY_MS
    : crashRestartDelayMs(consecutiveFailures);
  writeSupervisorLog("restarting", { delayMs, consecutiveFailures, intentional });
  restartTimer = setTimeout(() => void startChild(), delayMs);
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child && !child.killed) {
    child.kill(signal);
    return;
  }
  process.exit(0);
}

function writeSupervisorLog(event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ component: "agent-bot-supervisor", event, time: new Date().toISOString(), ...data })}\n`);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
const initialDelayMs = Number(process.env.AGENT_BOT_START_DELAY_MS ?? 0);
if (Number.isFinite(initialDelayMs) && initialDelayMs > 0) {
  restartTimer = setTimeout(() => void startChild(), initialDelayMs);
} else {
  void startChild();
}
