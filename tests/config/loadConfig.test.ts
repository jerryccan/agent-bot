import fs from "node:fs";
import os from "node:os";
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
    const newStoragePath = path.resolve("data/agent-bot.sqlite");
    const legacyStoragePath = path.resolve("data/acp-bot.sqlite");
    expect(config.storage.sqlitePath).toBe(fs.existsSync(legacyStoragePath) ? legacyStoragePath : newStoragePath);
    expect(config.logging.path).toBe(path.resolve("logs/agent-bot.log"));
  });

  test("keeps using a legacy database when the renamed database does not exist yet", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-config-"));
    const configPath = path.join(directory, "agents.yaml");
    const legacyPath = path.join(directory, "acp-bot.sqlite");
    const renamedPath = path.join(directory, "agent-bot.sqlite");
    fs.writeFileSync(legacyPath, "");
    fs.writeFileSync(configPath, [
      "agents:",
      "  codex:",
      "    kind: codex",
      "    title: Codex",
      "    command: codex",
      "feishu: {}",
      "logging: {}",
      "defaults:",
      "  agent: codex",
      "storage:",
      `  sqlitePath: ${JSON.stringify(renamedPath)}`,
    ].join("\n"));

    try {
      expect(loadConfig(configPath).storage.sqlitePath).toBe(legacyPath);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("uses ACP when agent kind is omitted", () => {
  const parsed = agentConfigSchema.parse({ title: "Example", command: "node" });

  expect(parsed.kind).toBe("acp");
});
