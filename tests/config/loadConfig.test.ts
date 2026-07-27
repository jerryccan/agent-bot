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
    expect(config.storage.sqlitePath).toBe(path.resolve("data/agent-bot.sqlite"));
    expect(config.logging.path).toBe(path.resolve("logs/agent-bot.log"));
  });

  test("uses the configured database name even when another database exists", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-config-"));
    const configPath = path.join(directory, "agents.yaml");
    const existingPath = path.join(directory, "existing.sqlite");
    const renamedPath = path.join(directory, "agent-bot.sqlite");
    fs.writeFileSync(existingPath, "");
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
      expect(loadConfig(configPath).storage.sqlitePath).toBe(renamedPath);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("uses ACP when agent kind is omitted", () => {
  const parsed = agentConfigSchema.parse({ title: "Example", command: "node" });

  expect(parsed.kind).toBe("acp");
});
