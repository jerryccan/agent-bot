import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("loadConfig", () => {
  test("loads the checked-in example config with auto transport", () => {
    const config = loadConfig(path.resolve("agents.yaml"));

    expect(config.feishu.transport).toBe("auto");
    expect(Object.keys(config.feishu).sort()).toEqual(
      ["appId", "appSecret", "transport", "useConsoleWhenMissingCredentials"].sort(),
    );
  });
});
