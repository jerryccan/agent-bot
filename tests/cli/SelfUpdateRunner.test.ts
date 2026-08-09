import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applySelfUpdatePlan,
  SELF_UPDATE_PLAN_VERSION,
  type SelfUpdatePlan,
  type SelfUpdateRunnerDependencies,
} from "../../src/cli/SelfUpdateRunner.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("self-update runner", () => {
  test("installs the verified candidate and restores the running service", async () => {
    const plan = createPlan();
    const dependencies = createDependencies();

    const result = await applySelfUpdatePlan(plan, [10, 20], dependencies);

    expect(result).toMatchObject({
      status: "updated",
      activeVersion: "1.2.4",
      serviceReady: true,
    });
    expect(dependencies.waitForProcesses).toHaveBeenCalledWith(
      [10, 20],
      60_000,
    );
    expect(dependencies.runNpm).toHaveBeenCalledTimes(1);
    expect(dependencies.validatePackage).toHaveBeenCalledWith(
      plan.packageRoot,
      plan.packageName,
      plan.toVersion,
    );
    expect(JSON.parse(fs.readFileSync(plan.resultPath, "utf8"))).toMatchObject({
      status: "updated",
    });
    expect(fs.existsSync(plan.lockPath)).toBe(false);
    expect(fs.existsSync(plan.pendingMarkerPath)).toBe(false);
  });

  test("reinstalls the old npm package when candidate validation fails", async () => {
    const plan = createPlan();
    const dependencies = createDependencies();
    vi.mocked(dependencies.validatePackage)
      .mockImplementationOnce(() => {
        throw new Error("candidate invalid");
      })
      .mockImplementationOnce(() => undefined);

    const result = await applySelfUpdatePlan(plan, [], dependencies);

    expect(result).toMatchObject({
      status: "rolled-back",
      activeVersion: "1.2.3",
      fallback: "npm",
      serviceReady: true,
      error: "candidate invalid",
    });
    expect(dependencies.runNpm).toHaveBeenCalledTimes(2);
  });

  test("starts the complete package backup when npm rollback also fails", async () => {
    const plan = createPlan();
    const dependencies = createDependencies();
    vi.mocked(dependencies.runNpm)
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "candidate install failed",
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "rollback install failed",
      });

    const result = await applySelfUpdatePlan(plan, [], dependencies);

    expect(result).toMatchObject({
      status: "rolled-back",
      activeVersion: "1.2.3",
      fallback: "backup",
      serviceReady: true,
      error: "candidate install failed",
      rollbackError: "rollback install failed",
    });
    expect(dependencies.startSupervisor).toHaveBeenCalledWith(
      plan.backupPackageRoot,
      plan.workingDirectory,
    );
  });

  test("does not touch npm when the old processes fail to exit", async () => {
    const plan = createPlan();
    const dependencies = createDependencies();
    vi.mocked(dependencies.waitForProcesses).mockRejectedValue(
      new Error("old Supervisor still running"),
    );
    vi.mocked(dependencies.waitForServer)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await applySelfUpdatePlan(plan, [10], dependencies);

    expect(result).toMatchObject({
      status: "rolled-back",
      activeVersion: "1.2.3",
      fallback: "backup",
      serviceReady: true,
      error: "old Supervisor still running",
    });
    expect(dependencies.runNpm).not.toHaveBeenCalled();
    expect(dependencies.startSupervisor).toHaveBeenCalledWith(
      plan.backupPackageRoot,
      plan.workingDirectory,
    );
  });

  test("restores the pre-update database before starting the old version", async () => {
    const plan = createPlan();
    fs.writeFileSync(plan.databasePath, "old database");
    const dependencies = createDependencies();
    vi.mocked(dependencies.startSupervisor)
      .mockImplementationOnce(() => {
        fs.writeFileSync(plan.databasePath, "migrated database");
        return 123;
      })
      .mockReturnValueOnce(456);
    vi.mocked(dependencies.waitForServer)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await applySelfUpdatePlan(plan, [], dependencies);

    expect(result).toMatchObject({
      status: "rolled-back",
      fallback: "npm",
      serviceReady: true,
    });
    expect(fs.readFileSync(plan.databasePath, "utf8")).toBe("old database");
    expect(
      fs.existsSync(
        path.join(
          path.dirname(plan.resultPath),
          "database-backup",
          "manifest.json",
        ),
      ),
    ).toBe(true);
  });
});

function createPlan(): SelfUpdatePlan {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-bot-update-runner-"),
  );
  temporaryDirectories.push(root);
  const resultPath = path.join(root, "result.json");
  const plan: SelfUpdatePlan = {
    schemaVersion: SELF_UPDATE_PLAN_VERSION,
    packageName: "@keyou007/agent-bot",
    fromVersion: "1.2.3",
    toVersion: "1.2.4",
    packageRoot: path.join(root, "global-package"),
    candidateTarball: path.join(root, "candidate.tgz"),
    backupTarball: path.join(root, "backup.tgz"),
    backupPackageRoot: path.join(root, "backup-package"),
    lockPath: path.join(root, "update.lock"),
    lockToken: "test-token",
    pendingMarkerPath: path.join(root, "pending-update.json"),
    databasePath: path.join(root, "agent-bot.sqlite"),
    controlEndpoint: "test-endpoint",
    workingDirectory: root,
    restartService: true,
    resultPath,
    logPath: path.join(root, "update.log"),
  };
  fs.writeFileSync(
    path.join(root, "update.lock"),
    JSON.stringify({ token: "test-token" }),
  );
  fs.writeFileSync(
    path.join(root, "pending-update.json"),
    JSON.stringify({
      token: "test-token",
      phase: "prepared",
    }),
  );
  return plan;
}

function createDependencies(): SelfUpdateRunnerDependencies {
  return {
    runNpm: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
    validatePackage: vi.fn(),
    startSupervisor: vi.fn(() => 123),
    waitForServer: vi.fn(async () => true),
    stopServer: vi.fn(async () => undefined),
    waitForProcesses: vi.fn(async () => undefined),
    now: vi.fn(() => new Date("2026-08-08T12:00:00.000Z")),
  };
}
