import { describe, expect, test } from "vitest";
import { crashRestartDelayMs, RESTART_EXIT_CODE } from "../../src/supervision/restartPolicy.js";

describe("restartPolicy", () => {
  test("uses a dedicated exit code for intentional restarts", () => {
    expect(RESTART_EXIT_CODE).toBe(75);
  });

  test("backs off repeated crashes and caps the delay", () => {
    expect(crashRestartDelayMs(1)).toBe(1_000);
    expect(crashRestartDelayMs(2)).toBe(2_000);
    expect(crashRestartDelayMs(5)).toBe(16_000);
    expect(crashRestartDelayMs(10)).toBe(30_000);
  });
});
