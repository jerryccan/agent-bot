import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config/loadConfig.js";
import { defaultConfigPath } from "../../src/config/paths.js";
import { agentConfigSchema } from "../../src/config/schema.js";

describe("loadConfig", () => {
  test("creates and loads the default config from the user data directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-home-"));
    const previousHome = process.env.AGENT_BOT_HOME;
    const previousConfig = process.env.AGENT_BOT_CONFIG;
    process.env.AGENT_BOT_HOME = directory;
    process.env.AGENT_BOT_CONFIG = "";

    try {
      const config = loadConfig();

      expect(defaultConfigPath()).toBe(path.join(directory, "config.yaml"));
      expect(fs.existsSync(path.join(directory, "config.yaml"))).toBe(true);
      expect(config.feishu.transport).toBe("auto");
      expect(Object.keys(config.feishu).sort()).toEqual(
        ["appId", "appSecret", "transport", "useConsoleWhenMissingCredentials"].sort(),
      );
      expect(config.storage.sqlitePath).toBe(path.join(directory, "data", "agent-bot.sqlite"));
      expect(config.logging.path).toBe(path.join(directory, "logs", "agent-bot.log"));
    } finally {
      restoreEnv("AGENT_BOT_HOME", previousHome);
      restoreEnv("AGENT_BOT_CONFIG", previousConfig);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("loads the checked-in example config", () => {
    const config = loadConfig(path.resolve("config.example.yaml"));

    expect(config.defaults.agent).toBe("codex");
    expect(config.agents.codex?.kind).toBe("codex");
    expect(config.storage.sqlitePath).toBe(path.resolve("data/agent-bot.sqlite"));
    expect(config.logging.path).toBe(path.resolve("logs/agent-bot.log"));
  });

  test("resolves configured storage and log paths relative to the config file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-config-"));
    const configPath = path.join(directory, "config.yaml");
    const existingPath = path.join(directory, "existing.sqlite");
    fs.writeFileSync(existingPath, "");
    fs.writeFileSync(configPath, [
      "agents:",
      "  codex:",
      "    kind: codex",
      "    title: Codex",
      "    command: codex",
      "feishu: {}",
      "defaults:",
      "  agent: codex",
      "storage:",
      "  sqlitePath: ./state/agent-bot.sqlite",
      "logging:",
      "  path: ./logs/agent-bot.log",
    ].join("\n"));

    try {
      const config = loadConfig(configPath);
      expect(config.storage.sqlitePath).toBe(path.join(directory, "state", "agent-bot.sqlite"));
      expect(config.logging.path).toBe(path.join(directory, "logs", "agent-bot.log"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

});

test("uses ACP when agent kind is omitted", () => {
  const parsed = agentConfigSchema.parse({ title: "Example", command: "node" });

  expect(parsed.kind).toBe("acp");
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
