import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JOB_SPEC_FILE = "job.json";
const JOB_STATUS_FILE = "status.json";
const JOB_PRESENTATION_FILE = "presentation.json";
const CANCEL_REQUEST_FILE = "cancel.requested";
const OUTPUT_FILE = "output.log";
const LEGACY_STDOUT_FILE = "stdout.log";
const LEGACY_STDERR_FILE = "stderr.log";
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

export type ShellCommandJobStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface ShellCommandJobSpec {
  version: 1;
  id: string;
  contextKey: string;
  sourceMessageId?: string;
  command: string;
  cwd: string;
  createdAt: number;
  cardMessageId?: string;
}

export interface ShellCommandJobState {
  status: Exclude<ShellCommandJobStatus, "cancelling">;
  startedAt: number;
  updatedAt: number;
  runnerPid?: number;
  childPid?: number;
  completedAt?: number;
  exitCode?: number | null;
  error?: string;
}

export interface ShellCommandJobSnapshot extends ShellCommandJobSpec, Omit<ShellCommandJobState, "status"> {
  output: string;
  outputTruncated: boolean;
  status: ShellCommandJobStatus;
}

export interface ShellCommandJobManagerLike {
  createJob(input: Pick<ShellCommandJobSpec, "contextKey" | "sourceMessageId" | "command" | "cwd">): Promise<ShellCommandJobSnapshot>;
  bindCard(jobId: string, cardMessageId: string): Promise<ShellCommandJobSnapshot>;
  startJob(jobId: string): Promise<void>;
  failJob(jobId: string, error: string): Promise<void>;
  readJob(jobId: string): Promise<ShellCommandJobSnapshot>;
  listRecoverableJobs(): Promise<ShellCommandJobSnapshot[]>;
  requestCancellation(jobId: string): Promise<boolean>;
  markPresented(jobId: string): Promise<void>;
}

export interface ShellCommandJobManagerOptions {
  runnerEntry?: string;
  spawnRunner?: (entry: string, jobDirectory: string) => Promise<void>;
}

export class ShellCommandJobManager implements ShellCommandJobManagerLike {
  private readonly runnerEntry: string;
  private readonly spawnRunner: (entry: string, jobDirectory: string) => Promise<void>;

  constructor(
    private readonly jobsRoot: string,
    options: ShellCommandJobManagerOptions = {},
  ) {
    this.runnerEntry = options.runnerEntry ?? resolveRunnerEntry();
    this.spawnRunner = options.spawnRunner ?? launchDetachedRunner;
  }

  async createJob(
    input: Pick<ShellCommandJobSpec, "contextKey" | "sourceMessageId" | "command" | "cwd">,
  ): Promise<ShellCommandJobSnapshot> {
    const id = randomUUID();
    const createdAt = Date.now();
    const jobDirectory = this.jobDirectory(id);
    const spec: ShellCommandJobSpec = { version: 1, id, createdAt, ...input };
    const state: ShellCommandJobState = {
      status: "starting",
      startedAt: createdAt,
      updatedAt: createdAt,
    };
    await fs.mkdir(jobDirectory, { recursive: true });
    await Promise.all([
      writeJsonAtomic(path.join(jobDirectory, JOB_SPEC_FILE), spec),
      writeJsonAtomic(path.join(jobDirectory, JOB_STATUS_FILE), state),
      fs.writeFile(path.join(jobDirectory, OUTPUT_FILE), "", { flag: "wx" }),
    ]);
    return { ...spec, ...state, output: "", outputTruncated: false };
  }

  async bindCard(jobId: string, cardMessageId: string): Promise<ShellCommandJobSnapshot> {
    const jobDirectory = this.jobDirectory(jobId);
    const spec = await readJson<ShellCommandJobSpec>(path.join(jobDirectory, JOB_SPEC_FILE));
    await writeJsonAtomic(path.join(jobDirectory, JOB_SPEC_FILE), { ...spec, cardMessageId });
    return this.readJob(jobId);
  }

  async startJob(jobId: string): Promise<void> {
    const jobDirectory = this.jobDirectory(jobId);
    await this.spawnRunner(this.runnerEntry, jobDirectory);
  }

  async failJob(jobId: string, error: string): Promise<void> {
    const jobDirectory = this.jobDirectory(jobId);
    const state = await readJson<ShellCommandJobState>(path.join(jobDirectory, JOB_STATUS_FILE));
    const now = Date.now();
    await writeJsonAtomic(path.join(jobDirectory, JOB_STATUS_FILE), {
      ...state,
      status: "failed",
      updatedAt: now,
      completedAt: now,
      exitCode: null,
      error,
    } satisfies ShellCommandJobState);
  }

  async readJob(jobId: string): Promise<ShellCommandJobSnapshot> {
    const jobDirectory = this.jobDirectory(jobId);
    const [spec, savedState, cancellationRequested, output] = await Promise.all([
      readJson<ShellCommandJobSpec>(path.join(jobDirectory, JOB_SPEC_FILE)),
      readJson<ShellCommandJobState>(path.join(jobDirectory, JOB_STATUS_FILE)),
      fileExists(path.join(jobDirectory, CANCEL_REQUEST_FILE)),
      readJobOutput(jobDirectory),
    ]);
    const state = await reconcileExitedRunner(jobDirectory, savedState);
    const status = cancellationRequested && (state.status === "starting" || state.status === "running")
      ? "cancelling"
      : state.status;
    return { ...spec, ...state, ...output, status };
  }

  async listRecoverableJobs(): Promise<ShellCommandJobSnapshot[]> {
    const entries = await fs.readdir(this.jobsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const jobs: ShellCommandJobSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const job = await this.readJob(entry.name);
        const presented = await fileExists(path.join(this.jobDirectory(job.id), JOB_PRESENTATION_FILE));
        if (!presented || isActiveShellCommandJob(job.status)) jobs.push(job);
      } catch {
        // A partially written or unrelated directory is not a recoverable command job.
      }
    }
    return jobs.sort((left, right) => left.createdAt - right.createdAt);
  }

  async requestCancellation(jobId: string): Promise<boolean> {
    const job = await this.readJob(jobId);
    if (!isActiveShellCommandJob(job.status)) return false;
    await fs.writeFile(path.join(this.jobDirectory(jobId), CANCEL_REQUEST_FILE), `${Date.now()}\n`);
    return true;
  }

  async markPresented(jobId: string): Promise<void> {
    await writeJsonAtomic(
      path.join(this.jobDirectory(jobId), JOB_PRESENTATION_FILE),
      { presentedAt: Date.now() },
    );
  }

  private jobDirectory(jobId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(jobId)) throw new Error("Invalid shell command job ID.");
    return path.join(this.jobsRoot, jobId);
  }
}

export function isActiveShellCommandJob(status: ShellCommandJobStatus): boolean {
  return status === "starting" || status === "running" || status === "cancelling";
}

function resolveRunnerEntry(): string {
  const builtEntry = fileURLToPath(new URL("./shellCommandRunner.js", import.meta.url));
  const sourceEntry = fileURLToPath(new URL("./shellCommandRunner.ts", import.meta.url));
  return fileURLToPath(import.meta.url).endsWith(".ts") ? sourceEntry : builtEntry;
}

async function launchDetachedRunner(entry: string, jobDirectory: string): Promise<void> {
  const runnerArgs = entry.endsWith(".ts")
    ? [...process.execArgv, entry, jobDirectory]
    : [entry, jobDirectory];
  const child = spawn(process.execPath, runnerArgs, {
    cwd: jobDirectory,
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  await waitForSpawn(child);
  child.once("exit", (exitCode, signal) => {
    void recordUnexpectedRunnerExit(jobDirectory, exitCode, signal);
  });
  child.unref();
}

async function recordUnexpectedRunnerExit(
  jobDirectory: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  try {
    const statusPath = path.join(jobDirectory, JOB_STATUS_FILE);
    const state = await readJson<ShellCommandJobState>(statusPath);
    if (state.status !== "starting" && state.status !== "running") return;
    const now = Date.now();
    await writeJsonAtomic(statusPath, {
      ...state,
      status: "failed",
      updatedAt: now,
      completedAt: now,
      exitCode,
      error: `The background shell command runner exited unexpectedly${signal ? ` with ${signal}` : ""}.`,
    } satisfies ShellCommandJobState);
  } catch {
    // Startup recovery will retry a job whose runner exited before writing status.
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function readJobOutput(jobDirectory: string): Promise<{
  output: string;
  outputTruncated: boolean;
}> {
  const outputPath = path.join(jobDirectory, OUTPUT_FILE);
  if (await fileExists(outputPath)) {
    const output = await readBoundedFile(outputPath, MAX_CAPTURED_OUTPUT_BYTES);
    return { output: output.value, outputTruncated: output.truncated };
  }

  const stdoutPath = path.join(jobDirectory, LEGACY_STDOUT_FILE);
  const stderrPath = path.join(jobDirectory, LEGACY_STDERR_FILE);
  const [stdoutSize, stderrSize] = await Promise.all([fileSize(stdoutPath), fileSize(stderrPath)]);
  const totalSize = stdoutSize + stderrSize;
  const stdoutLimit = totalSize <= MAX_CAPTURED_OUTPUT_BYTES
    ? stdoutSize
    : stderrSize === 0
      ? MAX_CAPTURED_OUTPUT_BYTES
      : Math.max(1_024, Math.floor(MAX_CAPTURED_OUTPUT_BYTES * (stdoutSize / totalSize)));
  const stderrLimit = totalSize <= MAX_CAPTURED_OUTPUT_BYTES
    ? stderrSize
    : Math.max(1_024, MAX_CAPTURED_OUTPUT_BYTES - stdoutLimit);
  const [stdout, stderr] = await Promise.all([
    readBoundedFile(stdoutPath, stdoutLimit),
    readBoundedFile(stderrPath, stderrLimit),
  ]);
  return {
    output: `${stdout.value}${stderr.value}`,
    outputTruncated: stdout.truncated || stderr.truncated,
  };
}

async function reconcileExitedRunner(
  jobDirectory: string,
  state: ShellCommandJobState,
): Promise<ShellCommandJobState> {
  if (state.status !== "running" || state.runnerPid === undefined || processIsAlive(state.runnerPid)) return state;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const latest = await readJson<ShellCommandJobState>(path.join(jobDirectory, JOB_STATUS_FILE));
  if (latest.status !== "running" || latest.runnerPid !== state.runnerPid || processIsAlive(latest.runnerPid)) {
    return latest;
  }
  const now = Date.now();
  const failed: ShellCommandJobState = {
    ...latest,
    status: "failed",
    updatedAt: now,
    completedAt: now,
    exitCode: null,
    error: "The background shell command runner exited unexpectedly.",
  };
  await writeJsonAtomic(path.join(jobDirectory, JOB_STATUS_FILE), failed);
  return failed;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<{ value: string; truncated: boolean }> {
  const size = await fileSize(filePath);
  if (size === 0 || maxBytes <= 0) return { value: "", truncated: size > 0 };
  if (size <= maxBytes) return { value: await fs.readFile(filePath, "utf8"), truncated: false };
  const marker = Buffer.from("\n... output truncated ...\n", "utf8");
  const headBytes = Math.max(0, Math.ceil(maxBytes / 3) - marker.length);
  const tailBytes = Math.max(0, maxBytes - headBytes - marker.length);
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    if (headBytes > 0) await handle.read(head, 0, headBytes, 0);
    if (tailBytes > 0) await handle.read(tail, 0, tailBytes, size - tailBytes);
    return { value: Buffer.concat([head, marker, tail]).toString("utf8"), truncated: true };
  } finally {
    await handle.close();
  }
}

async function fileSize(filePath: string): Promise<number> {
  return fs.stat(filePath).then((stat) => stat.size).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filePath);
}
