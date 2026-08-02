import { describe, expect, test } from "vitest";
import { renderCliHelp } from "../../src/cli/help.js";

describe("CLI help", () => {
  test("renders concise English help with common commands", () => {
    const help = renderCliHelp("1.2.3", "en");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("Usage:");
    expect(help).toContain("Common commands:");
    expect(help).toContain("agentbot [options] <command>");
    expect(help).toContain("Initialize the Lark app and start the service");
    expect(help).toContain("init --reset");
    expect(help).toContain("Back up and reset the selected explicit profile");
    expect(help).toContain("agentbot --profile ~/.agent-bot init --reset");
    expect(help).toContain("Show the server, Lark App ID, and safe-restart status");
    expect(help).toContain("task prompt <task> <prompt>");
    expect(help).toContain("-h, --help");
    expect(help).not.toMatch(/[一-龥]/u);
  });

  test("renders Chinese help for a Chinese system language", () => {
    const help = renderCliHelp("1.2.3", "zh");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("用法：");
    expect(help).toContain("常用命令：");
    expect(help).toContain("agentbot [选项] <命令>");
    expect(help).toContain("初始化飞书应用并启动服务");
    expect(help).toContain("显示服务、飞书 App ID 和安全重启状态");
    expect(help).toContain("task prompt <任务> <提示词>");
  });
});
