import { describe, expect, test } from "vitest";
import { executeShellCommand } from "../../src/utils/executeShellCommand.js";

describe("executeShellCommand", () => {
  test("runs a command through the platform shell", async () => {
    const command = process.platform === "win32" ? "Write-Output shell-ok" : "printf shell-ok";
    const snapshots: string[] = [];

    const result = await executeShellCommand(command, process.cwd(), {
      timeoutMs: 60_000,
      onOutput: (snapshot) => snapshots.push(snapshot.stdout),
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, outputTruncated: false });
    expect(result.stdout.trim()).toBe("shell-ok");
    expect(result.stderr).toBe("");
    expect(snapshots.at(-1)?.trim()).toBe("shell-ok");
  }, 70_000);

  test("returns stderr and a non-zero exit code", async () => {
    const command = process.platform === "win32"
      ? "[Console]::Error.WriteLine('shell-error'); exit 7"
      : "printf shell-error >&2; exit 7";

    const result = await executeShellCommand(command, process.cwd(), { timeoutMs: 60_000 });

    expect(result.exitCode).toBe(7);
    expect(result.stderr.trim()).toBe("shell-error");
  }, 70_000);

  test("preserves the beginning and end when command output exceeds the buffer", async () => {
    const command = process.platform === "win32"
      ? "Write-Output ('HEAD-' + ('x' * 400) + '-TAIL')"
      : "printf 'HEAD-'; printf '%0400d' 0; printf '%s' '-TAIL'";

    const result = await executeShellCommand(command, process.cwd(), {
      timeoutMs: 60_000,
      maxOutputBytes: 90,
    });

    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toContain("HEAD-");
    expect(result.stdout).toContain("output truncated");
    expect(result.stdout).toContain("-TAIL");
    expect(result.stdout).not.toContain("x".repeat(100));
  }, 70_000);
});
