import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  acquireInitializationLock,
  cleanupFeishuCredentialTemporaryFiles,
  initializeAgentBot,
  readConfiguredAgentSelection,
  readFeishuCredentials,
  readGroupMessageResponseMode,
  shouldCreateFeishuApp,
  shouldConfigureAgentsDuringInitialization,
  shouldConfigureGroupMessagesDuringInitialization,
  writeConfiguredAgentSelection,
  writeDefaultAgent,
  writeFeishuCredentials,
  writeGroupMessageResponseMode,
} from "../../src/cli/Initializer.js";

const directories: string[] = [];

interface ParsedUpgradeConfig {
  feishu: Record<string, unknown>;
  console: Record<string, unknown>;
  agents: Record<string, Record<string, unknown>>;
  defaults: Record<string, unknown>;
  storage: Record<string, unknown>;
  logging: Record<string, unknown>;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("shouldConfigureAgentsDuringInitialization", () => {
  test("configures Agents for a first-time config or an explicit reset", () => {
    expect(shouldConfigureAgentsDuringInitialization("created")).toBe(true);
    expect(shouldConfigureAgentsDuringInitialization("existing")).toBe(false);
    expect(shouldConfigureAgentsDuringInitialization("updated")).toBe(false);
    expect(shouldConfigureAgentsDuringInitialization("reset")).toBe(true);
  });
});

describe("group message response initialization", () => {
  test("asks for a selection only on first initialization or reset", () => {
    expect(shouldConfigureGroupMessagesDuringInitialization("created")).toBe(true);
    expect(shouldConfigureGroupMessagesDuringInitialization("existing")).toBe(false);
    expect(shouldConfigureGroupMessagesDuringInitialization("updated")).toBe(false);
    expect(shouldConfigureGroupMessagesDuringInitialization("reset")).toBe(true);
  });

  test("persists the selected response mode while preserving YAML comments", () => {
    const fixture = createFixture();
    fs.mkdirSync(fixture.home, { recursive: true });
    const configPath = path.join(fixture.home, "config.yaml");
    fs.writeFileSync(configPath, [
      "feishu:",
      "  # keep this explanation",
      "  respondToAllGroupMessages: true",
      "agents: {}",
      "",
    ].join("\n"), "utf8");

    expect(readGroupMessageResponseMode(configPath)).toBe("all");
    expect(writeGroupMessageResponseMode(configPath, "mention-only")).toBe(true);
    expect(writeGroupMessageResponseMode(configPath, "mention-only")).toBe(false);
    expect(readGroupMessageResponseMode(configPath)).toBe("mention-only");
    expect(fs.readFileSync(configPath, "utf8")).toContain("# keep this explanation");
    expect(fs.readFileSync(configPath, "utf8")).toContain("respondToAllGroupMessages: false");
  });
});

describe("initializeAgentBot", () => {
  test("creates the user files and runtime directories from bundled templates", () => {
    const fixture = createFixture();

    const result = initializeAgentBot(fixture.options);

    expect(result).toEqual({
      home: { path: fixture.home, status: "created" },
      config: { path: path.join(fixture.home, "config.yaml"), status: "created" },
      env: { path: path.join(fixture.home, ".env"), status: "created" },
      data: { path: path.join(fixture.home, "data"), status: "created" },
      logs: { path: path.join(fixture.home, "logs"), status: "created" },
    });
    expect(fs.readFileSync(result.config.path, "utf8")).toBe("agents: {}\n");
    expect(fs.readFileSync(result.env.path, "utf8")).toBe("FEISHU_APP_ID=\n");
  });

  test("is idempotent and preserves existing user files", () => {
    const fixture = createFixture();
    initializeAgentBot(fixture.options);
    const userConfig = [
      "# user config",
      "agents:",
      "  custom:",
      "    title: Custom",
      "    command: custom-agent",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(fixture.home, "config.yaml"), userConfig, "utf8");
    const userEnv = "FEISHU_APP_ID=user-app\nUSER_VALUE=1\n";
    fs.writeFileSync(path.join(fixture.home, ".env"), userEnv, "utf8");

    const result = initializeAgentBot(fixture.options);

    expect(result.config.status).toBe("existing");
    expect(result.env.status).toBe("existing");
    expect(result.data.status).toBe("existing");
    expect(result.logs.status).toBe("existing");
    expect(fs.readFileSync(result.config.path, "utf8")).toBe(userConfig);
    expect(fs.readFileSync(result.env.path, "utf8")).toBe(userEnv);
  });

  test("upgrades an existing environment file with missing template variables", () => {
    const fixture = createFixture();
    fs.writeFileSync(fixture.options.envTemplatePath!, [
      "# Lark credentials",
      "FEISHU_APP_ID=",
      "FEISHU_APP_SECRET=",
      "FEISHU_USER_OPEN_ID=",
      "# AGENT_BOT_HOME=~/.agent-bot",
      "AGENT_BOT_FEATURE=enabled",
      "",
    ].join("\n"), "utf8");
    fs.mkdirSync(fixture.home, { recursive: true });
    const envPath = path.join(fixture.home, ".env");
    const original = "# keep this comment\r\nFEISHU_APP_ID=user-app\r\nFEISHU_APP_SECRET=user-secret\r\n";
    fs.writeFileSync(envPath, original, "utf8");

    const upgraded = initializeAgentBot(fixture.options);
    const upgradedContents = fs.readFileSync(envPath, "utf8");

    expect(upgraded.env.status).toBe("updated");
    expect(upgradedContents).toBe(
      `${original}FEISHU_USER_OPEN_ID=\r\nAGENT_BOT_FEATURE=enabled\r\n`,
    );
    expect(upgradedContents).not.toContain("AGENT_BOT_HOME=");

    const repeated = initializeAgentBot(fixture.options);
    expect(repeated.env.status).toBe("existing");
    expect(fs.readFileSync(envPath, "utf8")).toBe(upgradedContents);
  });

  test("upgrades an existing config with missing template settings without replacing user choices", () => {
    const fixture = createFixture();
    const template = [
      "feishu:",
      "  appId: \"${FEISHU_APP_ID}\"",
      "  appSecret: \"${FEISHU_APP_SECRET}\"",
      "  respondToOwnerOnly: true",
      "  respondToAllGroupMessages: true",
      "console:",
      "  enabled: true",
      "agents:",
      "  codex:",
      "    kind: app-server",
      "    title: Codex",
      "    command: codex",
      "    args: [app-server]",
      "    env: {}",
      "  traex:",
      "    kind: app-server",
      "    title: TraeX",
      "    command: traex",
      "    args: [app-server]",
      "    env: {}",
      "defaults:",
      "  agent: codex",
      "  cwd: .",
      "storage:",
      "  sqlitePath: ./data/agent-bot.sqlite",
      "logging:",
      "  level: info",
      "  path: ./logs/agent-bot.log",
      "",
    ].join("\n");
    fs.writeFileSync(fixture.options.configTemplatePath!, template, "utf8");
    fs.mkdirSync(fixture.home, { recursive: true });
    const configPath = path.join(fixture.home, "config.yaml");
    fs.writeFileSync(configPath, [
      "# keep this user comment",
      "feishu:",
      "  appId: custom-app",
      "  respondToAllGroupMessages: false",
      "agents:",
      "  codex:",
      "    title: Custom Codex",
      "    command: custom-codex",
      "    args:",
      "      - custom-server",
      "  custom:",
      "    title: Custom Agent",
      "    command: custom-agent",
      "defaults:",
      "  cwd: D:/work",
      "logging:",
      "  level: debug",
      "",
    ].join("\n"), "utf8");

    const upgraded = initializeAgentBot(fixture.options);
    const upgradedContents = fs.readFileSync(configPath, "utf8");
    const parsed = parseYaml(upgradedContents) as ParsedUpgradeConfig;

    expect(upgraded.config.status).toBe("updated");
    expect(upgradedContents).toContain("# keep this user comment");
    expect(parsed.feishu).toEqual({
      appId: "custom-app",
      appSecret: "${FEISHU_APP_SECRET}",
      respondToOwnerOnly: true,
      respondToAllGroupMessages: false,
    });
    expect(parsed.console).toEqual({ enabled: true });
    expect(parsed.agents.codex).toEqual({
      kind: "app-server",
      title: "Custom Codex",
      command: "custom-codex",
      args: ["custom-server"],
      env: {},
    });
    expect(parsed.agents.custom).toEqual({ title: "Custom Agent", command: "custom-agent" });
    expect(parsed.agents.traex).toBeUndefined();
    expect(parsed.defaults).toEqual({ cwd: "D:/work" });
    expect(parsed.storage).toEqual({ sqlitePath: "./data/agent-bot.sqlite" });
    expect(parsed.logging).toEqual({ level: "debug", path: "./logs/agent-bot.log" });

    const repeated = initializeAgentBot(fixture.options);
    expect(repeated.config.status).toBe("existing");
    expect(fs.readFileSync(configPath, "utf8")).toBe(upgradedContents);
  });

  test("lists configured Agents and updates the default while preserving YAML comments", () => {
    const fixture = createFixture();
    fs.mkdirSync(fixture.home, { recursive: true });
    const configPath = path.join(fixture.home, "config.yaml");
    fs.writeFileSync(configPath, [
      "# keep this header",
      "agents:",
      "  codex:",
      "    title: Codex",
      "    command: codex",
      "  traex:",
      "    title: Custom TraeX",
      "    command: traex",
      "defaults:",
      "  # keep this selection comment",
      "  agent: codex",
      "  cwd: .",
      "",
    ].join("\n"), "utf8");

    expect(readConfiguredAgentSelection(configPath)).toEqual({
      agents: [
        { name: "codex", title: "Codex" },
        { name: "traex", title: "Custom TraeX" },
      ],
      defaultAgent: "codex",
    });
    expect(writeDefaultAgent(configPath, "traex")).toBe(true);
    expect(writeDefaultAgent(configPath, "traex")).toBe(false);

    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated).toContain("# keep this header");
    expect(updated).toContain("# keep this selection comment");
    expect((parseYaml(updated) as ParsedUpgradeConfig).defaults).toEqual({ agent: "traex", cwd: "." });
    expect(() => writeDefaultAgent(configPath, "missing")).toThrow(
      "Cannot select an Agent that is not configured",
    );
  });

  test("creates defaults.agent when an upgraded config did not have a defaults mapping", () => {
    const fixture = createFixture();
    fs.mkdirSync(fixture.home, { recursive: true });
    const configPath = path.join(fixture.home, "config.yaml");
    fs.writeFileSync(configPath, [
      "agents:",
      "  custom:",
      "    title: Custom Agent",
      "    command: custom-agent",
      "",
    ].join("\n"), "utf8");

    expect(writeDefaultAgent(configPath, "custom")).toBe(true);
    expect(readConfiguredAgentSelection(configPath)).toEqual({
      agents: [{ name: "custom", title: "Custom Agent" }],
      defaultAgent: "custom",
    });
  });

  test("keeps only selected Agents and sets the selected default atomically", () => {
    const fixture = createFixture();
    fs.mkdirSync(fixture.home, { recursive: true });
    const configPath = path.join(fixture.home, "config.yaml");
    fs.writeFileSync(configPath, [
      "# keep this header",
      "agents:",
      "  codex:",
      "    title: Codex",
      "    command: codex",
      "  traex:",
      "    title: TraeX",
      "    command: traex",
      "defaults:",
      "  agent: codex",
      "  cwd: .",
      "",
    ].join("\n"), "utf8");

    expect(writeConfiguredAgentSelection(configPath, ["codex", "traex"], "traex")).toBe(true);
    expect(readConfiguredAgentSelection(configPath)).toEqual({
      agents: [
        { name: "codex", title: "Codex" },
        { name: "traex", title: "TraeX" },
      ],
      defaultAgent: "traex",
    });
    expect(writeConfiguredAgentSelection(configPath, ["codex", "traex"], "traex")).toBe(false);

    expect(writeConfiguredAgentSelection(configPath, ["traex"], "traex")).toBe(true);
    expect(readConfiguredAgentSelection(configPath)).toEqual({
      agents: [{ name: "traex", title: "TraeX" }],
      defaultAgent: "traex",
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain("# keep this header");
    expect(() => writeConfiguredAgentSelection(configPath, [], "traex")).toThrow(
      "At least one Agent must be configured",
    );
    expect(() => writeConfiguredAgentSelection(configPath, ["traex"], "codex")).toThrow(
      "Default Agent must be included",
    );
  });

  test("does not overwrite an invalid existing config during upgrade", () => {
    const fixture = createFixture();
    fs.mkdirSync(fixture.home, { recursive: true });
    const configPath = path.join(fixture.home, "config.yaml");
    const invalidConfig = "agents: [\n";
    fs.writeFileSync(configPath, invalidConfig, "utf8");

    expect(() => initializeAgentBot(fixture.options)).toThrow("Could not upgrade configuration file");
    expect(fs.readFileSync(configPath, "utf8")).toBe(invalidConfig);
    expect(fs.readdirSync(fixture.home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("respects an explicit config path while keeping .env under AGENT_BOT_HOME", () => {
    const fixture = createFixture();
    const configPath = path.join(fixture.root, "custom", "agent-bot.yaml");

    const result = initializeAgentBot({ ...fixture.options, configPath });

    expect(result.config.path).toBe(configPath);
    expect(result.env.path).toBe(path.join(fixture.home, ".env"));
    expect(result.data.path).toBe(path.join(path.dirname(configPath), "data"));
    expect(result.logs.path).toBe(path.join(path.dirname(configPath), "logs"));
  });

  test("backs up and resets all active profile contents while preserving unrelated files", () => {
    const fixture = createFixture();
    const initial = initializeAgentBot(fixture.options);
    fs.writeFileSync(initial.config.path, "user config\n", "utf8");
    fs.writeFileSync(initial.env.path, "FEISHU_APP_ID=old\nFEISHU_APP_SECRET=old-secret\n", "utf8");
    fs.writeFileSync(path.join(initial.data.path, "state.sqlite"), "old state", "utf8");
    fs.writeFileSync(path.join(initial.logs.path, "agent-bot.log"), "old log", "utf8");
    fs.writeFileSync(path.join(fixture.home, "notes.txt"), "keep", "utf8");

    const reset = initializeAgentBot({ ...fixture.options, reset: true });

    expect(reset.config.status).toBe("reset");
    expect(reset.env.status).toBe("reset");
    expect(reset.data.status).toBe("reset");
    expect(reset.logs.status).toBe("reset");
    expect(reset.reset?.backupPath).toMatch(
      new RegExp(`^${escapeRegExp(path.join(fixture.home, ".reset-backups"))}`),
    );
    expect(fs.readFileSync(reset.config.path, "utf8")).toBe("agents: {}\n");
    expect(fs.readFileSync(reset.env.path, "utf8")).toBe("FEISHU_APP_ID=\n");
    expect(fs.readdirSync(reset.data.path)).toEqual([]);
    expect(fs.readdirSync(reset.logs.path)).toEqual([]);
    expect(fs.readFileSync(path.join(fixture.home, "notes.txt"), "utf8")).toBe("keep");

    const backupPath = reset.reset!.backupPath;
    expect(fs.readFileSync(path.join(backupPath, "config.yaml"), "utf8")).toBe("user config\n");
    expect(fs.readFileSync(path.join(backupPath, ".env"), "utf8")).toContain("old-secret");
    expect(fs.readFileSync(path.join(backupPath, "data", "state.sqlite"), "utf8")).toBe("old state");
    expect(fs.readFileSync(path.join(backupPath, "logs", "agent-bot.log"), "utf8")).toBe("old log");

    const secondReset = initializeAgentBot({ ...fixture.options, reset: true });
    expect(secondReset.reset?.backupPath).not.toBe(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.existsSync(secondReset.reset!.backupPath)).toBe(true);
  });

  test("rejects reset when config is outside the selected profile", () => {
    const fixture = createFixture();
    const configPath = path.join(fixture.root, "custom", "agent-bot.yaml");

    expect(() => initializeAgentBot({
      ...fixture.options,
      configPath,
      reset: true,
    })).toThrow("--reset only supports a profile-owned config.yaml and .env");
  });

  test("writes Feishu credentials without changing other environment settings", () => {
    const fixture = createFixture();
    const result = initializeAgentBot(fixture.options);
    fs.writeFileSync(
      result.env.path,
      ["# user comment", "FEISHU_APP_ID=", "CUSTOM_VALUE=keep-me", "FEISHU_APP_SECRET=", ""].join("\n"),
      "utf8",
    );

    writeFeishuCredentials(result.env.path, {
      appId: "cli_created",
      appSecret: "secret-created",
      userOpenId: "ou_initializer",
    });

    expect(fs.readFileSync(result.env.path, "utf8")).toBe(
      [
        "# user comment",
        "FEISHU_APP_ID=cli_created",
        "CUSTOM_VALUE=keep-me",
        "FEISHU_APP_SECRET=secret-created",
        "FEISHU_USER_OPEN_ID=ou_initializer",
        "",
      ].join("\n"),
    );
    expect(readFeishuCredentials(result.env.path, {})).toEqual({
      status: "configured",
      appId: "cli_created",
      appSecret: "secret-created",
      userOpenId: "ou_initializer",
    });
    expect(
      fs.readdirSync(path.dirname(result.env.path)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("reports incomplete credentials", () => {
    const fixture = createFixture();
    const result = initializeAgentBot(fixture.options);
    fs.writeFileSync(result.env.path, "FEISHU_APP_ID=cli_only\nFEISHU_APP_SECRET=\n", "utf8");

    expect(readFeishuCredentials(result.env.path, {})).toEqual({
      status: "incomplete",
      appId: "cli_only",
      appSecret: undefined,
    });
  });

  test("creates a new app unless a complete credential pair is available", () => {
    expect(shouldCreateFeishuApp({ status: "missing" }, false)).toBe(true);
    expect(shouldCreateFeishuApp({ status: "incomplete", appId: "cli_only" }, false)).toBe(true);
    expect(
      shouldCreateFeishuApp(
        { status: "configured", appId: "cli_existing", appSecret: "secret" },
        false,
      ),
    ).toBe(false);
    expect(
      shouldCreateFeishuApp(
        { status: "configured", appId: "cli_existing", appSecret: "secret" },
        true,
      ),
    ).toBe(true);
  });

  test("prevents concurrent initialization and releases an owned lock", () => {
    const fixture = createFixture();
    const dataDirectory = path.join(fixture.home, "data");
    const first = acquireInitializationLock(dataDirectory);

    expect(() => acquireInitializationLock(dataDirectory)).toThrow("Another agentbot init process is running");
    expect(fs.existsSync(first.path)).toBe(true);

    first.release();
    expect(fs.existsSync(first.path)).toBe(false);
    const next = acquireInitializationLock(dataDirectory);
    next.release();
  });

  test("recovers an initialization lock left by a dead process", () => {
    const fixture = createFixture();
    const dataDirectory = path.join(fixture.home, "data");
    fs.mkdirSync(dataDirectory, { recursive: true });
    const lockPath = path.join(dataDirectory, "init.lock");
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        token: "stale",
        pid: 2_000_000_000,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const recovered = acquireInitializationLock(dataDirectory);

    expect(recovered.path).toBe(lockPath);
    recovered.release();
  });

  test("cleans credential temporary files left by an interrupted write", () => {
    const fixture = createFixture();
    const result = initializeAgentBot(fixture.options);
    const staleTemporaryPath = `${result.env.path}.123.456.tmp`;
    const unrelatedPath = `${result.env.path}.notes.tmp`;
    fs.writeFileSync(staleTemporaryPath, "partial", "utf8");
    fs.writeFileSync(unrelatedPath, "keep", "utf8");

    expect(cleanupFeishuCredentialTemporaryFiles(result.env.path)).toBe(1);
    expect(fs.existsSync(staleTemporaryPath)).toBe(false);
    expect(fs.existsSync(unrelatedPath)).toBe(true);
  });
});

function createFixture(): {
  root: string;
  home: string;
  options: NonNullable<Parameters<typeof initializeAgentBot>[0]>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-init-"));
  directories.push(root);
  const home = path.join(root, "home");
  const templates = path.join(root, "templates");
  fs.mkdirSync(templates, { recursive: true });
  const configTemplatePath = path.join(templates, "config.example.yaml");
  const envTemplatePath = path.join(templates, ".env.example");
  fs.writeFileSync(configTemplatePath, "agents: {}\n", "utf8");
  fs.writeFileSync(envTemplatePath, "FEISHU_APP_ID=\n", "utf8");
  return {
    root,
    home,
    options: {
      env: { AGENT_BOT_HOME: home, AGENT_BOT_CONFIG: "" },
      configTemplatePath,
      envTemplatePath,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
