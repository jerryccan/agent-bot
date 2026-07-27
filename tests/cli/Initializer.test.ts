import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { initializeAgentBot } from "../../src/cli/Initializer.js";

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
