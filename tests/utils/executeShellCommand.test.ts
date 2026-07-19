import { describe, expect, test } from "vitest";
import { executeShellCommand } from "../../src/utils/executeShellCommand.js";

describe("executeShellCommand", () => {
  test("runs a command through the platform shell", async () => {
    const command = process.platform === "win32" ? "Write-Output shell-ok" : "printf shell-ok";

    const result = await executeShellCommand(command, process.cwd(), { timeoutMs: 5_000 });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, outputTruncated: false });
    expect(result.stdout.trim()).toBe("shell-ok");
    expect(result.stderr).toBe("");
  });

  test("returns stderr and a non-zero exit code", async () => {
    const command = process.platform === "win32"
      ? "[Console]::Error.WriteLine('shell-error'); exit 7"
      : "printf shell-error >&2; exit 7";

    const result = await executeShellCommand(command, process.cwd(), { timeoutMs: 5_000 });

    expect(result.exitCode).toBe(7);
    expect(result.stderr.trim()).toBe("shell-error");
  });
});
