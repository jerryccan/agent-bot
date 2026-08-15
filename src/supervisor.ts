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
import { SupervisorDiagnostics, nodeDiagnosticReportArguments } from "./supervision/SupervisorDiagnostics.js";
import { refreshedSystemEnvironment } from "./supervision/systemEnvironment.js";
import {
  RESTART_GROUP_CONTEXTS_ENV,
  RESTART_NOTIFICATION_TARGETS_ENV,
  restartGroupContextKeysFromEnvironment,
  restartNotificationTargetsFromEnvironment,
} from "./supervision/replacementSupervisor.js";
import type { RestartNotificationTarget } from "./supervision/SafeRestartScheduler.js";

const childEntry = fileURLToPath(new URL("./index.js", import.meta.url));
const config = loadConfig();
requireServerFeishuTransport(config.feishu);
const sqlitePath = config.storage.sqlitePath;
const serverEndpoint = controlEndpoint(sqlitePath);
const diagnostics = new SupervisorDiagnostics(config);
diagnostics.initialize();
let child: ChildProcess | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let restartNotificationTargetExpiryTimer: NodeJS.Timeout | undefined;
let stopping = false;
let consecutiveFailures = 0;
let nextStartReason = process.env.AGENT_BOT_RESTART_REASON?.trim() || "Supervisor 启动";
let nextRestartNotificationTargets = mergeRestartNotificationTargets(
  restartNotificationTargetsFromEnvironment(process.env[RESTART_NOTIFICATION_TARGETS_ENV]),
  restartGroupContextKeysFromEnvironment(process.env[RESTART_GROUP_CONTEXTS_ENV])
    .map((contextKey) => ({ contextKey })),
);

async function startChild(): Promise<void> {
  if (stopping || child) return;
  if (await isServerReachable(serverEndpoint)) {
    writeSupervisorLog("existing_server_detected", { endpoint: serverEndpoint });
    process.exit(0);
    return;
  }
  const startedAt = Date.now();
  const restartReason = nextStartReason;
  const restartNotificationTargets = nextRestartNotificationTargets;
  nextStartReason = "Supervisor 重新拉起进程";
  const workerStderr = diagnostics.openWorkerStderr();
  const environmentRefresh = refreshedSystemEnvironment();
  if (environmentRefresh.error) {
    writeSupervisorLog("environment_refresh_failed", { error: environmentRefresh.error });
  } else if (environmentRefresh.refreshed) {
    writeSupervisorLog("environment_refreshed", { pathChanged: environmentRefresh.pathChanged });
  }
  try {
    child = spawn(process.execPath, [
      ...nodeDiagnosticReportArguments(diagnostics.paths.crashReportDirectory),
      childEntry,
    ], {
      cwd: process.cwd(),
      env: workerEnvironment({
        ...environmentRefresh.environment,
        AGENT_BOT_SUPERVISED: "1",
        AGENT_BOT_RESTART_REASON: restartReason,
      }, restartNotificationTargets),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    if (workerStderr === "ignore") {
      child.stderr?.resume();
    } else {
      child.stderr?.pipe(workerStderr);
    }
  } catch (error) {
    void diagnostics.closeWorkerStderr(workerStderr);
    throw error;
  }
  const workerPid = child.pid;
  writeSupervisorLog("started", {
    pid: child.pid,
    restartReason,
    restartNotificationTargets,
    workerStderrPath: diagnostics.currentWorkerStderrPath(),
    crashReportDirectory: diagnostics.paths.crashReportDirectory,
  });

  child.once("error", (error) => {
    writeSupervisorLog("spawn_error", { pid: workerPid, error: error.message });
  });
  child.once("exit", (code, signal) => {
    void handleChildExit(code, signal, startedAt, workerPid);
  });
  if (restartNotificationTargets.length > 0) {
    if (restartNotificationTargetExpiryTimer) clearTimeout(restartNotificationTargetExpiryTimer);
    restartNotificationTargetExpiryTimer = setTimeout(() => {
      nextRestartNotificationTargets = [];
      restartNotificationTargetExpiryTimer = undefined;
    }, STABLE_UPTIME_MS);
  }
}

function workerEnvironment(
  environment: NodeJS.ProcessEnv,
  restartNotificationTargets: readonly RestartNotificationTarget[],
): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (restartNotificationTargets.length > 0) {
    result[RESTART_NOTIFICATION_TARGETS_ENV] = JSON.stringify(restartNotificationTargets);
  } else {
    delete result[RESTART_NOTIFICATION_TARGETS_ENV];
  }
  delete result[RESTART_GROUP_CONTEXTS_ENV];
  return result;
}

async function handleChildExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  startedAt: number,
  workerPid: number | undefined,
): Promise<void> {
  child = undefined;
  const uptimeMs = Date.now() - startedAt;
  writeSupervisorLog("exited", { pid: workerPid, code, signal, uptimeMs });
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
  if (!intentional) {
    diagnostics.recordCrash({
      workerPid,
      exitCode: code,
      signal,
      startedAt: new Date(startedAt).toISOString(),
      exitedAt: new Date().toISOString(),
      uptimeMs,
      consecutiveFailures,
      restartDelayMs: delayMs,
    });
  }
  writeSupervisorLog("restarting", {
    previousPid: workerPid,
    delayMs,
    consecutiveFailures,
    intentional,
  });
  restartTimer = setTimeout(() => void startChild(), delayMs);
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (restartNotificationTargetExpiryTimer) clearTimeout(restartNotificationTargetExpiryTimer);
  if (child && !child.killed) {
    child.kill(signal);
    return;
  }
  process.exit(0);
}

function writeSupervisorLog(event: string, data: Record<string, unknown>): void {
  diagnostics.writeEvent(event, data);
}

function mergeRestartNotificationTargets(
  ...targetGroups: RestartNotificationTarget[][]
): RestartNotificationTarget[] {
  const targets = new Map<string, RestartNotificationTarget>();
  for (const target of targetGroups.flat()) {
    const existing = targets.get(target.contextKey);
    if (!existing || (!existing.replyMessageId && target.replyMessageId)) {
      targets.set(target.contextKey, { ...target });
    }
  }
  return [...targets.values()];
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
const initialDelayMs = Number(process.env.AGENT_BOT_START_DELAY_MS ?? 0);
if (Number.isFinite(initialDelayMs) && initialDelayMs > 0) {
  restartTimer = setTimeout(() => void startChild(), initialDelayMs);
} else {
  void startChild();
}
