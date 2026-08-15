import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import {
  nodeDiagnosticReportArguments,
  prepareCrashReportDirectory,
  resolveSupervisorDiagnosticsPaths,
  SupervisorDiagnostics,
} from "../../src/supervision/SupervisorDiagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("SupervisorDiagnostics", () => {
  test("resolves logs and crash reports within the selected profile", () => {
    const root = temporaryDirectory();
    const config = testConfig(root);

    expect(resolveSupervisorDiagnosticsPaths(config)).toEqual({
      supervisorLogPath: path.join(root, "logs", "supervisor.log"),
      workerStderrPath: path.join(root, "logs", "worker.stderr.log"),
      crashReportDirectory: path.join(root, "data", "crash-reports"),
      lastCrashPath: path.join(root, "data", "last-crash.json"),
    });
  });

  test("enables reports while excluding environment and network data when supported", () => {
    const reportDirectory = "D:/profile/data/crash-reports";

    expect(nodeDiagnosticReportArguments(
      reportDirectory,
      new Set(["--report-exclude-env", "--report-exclude-network"]),
    )).toEqual([
      "--report-on-fatalerror",
      "--report-uncaught-exception",
      `--report-directory=${reportDirectory}`,
      "--report-exclude-env",
      "--report-exclude-network",
    ]);
  });

  test("keeps report startup compatible when exclusion flags are unavailable", () => {
    expect(nodeDiagnosticReportArguments("D:/reports", new Set())).toEqual([
      "--report-on-fatalerror",
      "--report-uncaught-exception",
      "--report-directory=D:/reports",
    ]);
  });

  test("uses diagnostic switches recognized by the current Node runtime", () => {
    const args = nodeDiagnosticReportArguments("D:/reports");

    for (const argument of args) {
      expect(process.allowedNodeEnvironmentFlags.has(argument.split("=")[0]!)).toBe(true);
    }
  });

  test("prepares a private report directory before spawning Node", () => {
    const reportDirectory = path.join(temporaryDirectory(), "data", "crash-reports");

    expect(prepareCrashReportDirectory(reportDirectory)).toBe(true);
    expect(fs.statSync(reportDirectory).isDirectory()).toBe(true);
  });

  test("persists supervisor events, worker stderr, and crash manifests in daily files", async () => {
    const root = temporaryDirectory();
    const now = new Date(2026, 6, 31, 12, 0, 0);
    const diagnostics = new SupervisorDiagnostics(testConfig(root), () => now);
    const previousReportSettings = captureReportSettings();
    try {
      diagnostics.initialize();
      diagnostics.writeEvent("started", { pid: 1234 });
      const workerStderr = diagnostics.openWorkerStderr();
      expect(workerStderr).not.toBe("ignore");
      if (workerStderr !== "ignore") {
        await new Promise<void>((resolve, reject) => {
          workerStderr.write("fatal worker output\n", (error) => error ? reject(error) : resolve());
        });
      }
      await diagnostics.closeWorkerStderr(workerStderr);

      const reportPath = path.join(
        diagnostics.paths.crashReportDirectory,
        "report.20260731.120000.1234.0.001.json",
      );
      fs.writeFileSync(reportPath, "{}\n");
      const record = diagnostics.recordCrash({
        workerPid: 1234,
        exitCode: 3221226505,
        signal: null,
        startedAt: new Date(now.getTime() - 60_000).toISOString(),
        exitedAt: now.toISOString(),
        uptimeMs: 60_000,
        consecutiveFailures: 1,
        restartDelayMs: 1_000,
      });

      expect(record).toMatchObject({
        version: 1,
        workerPid: 1234,
        exitCode: 3221226505,
        diagnosticReports: [reportPath],
        supervisorLogPath: diagnostics.currentSupervisorLogPath(),
        workerStderrPath: diagnostics.currentWorkerStderrPath(),
      });
      expect(fs.readFileSync(diagnostics.currentSupervisorLogPath(), "utf8")).toContain(
        '"event":"crash_context_saved"',
      );
      expect(fs.readFileSync(diagnostics.currentWorkerStderrPath(), "utf8")).toContain(
        "fatal worker output",
      );
      expect(JSON.parse(fs.readFileSync(diagnostics.paths.lastCrashPath, "utf8"))).toMatchObject({
        workerPid: 1234,
        exitCode: 3221226505,
      });
      const crashManifests = fs.readdirSync(diagnostics.paths.crashReportDirectory)
        .filter((name) => name.startsWith("crash-"));
      expect(crashManifests).toHaveLength(1);
    } finally {
      restoreReportSettings(previousReportSettings);
    }
  });

  test("records the last stderr file actually written when a worker crosses midnight silently", async () => {
    const root = temporaryDirectory();
    let now = new Date(2026, 6, 31, 23, 59, 59);
    const diagnostics = new SupervisorDiagnostics(testConfig(root), () => now);
    const previousReportSettings = captureReportSettings();
    try {
      diagnostics.initialize();
      const workerStderr = diagnostics.openWorkerStderr();
      expect(workerStderr).not.toBe("ignore");
      if (workerStderr !== "ignore") {
        await new Promise<void>((resolve, reject) => {
          workerStderr.write("before midnight\n", (error) => error ? reject(error) : resolve());
        });
      }
      const writtenPath = diagnostics.currentWorkerStderrPath(now);
      now = new Date(2026, 7, 1, 0, 0, 1);

      const record = diagnostics.recordCrash({
        workerPid: 2345,
        exitCode: 1,
        signal: null,
        startedAt: new Date(now.getTime() - 60_000).toISOString(),
        exitedAt: now.toISOString(),
        uptimeMs: 60_000,
        consecutiveFailures: 1,
        restartDelayMs: 1_000,
      });

      expect(record?.workerStderrPath).toBe(writtenPath);
      expect(fs.existsSync(writtenPath)).toBe(true);
      expect(fs.existsSync(diagnostics.currentWorkerStderrPath(now))).toBe(false);
      await diagnostics.closeWorkerStderr(workerStderr);
    } finally {
      restoreReportSettings(previousReportSettings);
    }
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-supervisor-diagnostics-"));
  temporaryDirectories.push(directory);
  return directory;
}

function testConfig(root: string): AppConfig {
  return {
    logging: {
      level: "info",
      path: path.join(root, "logs", "agent-bot.log"),
    },
    storage: {
      sqlitePath: path.join(root, "data", "agent-bot.sqlite"),
    },
  } as AppConfig;
}

interface ReportSettings {
  directory: string;
  reportOnFatalError: boolean;
  reportOnUncaughtException: boolean;
  excludeEnv?: boolean;
  excludeNetwork?: boolean;
}

function captureReportSettings(): ReportSettings {
  const report = process.report as typeof process.report & {
    excludeEnv?: boolean;
    excludeNetwork?: boolean;
  };
  return {
    directory: report.directory,
    reportOnFatalError: report.reportOnFatalError,
    reportOnUncaughtException: report.reportOnUncaughtException,
    excludeEnv: report.excludeEnv,
    excludeNetwork: report.excludeNetwork,
  };
}

function restoreReportSettings(settings: ReportSettings): void {
  const report = process.report as typeof process.report & {
    excludeEnv?: boolean;
    excludeNetwork?: boolean;
  };
  report.directory = settings.directory;
  report.reportOnFatalError = settings.reportOnFatalError;
  report.reportOnUncaughtException = settings.reportOnUncaughtException;
  if (settings.excludeEnv !== undefined) report.excludeEnv = settings.excludeEnv;
  if (settings.excludeNetwork !== undefined) report.excludeNetwork = settings.excludeNetwork;
}
