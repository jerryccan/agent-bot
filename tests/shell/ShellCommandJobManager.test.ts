import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  ShellCommandJobManager,
  type ShellCommandJobSnapshot,
} from "../../src/shell/ShellCommandJobManager.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ShellCommandJobManager", () => {
  test("runs independently and persists output for recovery", async () => {
    const root = createJobsRoot();
    const manager = testManager(root);
    const command = nodeCommand([
      "console.log('JOB_START')",
      "setTimeout(() => console.error('JOB_WARNING'), 100)",
      "setTimeout(() => console.log('JOB_END'), 250)",
    ].join(";"));
    const created = await manager.createJob({ contextKey: "chat_id:test", command, cwd: process.cwd() });
    await manager.bindCard(created.id, "card_1");
    await manager.startJob(created.id);

    await waitForJob(manager, created.id, (job) => job.status === "running");
    const recovered = await testManager(root).listRecoverableJobs();
    expect(recovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, status: "running", cardMessageId: "card_1" }),
    ]));

    const completed = await waitForJob(manager, created.id, (job) => job.status === "completed");
    expect(completed.exitCode).toBe(0);
    expect(completed.output).toContain("JOB_START");
    expect(completed.output).toContain("JOB_WARNING");
    expect(completed.output).toContain("JOB_END");
    expect(completed.output.indexOf("JOB_START")).toBeLessThan(completed.output.indexOf("JOB_WARNING"));
    expect(completed.output.indexOf("JOB_WARNING")).toBeLessThan(completed.output.indexOf("JOB_END"));
    expect(fs.existsSync(path.join(root, created.id, "output.log"))).toBe(true);
    expect(fs.existsSync(path.join(root, created.id, "stdout.log"))).toBe(false);
    expect(fs.existsSync(path.join(root, created.id, "stderr.log"))).toBe(false);

    await manager.markPresented(created.id);
    expect(await manager.listRecoverableJobs()).toEqual([]);
  }, 15_000);

  test("cancels a running command process tree", async () => {
    const root = createJobsRoot();
    const manager = testManager(root);
    const command = nodeCommand("console.log('READY');setInterval(() => console.log('TICK'), 100)");
    const created = await manager.createJob({ contextKey: "chat_id:test", command, cwd: process.cwd() });
    await manager.bindCard(created.id, "card_2");
    await manager.startJob(created.id);
    await waitForJob(manager, created.id, (job) => job.status === "running" && job.output.includes("READY"));

    expect(await manager.requestCancellation(created.id)).toBe(true);
    const cancelled = await waitForJob(manager, created.id, (job) => job.status === "cancelled");
    expect(cancelled.completedAt).toBeTypeOf("number");
    expect(await manager.requestCancellation(created.id)).toBe(false);
  }, 15_000);
});

function createJobsRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-command-jobs-"));
  tempDirectories.push(directory);
  return directory;
}

function testManager(root: string): ShellCommandJobManager {
  const tsxLoader = import.meta.resolve("tsx");
  return new ShellCommandJobManager(root, {
    runnerEntry: fileURLToPath(new URL("../../src/shell/shellCommandRunner.ts", import.meta.url)),
    spawnRunner: async (entry, jobDirectory) => {
      const child = spawn(process.execPath, ["--import", tsxLoader, entry, jobDirectory], {
        cwd: jobDirectory,
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    },
  });
}

function nodeCommand(script: string): string {
  if (process.platform === "win32") {
    return `& '${process.execPath.replaceAll("'", "''")}' -e \"${script.replaceAll("\"", "`\"")}\"`;
  }
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e "${script.replaceAll("\"", "\\\"")}"`;
}

async function waitForJob(
  manager: ShellCommandJobManager,
  jobId: string,
  predicate: (job: ShellCommandJobSnapshot) => boolean,
): Promise<ShellCommandJobSnapshot> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await manager.readJob(jobId);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for shell command job ${jobId}.`);
}
