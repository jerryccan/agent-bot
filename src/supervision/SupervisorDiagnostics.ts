import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config/schema.js";
import { DailyLogStream, dailyLogPath } from "../logging/DailyLogStream.js";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const LOG_BACKUP_COUNT = 3;

export interface SupervisorDiagnosticsPaths {
  supervisorLogPath: string;
  workerStderrPath: string;
  crashReportDirectory: string;
  lastCrashPath: string;
}

export interface WorkerCrashContext {
  workerPid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  exitedAt: string;
  uptimeMs: number;
  consecutiveFailures: number;
  restartDelayMs: number;
}

export interface WorkerCrashRecord extends WorkerCrashContext {
  version: 1;
  supervisorPid: number;
  nodeVersion: string;
  executablePath: string;
  cwd: string;
  supervisorLogPath: string;
  workerStderrPath: string;
  crashReportDirectory: string;
  diagnosticReports: string[];
}

type ExtendedProcessReport = typeof process.report & {
  excludeEnv?: boolean;
  excludeNetwork?: boolean;
};

export class SupervisorDiagnostics {
  readonly paths: SupervisorDiagnosticsPaths;
  private workerStderrStream?: DailyLogStream;

  constructor(
    config: Pick<AppConfig, "logging" | "storage">,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.paths = resolveSupervisorDiagnosticsPaths(config);
  }

  initialize(): void {
    try {
      ensurePrivateDirectory(path.dirname(this.paths.supervisorLogPath));
      ensurePrivateDirectory(this.paths.crashReportDirectory);
      rotateLogFile(this.currentSupervisorLogPath());
      rotateLogFile(this.currentWorkerStderrPath());
      this.configureCurrentProcessReports();
      this.writeEvent("diagnostics_initialized", {
        nodeVersion: process.versions.node,
        supervisorLogPath: this.currentSupervisorLogPath(),
        workerStderrPath: this.currentWorkerStderrPath(),
        crashReportDirectory: this.paths.crashReportDirectory,
      });
    } catch (error) {
      writeFallbackDiagnostic("initialize_failed", error);
    }
  }

  writeEvent(event: string, data: Record<string, unknown> = {}): void {
    const line = `${JSON.stringify({
      component: "agent-bot-supervisor",
      event,
      time: new Date().toISOString(),
      ...data,
    })}\n`;
    try {
      const logPath = this.currentSupervisorLogPath();
      rotateLogFile(logPath);
      fs.appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
      restrictFilePermissions(logPath);
    } catch (error) {
      writeFallbackDiagnostic(event, error);
    }
  }

  openWorkerStderr(): DailyLogStream | "ignore" {
    try {
      const stream = new DailyLogStream(this.paths.workerStderrPath, {
        clock: this.clock,
        mode: 0o600,
        beforeOpen: (filePath) => rotateLogFile(filePath),
      });
      stream.on("error", (error) => {
        this.writeEvent("worker_stderr_write_failed", { error: errorMessage(error) });
      });
      stream.write(`${JSON.stringify({ event: "worker_started", time: this.clock().toISOString() })}\n`);
      this.workerStderrStream = stream;
      return stream;
    } catch (error) {
      this.writeEvent("worker_stderr_open_failed", { error: errorMessage(error) });
      return "ignore";
    }
  }

  closeWorkerStderr(target: DailyLogStream | "ignore"): Promise<void> {
    if (target === "ignore") return Promise.resolve();
    return new Promise((resolve) => target.end(resolve));
  }

  currentSupervisorLogPath(date = this.clock()): string {
    return dailyLogPath(this.paths.supervisorLogPath, date);
  }

  currentWorkerStderrPath(date = this.clock()): string {
    return dailyLogPath(this.paths.workerStderrPath, date);
  }

  recordCrash(context: WorkerCrashContext): WorkerCrashRecord | undefined {
    try {
      const exitedAt = new Date(context.exitedAt);
      const crashDate = Number.isNaN(exitedAt.getTime()) ? this.clock() : exitedAt;
      const record: WorkerCrashRecord = {
        version: 1,
        ...context,
        supervisorPid: process.pid,
        nodeVersion: process.versions.node,
        executablePath: process.execPath,
        cwd: process.cwd(),
        supervisorLogPath: this.currentSupervisorLogPath(crashDate),
        workerStderrPath: this.workerStderrStream?.filePath ?? this.currentWorkerStderrPath(crashDate),
        crashReportDirectory: this.paths.crashReportDirectory,
        diagnosticReports: findDiagnosticReports(
          this.paths.crashReportDirectory,
          context.workerPid,
          Date.parse(context.startedAt),
        ),
      };
      const crashPath = path.join(
        this.paths.crashReportDirectory,
        crashRecordFilename(context.exitedAt, context.workerPid),
      );
      writePrivateJson(crashPath, record);
      writePrivateJson(this.paths.lastCrashPath, record);
      this.writeEvent("crash_context_saved", {
        crashPath,
        lastCrashPath: this.paths.lastCrashPath,
        diagnosticReports: record.diagnosticReports,
      });
      return record;
    } catch (error) {
      this.writeEvent("crash_context_save_failed", { error: errorMessage(error) });
      return undefined;
    }
  }

  private configureCurrentProcessReports(): void {
    const report = process.report as ExtendedProcessReport;
    report.directory = this.paths.crashReportDirectory;
    report.reportOnFatalError = true;
    report.reportOnUncaughtException = true;
    if ("excludeEnv" in report) report.excludeEnv = true;
    if ("excludeNetwork" in report) report.excludeNetwork = true;
  }
}

export function resolveSupervisorDiagnosticsPaths(
  config: Pick<AppConfig, "logging" | "storage">,
): SupervisorDiagnosticsPaths {
  const logDirectory = path.dirname(config.logging.path);
  const dataDirectory = path.dirname(config.storage.sqlitePath);
  return {
    supervisorLogPath: path.join(logDirectory, "supervisor.log"),
    workerStderrPath: path.join(logDirectory, "worker.stderr.log"),
    crashReportDirectory: path.join(dataDirectory, "crash-reports"),
    lastCrashPath: path.join(dataDirectory, "last-crash.json"),
  };
}

export function nodeDiagnosticReportArguments(
  reportDirectory: string,
  allowedFlags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): string[] {
  const args = [
    "--report-on-fatalerror",
    "--report-uncaught-exception",
    `--report-directory=${reportDirectory}`,
  ];
  if (allowedFlags.has("--report-exclude-env")) args.push("--report-exclude-env");
  if (allowedFlags.has("--report-exclude-network")) args.push("--report-exclude-network");
  return args;
}

export function prepareCrashReportDirectory(reportDirectory: string): boolean {
  try {
    ensurePrivateDirectory(reportDirectory);
    return true;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directoryPath, 0o700);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function rotateLogFile(filePath: string): void {
  const size = fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
  if (size < MAX_LOG_BYTES) return;
  for (let index = LOG_BACKUP_COUNT; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    if (!fs.existsSync(source)) continue;
    fs.rmSync(target, { force: true });
    fs.renameSync(source, target);
  }
}

function findDiagnosticReports(
  reportDirectory: string,
  workerPid: number | undefined,
  startedAtMs: number,
): string[] {
  if (!fs.existsSync(reportDirectory)) return [];
  const pidToken = workerPid === undefined ? undefined : `.${workerPid}.`;
  return fs.readdirSync(reportDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^report\..+\.json$/i.test(entry.name))
    .filter((entry) => {
      if (pidToken && entry.name.includes(pidToken)) return true;
      const modifiedAt = fs.statSync(path.join(reportDirectory, entry.name)).mtimeMs;
      return workerPid === undefined && modifiedAt >= startedAtMs - 1_000;
    })
    .map((entry) => path.join(reportDirectory, entry.name))
    .sort();
}

function crashRecordFilename(exitedAt: string, workerPid: number | undefined): string {
  const timestamp = exitedAt.replace(/\D/g, "");
  return `crash-${timestamp}-${workerPid ?? "unknown"}.json`;
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  restrictFilePermissions(filePath);
}

function restrictFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function writeFallbackDiagnostic(event: string, error: unknown): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        component: "agent-bot-supervisor",
        event,
        time: new Date().toISOString(),
        error: errorMessage(error),
      })}\n`,
    );
  } catch {
    // Diagnostics must never prevent the supervisor from keeping the worker alive.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
