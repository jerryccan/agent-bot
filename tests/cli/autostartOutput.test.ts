import { describe, expect, test } from "vitest";
import { formatAutostartStatus } from "../../src/cli/autostartOutput.js";

describe("autostart status output", () => {
  test("shows registration and live server state in English", () => {
    const output = formatAutostartStatus({
      registration: {
        supported: true,
        platform: "linux",
        profilePath: "/home/tester/.agent-bot",
        configPath: "/home/tester/.agent-bot/config.yaml",
        enabled: true,
        loaded: false,
        linger: true,
        name: "agent-bot-test.service",
        definitionPath: "/home/tester/.config/systemd/user/agent-bot-test.service",
        trigger: "boot",
        mechanism: "systemd",
      },
      server: { running: true, ready: true },
    }, "en");

    expect(output).toContain("Agent Bot autostart: enabled");
    expect(output).toContain("Trigger: system boot (systemd linger enabled)");
    expect(output).toContain("Loaded by OS: no");
    expect(output).toContain("Mechanism: systemd");
    expect(output).toContain("Agent Bot server: running");
  });

  test("shows unsupported platforms and stopped service in Chinese", () => {
    const output = formatAutostartStatus({
      registration: {
        supported: false,
        platform: "freebsd",
        profilePath: "/home/tester/.agent-bot",
        configPath: "/home/tester/.agent-bot/config.yaml",
        enabled: false,
      },
      server: { running: false, ready: false },
    }, "zh");

    expect(output).toContain("Agent Bot 自启动：不支持");
    expect(output).toContain("freebsd（不支持）");
    expect(output).toContain("Agent Bot 服务：未运行");
  });
});
