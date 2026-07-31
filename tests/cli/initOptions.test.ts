import { describe, expect, test } from "vitest";
import { parseInitCommandOptions } from "../../src/cli/initOptions.js";

describe("init command options", () => {
  test("allows reset for an explicit profile", () => {
    expect(parseInitCommandOptions(["--reset"], true)).toEqual({
      json: false,
      skipFeishu: false,
      reconfigureFeishu: false,
      reset: true,
    });
  });

  test("requires an explicit profile for reset", () => {
    expect(() => parseInitCommandOptions(["--reset"], false))
      .toThrow("--reset requires an explicit --profile");
  });

  test("rejects overlapping credential replacement options", () => {
    expect(() => parseInitCommandOptions(["--reset", "--reconfigure-feishu"], true))
      .toThrow("--reset cannot be combined with --reconfigure-feishu");
  });

  test("allows a Console-only profile reset", () => {
    expect(parseInitCommandOptions(["--reset", "--skip-feishu", "--json"], true)).toEqual({
      json: true,
      skipFeishu: true,
      reconfigureFeishu: false,
      reset: true,
    });
  });
});
