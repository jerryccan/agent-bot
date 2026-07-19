import { describe, expect, test } from "vitest";
import {
  crashRestartDelayMs,
  describeRestartReason,
  RESTART_EXIT_CODE,
  STOP_EXIT_CODE,
} from "../../src/supervision/restartPolicy.js";

describe("restartPolicy", () => {
  test("uses a dedicated exit code for intentional restarts", () => {
    expect(RESTART_EXIT_CODE).toBe(75);
    expect(STOP_EXIT_CODE).toBe(76);
  });

  test("describes intentional, signaled, and exit-code restarts", () => {
    expect(describeRestartReason(RESTART_EXIT_CODE, null, true)).toBe("用户执行 /restart 命令");
    expect(describeRestartReason(null, "SIGTERM", false)).toContain("SIGTERM");
    expect(describeRestartReason(1, null, false)).toContain("exit code 1");
  });

  test("backs off repeated crashes and caps the delay", () => {
    expect(crashRestartDelayMs(1)).toBe(1_000);
    expect(crashRestartDelayMs(2)).toBe(2_000);
    expect(crashRestartDelayMs(5)).toBe(16_000);
    expect(crashRestartDelayMs(10)).toBe(30_000);
  });
});
