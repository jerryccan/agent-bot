import { describe, expect, test } from "vitest";
import {
  formatServerStatus,
  withConfiguredFeishuAppId,
} from "../../src/cli/serverStatus.js";

describe("server status output", () => {
  test("includes the running server's Lark App ID in English output", () => {
    const status = withConfiguredFeishuAppId({
      ready: true,
      feishuAppId: "cli_running",
      pid: 42,
      supervised: true,
      safeRestartScheduled: false,
      activity: {
        runningSessions: 2,
        pendingFinalDeliveries: 1,
      },
    }, "cli_configured");

    expect(status.feishuAppId).toBe("cli_running");
    expect(formatServerStatus(status, "en")).toBe([
      "Agent Bot server: running",
      "Lark App ID: cli_running",
      "PID: 42",
      "Started at: -",
      "Supervisor: enabled",
      "Running tasks: 2",
      "Pending final deliveries: 1",
      "Safe restart: not scheduled",
      "",
    ].join("\n"));
  });

  test("falls back to the selected profile App ID for older or stopped servers", () => {
    expect(withConfiguredFeishuAppId({ running: false }, "cli_profile")).toEqual({
      running: false,
      feishuAppId: "cli_profile",
    });
    expect(formatServerStatus({
      running: false,
      feishuAppId: "cli_profile",
    }, "en")).toContain("Lark App ID: cli_profile");
  });

  test("renders Chinese labels and states", () => {
    const output = formatServerStatus({
      ready: false,
      feishuAppId: "cli_profile",
      supervised: true,
      safeRestartScheduled: false,
    }, "zh");

    expect(output).toContain("Agent Bot 服务：正在启动（连接飞书中）");
    expect(output).toContain("飞书 App ID：cli_profile");
    expect(output).toContain("Supervisor：已启用");
    expect(output).toContain("安全重启：未计划");
  });
});
