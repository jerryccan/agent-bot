import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyExplicitProfile } from "../../src/cli/profile.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import {
  AGENT_BOT_EXPLICIT_PROFILE_ENV,
  defaultConfigPath,
} from "../../src/config/paths.js";
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
        ["appId", "appSecret", "transport", "userOpenId", "useConsoleWhenMissingCredentials"].sort(),
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

  test("loads explicit profile credentials instead of inherited primary credentials", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-profile-"));
    const preserved = new Map([
      ["AGENT_BOT_HOME", process.env.AGENT_BOT_HOME],
      ["AGENT_BOT_CONFIG", process.env.AGENT_BOT_CONFIG],
      [AGENT_BOT_EXPLICIT_PROFILE_ENV, process.env[AGENT_BOT_EXPLICIT_PROFILE_ENV]],
      ["FEISHU_APP_ID", process.env.FEISHU_APP_ID],
      ["FEISHU_APP_SECRET", process.env.FEISHU_APP_SECRET],
      ["FEISHU_USER_OPEN_ID", process.env.FEISHU_USER_OPEN_ID],
    ]);
    process.env.FEISHU_APP_ID = "primary-app";
    process.env.FEISHU_APP_SECRET = "primary-secret";
    fs.writeFileSync(path.join(directory, "config.yaml"), [
      "feishu:",
      "  appId: ${FEISHU_APP_ID}",
      "  appSecret: ${FEISHU_APP_SECRET}",
      "  userOpenId: ${FEISHU_USER_OPEN_ID}",
      "agents:",
      "  codex:",
      "    kind: codex",
      "    title: Codex",
      "    command: codex",
      "defaults:",
      "  agent: codex",
      "storage:",
      "  sqlitePath: ./data/agent-bot.sqlite",
      "logging:",
      "  path: ./logs/agent-bot.log",
    ].join("\n"));
    fs.writeFileSync(path.join(directory, ".env"), [
      "FEISHU_APP_ID=rescue-app",
      "FEISHU_APP_SECRET=rescue-secret",
      "FEISHU_USER_OPEN_ID=rescue-user",
    ].join("\n"));

    try {
      applyExplicitProfile(directory);
      const config = loadConfig();

      expect(config.feishu.appId).toBe("rescue-app");
      expect(config.feishu.appSecret).toBe("rescue-secret");
      expect(config.feishu.userOpenId).toBe("rescue-user");
      expect(config.storage.sqlitePath).toBe(path.join(directory, "data", "agent-bot.sqlite"));
    } finally {
      for (const [name, value] of preserved) restoreEnv(name, value);
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
