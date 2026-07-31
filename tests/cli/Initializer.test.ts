import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  acquireInitializationLock,
  cleanupFeishuCredentialTemporaryFiles,
  initializeAgentBot,
  readFeishuCredentials,
  shouldCreateFeishuApp,
  writeFeishuCredentials,
} from "../../src/cli/Initializer.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
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
    fs.writeFileSync(path.join(fixture.home, "config.yaml"), "user config\n", "utf8");
    fs.writeFileSync(path.join(fixture.home, ".env"), "USER_VALUE=1\n", "utf8");

    const result = initializeAgentBot(fixture.options);

    expect(result.config.status).toBe("existing");
    expect(result.env.status).toBe("existing");
    expect(result.data.status).toBe("existing");
    expect(result.logs.status).toBe("existing");
    expect(fs.readFileSync(result.config.path, "utf8")).toBe("user config\n");
    expect(fs.readFileSync(result.env.path, "utf8")).toBe("USER_VALUE=1\n");
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

    expect(() => acquireInitializationLock(dataDirectory)).toThrow("Another agent-bot init process is running");
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
