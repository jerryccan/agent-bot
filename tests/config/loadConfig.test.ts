import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config/loadConfig.js";
import { agentConfigSchema } from "../../src/config/schema.js";

describe("loadConfig", () => {
  test("loads the checked-in example config with auto transport", () => {
    const config = loadConfig(path.resolve("agents.yaml"));

    expect(config.feishu.transport).toBe("auto");
    expect(Object.keys(config.feishu).sort()).toEqual(
      ["appId", "appSecret", "transport", "useConsoleWhenMissingCredentials"].sort(),
    );
    expect(config.storage.sqlitePath).toBe(path.resolve("data/agent-bot.sqlite"));
    expect(config.logging.path).toBe(path.resolve("logs/agent-bot.log"));
  });
});

test("uses ACP when agent kind is omitted", () => {
  const parsed = agentConfigSchema.parse({ title: "Example", command: "node" });

  expect(parsed.kind).toBe("acp");
});
