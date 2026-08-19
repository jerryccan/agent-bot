import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prepareShellCommand } from "../utils/executeShellCommand.js";
import type { ShellCommandJobSpec, ShellCommandJobState } from "./ShellCommandJobManager.js";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const RETAINED_LOG_HEAD_BYTES = 2 * 1024 * 1024;
const RETAINED_LOG_TAIL_BYTES = 4 * 1024 * 1024;
const LOG_TRUNCATION_MARKER = Buffer.from("\n... earlier output compacted ...\n", "utf8");
const CANCEL_POLL_INTERVAL_MS = 500;
const FORCE_KILL_DELAY_MS = 3_000;

class RotatingLogWriter {
  private descriptor: number;
  private size: number;

  constructor(private readonly filePath: string) {
    this.descriptor = fs.openSync(filePath, "a");
    this.size = fs.fstatSync(this.descriptor).size;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    fs.writeSync(this.descriptor, chunk);
    this.size += chunk.length;
    if (this.size > MAX_LOG_BYTES) this.compact();
  }

  close(): void {
    fs.closeSync(this.descriptor);
  }

  private compact(): void {
    fs.closeSync(this.descriptor);
    const current = fs.readFileSync(this.filePath);
    const head = current.subarray(0, Math.min(RETAINED_LOG_HEAD_BYTES, current.length));
    const tailStart = Math.max(head.length, current.length - RETAINED_LOG_TAIL_BYTES);
    const tail = current.subarray(tailStart);
    fs.writeFileSync(this.filePath, Buffer.concat([head, LOG_TRUNCATION_MARKER, tail]));
    this.descriptor = fs.openSync(this.filePath, "a");
    this.size = fs.fstatSync(this.descriptor).size;
  }
}

const jobDirectory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("A shell command job directory is required.");

const spec = readJson<ShellCommandJobSpec>(path.join(jobDirectory, "job.json"));
const statusPath = path.join(jobDirectory, "status.json");
const cancelPath = path.join(jobDirectory, "cancel.requested");
const output = new RotatingLogWriter(path.join(jobDirectory, "output.log"));
const prepared = prepareShellCommand(spec.command, process.platform);
const child = spawn(prepared.command, prepared.args, {
  cwd: spec.cwd,
  detached: process.platform !== "win32",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let cancellationRequested = false;
let settled = false;
let forceKillTimer: NodeJS.Timeout | undefined;
writeStatus({
  status: "running",
  startedAt: spec.createdAt,
  updatedAt: Date.now(),
  runnerPid: process.pid,
  ...(child.pid ? { childPid: child.pid } : {}),
});

child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
child.stderr.on("data", (chunk: Buffer) => output.append(chunk));
child.once("error", (error) => finish("failed", null, error.message));
child.once("close", (exitCode) => {
  finish(cancellationRequested ? "cancelled" : exitCode === 0 ? "completed" : "failed", exitCode);
});

const cancelPoll = setInterval(() => {
  if (settled || cancellationRequested || !fs.existsSync(cancelPath)) return;
  cancellationRequested = true;
  void terminateProcessTree(child.pid);
  forceKillTimer = setTimeout(() => forceKillProcessTree(child.pid), FORCE_KILL_DELAY_MS);
  forceKillTimer.unref?.();
}, CANCEL_POLL_INTERVAL_MS);
cancelPoll.unref?.();

process.on("SIGTERM", () => {
  if (settled || cancellationRequested) return;
  cancellationRequested = true;
  void terminateProcessTree(child.pid);
});

function finish(
  status: "completed" | "failed" | "cancelled",
  exitCode: number | null,
  error?: string,
): void {
  if (settled) return;
  settled = true;
  clearInterval(cancelPoll);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  output.close();
  writeStatus({
    status,
    startedAt: spec.createdAt,
    updatedAt: Date.now(),
    runnerPid: process.pid,
    ...(child.pid ? { childPid: child.pid } : {}),
    completedAt: Date.now(),
    exitCode,
    ...(error ? { error } : {}),
  });
  process.exitCode = status === "completed" ? 0 : 1;
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The command may already have exited.
    }
  }
}

function forceKillProcessTree(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The command may already have exited.
    }
  }
}

function writeStatus(status: ShellCommandJobState): void {
  const temporary = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(temporary, statusPath);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
