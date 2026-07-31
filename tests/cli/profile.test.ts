import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  applyExplicitProfile,
  parseGlobalOptions,
} from "../../src/cli/profile.js";
import { AGENT_BOT_EXPLICIT_PROFILE_ENV } from "../../src/config/paths.js";

describe("CLI profiles", () => {
  test("extracts an explicit profile directory from any global position", () => {
    expect(parseGlobalOptions(["server", "--profile", "~/.agent-bot-rescue", "status"])).toEqual({
      args: ["server", "status"],
      profilePath: "~/.agent-bot-rescue",
    });
  });

  test("keeps the existing config option for non-profile use", () => {
    expect(parseGlobalOptions(["--config", "./custom.yaml", "task", "list"])).toEqual({
      args: ["task", "list"],
      configPath: "./custom.yaml",
    });
  });

  test("rejects ambiguous profile and config selection", () => {
    expect(() => parseGlobalOptions([
      "--profile",
      "./rescue",
      "--config",
      "./custom.yaml",
      "server",
      "status",
    ])).toThrow("--profile and --config cannot be used together");
  });

  test("rejects duplicate or missing profile paths", () => {
    expect(() => parseGlobalOptions(["--profile", "one", "--profile", "two", "server"]))
      .toThrow("--profile can only be specified once");
    expect(() => parseGlobalOptions(["server", "--profile", "--json"]))
      .toThrow("--profile requires a directory or file path");
  });

  test("pins home and config to the selected profile directory", () => {
    const env: NodeJS.ProcessEnv = {
      AGENT_BOT_HOME: path.join(os.tmpdir(), "old-home"),
      AGENT_BOT_CONFIG: path.join(os.tmpdir(), "old-config.yaml"),
      FEISHU_APP_ID: "primary-app",
      FEISHU_APP_SECRET: "primary-secret",
      FEISHU_USER_OPEN_ID: "primary-user",
    };
    const applied = applyExplicitProfile("./rescue", env, path.join(os.tmpdir(), "agent-bot-test"));

    expect(applied.homePath).toBe(path.join(os.tmpdir(), "agent-bot-test", "rescue"));
    expect(applied.configPath).toBe(path.join(applied.homePath, "config.yaml"));
    expect(env.AGENT_BOT_HOME).toBe(applied.homePath);
    expect(env.AGENT_BOT_CONFIG).toBe(applied.configPath);
    expect(env[AGENT_BOT_EXPLICIT_PROFILE_ENV]).toBe("1");
    expect(env.FEISHU_APP_ID).toBeUndefined();
    expect(env.FEISHU_APP_SECRET).toBeUndefined();
    expect(env.FEISHU_USER_OPEN_ID).toBeUndefined();
  });
});
