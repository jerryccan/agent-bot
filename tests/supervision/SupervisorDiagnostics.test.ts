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

  test("persists supervisor events, worker stderr, and crash manifests", () => {
    const root = temporaryDirectory();
    const diagnostics = new SupervisorDiagnostics(testConfig(root));
    const previousReportSettings = captureReportSettings();
    try {
      diagnostics.initialize();
      diagnostics.writeEvent("started", { pid: 1234 });
      const workerStderr = diagnostics.openWorkerStderr();
      expect(typeof workerStderr).toBe("number");
      if (typeof workerStderr === "number") {
        fs.writeSync(workerStderr, "fatal worker output\n");
      }
      diagnostics.closeWorkerStderr(workerStderr);

      const reportPath = path.join(
        diagnostics.paths.crashReportDirectory,
        "report.20260731.120000.1234.0.001.json",
      );
      fs.writeFileSync(reportPath, "{}\n");
      const record = diagnostics.recordCrash({
        workerPid: 1234,
        exitCode: 3221226505,
        signal: null,
        startedAt: "2026-07-31T03:59:00.000Z",
        exitedAt: "2026-07-31T04:00:00.000Z",
        uptimeMs: 60_000,
        consecutiveFailures: 1,
        restartDelayMs: 1_000,
      });

      expect(record).toMatchObject({
        version: 1,
        workerPid: 1234,
        exitCode: 3221226505,
        diagnosticReports: [reportPath],
        supervisorLogPath: diagnostics.paths.supervisorLogPath,
        workerStderrPath: diagnostics.paths.workerStderrPath,
      });
      expect(fs.readFileSync(diagnostics.paths.supervisorLogPath, "utf8")).toContain(
        '"event":"crash_context_saved"',
      );
      expect(fs.readFileSync(diagnostics.paths.workerStderrPath, "utf8")).toContain(
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
