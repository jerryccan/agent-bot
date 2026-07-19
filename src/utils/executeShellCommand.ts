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

export interface ShellCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
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

    child.stdout.on("data", (chunk: Buffer) => output.append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => output.append("stderr", chunk));
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
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private retainedBytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(stream: "stdout" | "stderr", chunk: Buffer): void {
    const remaining = Math.max(0, this.maxBytes - this.retainedBytes);
    if (remaining === 0) {
      this.truncated = true;
      return;
    }
    const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this[stream].push(retained);
    this.retainedBytes += retained.length;
    if (retained.length < chunk.length) this.truncated = true;
  }

  result(): Pick<ShellCommandResult, "stdout" | "stderr" | "outputTruncated"> {
    return {
      stdout: Buffer.concat(this.stdout).toString("utf8"),
      stderr: Buffer.concat(this.stderr).toString("utf8"),
      outputTruncated: this.truncated,
    };
  }
}
