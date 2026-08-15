import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
}

export type ShellCommandOutputSnapshot = Pick<
  ShellCommandResult,
  "stdout" | "stderr" | "outputTruncated"
>;

export interface ShellCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
  onOutput?: (snapshot: ShellCommandOutputSnapshot) => void;
}

export function executeShellCommand(
  command: string,
  cwd: string,
  options: ShellCommandOptions = {},
): Promise<ShellCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const prepared = prepareShellCommand(command, options.platform ?? process.platform);

  return new Promise((resolve, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = new BoundedOutput(maxOutputBytes);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      output.append(stream, chunk);
      try {
        options.onOutput?.(output.result());
      } catch {
        // Output presentation must never interrupt the child process.
      }
    };
    child.stdout.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        ...output.result(),
        exitCode,
        timedOut,
      });
    });
  });
}

function prepareShellCommand(command: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform !== "win32") return { command: "/bin/sh", args: ["-lc", command] };
  const script = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ${command}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
  };
}

class BoundedOutput {
  private retained: OutputChunk[] = [];
  private readonly seenBytes = { stdout: 0, stderr: 0 };
  private readonly headBytes: number;
  private readonly tailBytes: number;
  private truncated = false;

  constructor(maxBytes: number) {
    const normalizedMaxBytes = Math.max(1, Math.floor(maxBytes));
    this.headBytes = Math.ceil(normalizedMaxBytes / 3);
    this.tailBytes = normalizedMaxBytes - this.headBytes;
  }

  append(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.seenBytes[stream] += chunk.length;

    if (!this.truncated) {
      const next = [...this.retained, { stream, data: chunk }];
      if (outputChunksLength(next) <= this.headBytes + this.tailBytes) {
        this.retained = next;
        return;
      }
      this.truncated = true;
      this.retained = [
        ...takeOutputChunkHead(next, this.headBytes),
        ...takeOutputChunkTail(next, this.tailBytes),
      ];
      return;
    }

    const head = takeOutputChunkHead(this.retained, this.headBytes);
    const previousTail = takeOutputChunkTail(this.retained, this.tailBytes);
    const tail = takeOutputChunkTail([...previousTail, { stream, data: chunk }], this.tailBytes);
    this.retained = [...head, ...tail];
  }

  result(): ShellCommandOutputSnapshot {
    return {
      stdout: this.streamResult("stdout"),
      stderr: this.streamResult("stderr"),
      outputTruncated: this.truncated,
    };
  }

  private streamResult(stream: "stdout" | "stderr"): string {
    if (!this.truncated) {
      return Buffer.concat(
        this.retained.filter((chunk) => chunk.stream === stream).map((chunk) => chunk.data),
      ).toString("utf8");
    }
    const head = takeOutputChunkHead(this.retained, this.headBytes)
      .filter((chunk) => chunk.stream === stream);
    const tail = takeOutputChunkTail(this.retained, this.tailBytes)
      .filter((chunk) => chunk.stream === stream);

    const retainedBytes = outputChunksLength([...head, ...tail]);
    const marker = this.seenBytes[stream] > retainedBytes
      ? Buffer.from("\n... output truncated ...\n", "utf8")
      : Buffer.alloc(0);
    return Buffer.concat([
      ...head.map((chunk) => chunk.data),
      marker,
      ...tail.map((chunk) => chunk.data),
    ]).toString("utf8");
  }
}

interface OutputChunk {
  stream: "stdout" | "stderr";
  data: Buffer;
}

function outputChunksLength(chunks: OutputChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.data.length, 0);
}

function takeOutputChunkHead(chunks: OutputChunk[], maxBytes: number): OutputChunk[] {
  const retained: OutputChunk[] = [];
  let remaining = maxBytes;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const data = chunk.data.length <= remaining ? chunk.data : chunk.data.subarray(0, remaining);
    retained.push({ stream: chunk.stream, data });
    remaining -= data.length;
  }
  return retained;
}

function takeOutputChunkTail(chunks: OutputChunk[], maxBytes: number): OutputChunk[] {
  const retained: OutputChunk[] = [];
  let remaining = maxBytes;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index]!;
    const data = chunk.data.length <= remaining
      ? chunk.data
      : chunk.data.subarray(chunk.data.length - remaining);
    retained.unshift({ stream: chunk.stream, data });
    remaining -= data.length;
  }
  return retained;
}
