import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config/schema.js";

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

  constructor(config: Pick<AppConfig, "logging" | "storage">) {
    this.paths = resolveSupervisorDiagnosticsPaths(config);
  }

  initialize(): void {
    try {
      ensurePrivateDirectory(path.dirname(this.paths.supervisorLogPath));
      ensurePrivateDirectory(this.paths.crashReportDirectory);
      rotateLogFile(this.paths.supervisorLogPath);
      rotateLogFile(this.paths.workerStderrPath);
      this.configureCurrentProcessReports();
      this.writeEvent("diagnostics_initialized", {
        nodeVersion: process.versions.node,
        supervisorLogPath: this.paths.supervisorLogPath,
        workerStderrPath: this.paths.workerStderrPath,
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
      fs.appendFileSync(this.paths.supervisorLogPath, line, { encoding: "utf8", mode: 0o600 });
      restrictFilePermissions(this.paths.supervisorLogPath);
    } catch (error) {
      writeFallbackDiagnostic(event, error);
    }
  }

  openWorkerStderr(): number | "ignore" {
    try {
      rotateLogFile(this.paths.workerStderrPath);
      fs.appendFileSync(
        this.paths.workerStderrPath,
        `${JSON.stringify({ event: "worker_started", time: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      restrictFilePermissions(this.paths.workerStderrPath);
      return fs.openSync(this.paths.workerStderrPath, "a", 0o600);
    } catch (error) {
      this.writeEvent("worker_stderr_open_failed", { error: errorMessage(error) });
      return "ignore";
    }
  }

  closeWorkerStderr(target: number | "ignore"): void {
    if (typeof target !== "number") return;
    try {
      fs.closeSync(target);
    } catch (error) {
      this.writeEvent("worker_stderr_close_failed", { error: errorMessage(error) });
    }
  }

  recordCrash(context: WorkerCrashContext): WorkerCrashRecord | undefined {
    try {
      const record: WorkerCrashRecord = {
        version: 1,
        ...context,
        supervisorPid: process.pid,
        nodeVersion: process.versions.node,
        executablePath: process.execPath,
        cwd: process.cwd(),
        supervisorLogPath: this.paths.supervisorLogPath,
        workerStderrPath: this.paths.workerStderrPath,
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
