import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  crashRestartDelayMs,
  INTENTIONAL_RESTART_DELAY_MS,
  RESTART_EXIT_CODE,
  STABLE_UPTIME_MS,
} from "./supervision/restartPolicy.js";

const childEntry = fileURLToPath(new URL("./index.js", import.meta.url));
let child: ChildProcess | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let stopping = false;
let consecutiveFailures = 0;

function startChild(): void {
  const startedAt = Date.now();
  child = spawn(process.execPath, [childEntry], {
    cwd: process.cwd(),
    env: { ...process.env, ACP_BOT_SUPERVISED: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  writeSupervisorLog("started", { pid: child.pid });

  child.once("error", (error) => {
    writeSupervisorLog("spawn_error", { error: error.message });
  });
  child.once("exit", (code, signal) => {
    child = undefined;
    const uptimeMs = Date.now() - startedAt;
    writeSupervisorLog("exited", { code, signal, uptimeMs });
    if (stopping) {
      process.exit(0);
      return;
    }

    const intentional = code === RESTART_EXIT_CODE;
    if (intentional || uptimeMs >= STABLE_UPTIME_MS) consecutiveFailures = 0;
    else consecutiveFailures += 1;
    const delayMs = intentional
      ? INTENTIONAL_RESTART_DELAY_MS
      : crashRestartDelayMs(consecutiveFailures);
    writeSupervisorLog("restarting", { delayMs, consecutiveFailures, intentional });
    restartTimer = setTimeout(startChild, delayMs);
  });
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
  process.stdout.write(`${JSON.stringify({ component: "acp-bot-supervisor", event, time: new Date().toISOString(), ...data })}\n`);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
const initialDelayMs = Number(process.env.ACP_BOT_START_DELAY_MS ?? 0);
if (Number.isFinite(initialDelayMs) && initialDelayMs > 0) restartTimer = setTimeout(startChild, initialDelayMs);
else startChild();
