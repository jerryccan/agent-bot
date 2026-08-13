import { describe, expect, test } from "vitest";
import { parseInitCommandOptions } from "../../src/cli/initOptions.js";

describe("init command options", () => {
  test("allows reset without an explicit profile", () => {
    expect(parseInitCommandOptions(["--reset"])).toEqual({
      json: false,
      skipFeishu: false,
      reconfigureFeishu: false,
      reset: true,
    });
  });

  test("rejects overlapping credential replacement options", () => {
    expect(() => parseInitCommandOptions(["--reset", "--reconfigure-feishu"]))
      .toThrow("--reset cannot be combined with --reconfigure-feishu");
  });

  test("allows a Console-only profile reset", () => {
    expect(parseInitCommandOptions(["--reset", "--skip-feishu", "--json"])).toEqual({
      json: true,
      skipFeishu: true,
      reconfigureFeishu: false,
      reset: true,
    });
  });
});
