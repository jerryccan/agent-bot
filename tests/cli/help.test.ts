import { describe, expect, test } from "vitest";
import { renderCliHelp } from "../../src/cli/help.js";

describe("CLI help", () => {
  test("renders concise English help with common commands", () => {
    const help = renderCliHelp("1.2.3", "en");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("Usage:");
    expect(help).toContain("Common commands:");
    expect(help).toContain("server restart [--task <task>]");
    expect(help).toContain("Return safe-restart status");
    expect(help).toContain("agentbot [options] <command>");
    expect(help).toContain("Codex, TraeX, and compatible ACP agents");
    expect(help).toContain("Check and configure Agents; initialize the Lark app and service");
    expect(help).toContain("init --reset");
    expect(help).toContain("Back up and reset the selected explicit profile");
    expect(help).toContain("agentbot --profile ~/.agent-bot init --reset");
    expect(help).toContain("Show the server, Lark App ID, Agent processes, and safe-restart status");
    expect(help).toContain("task prompt <task> <prompt>");
    expect(help).toContain("task current [--json]");
    expect(help).toContain("Show details for the task invoking the CLI");
    expect(help).toContain("task newgroup <task> [title]");
    expect(help).toContain("supports --agent, --dir, --nodir");
    expect(help).toContain("task forkgroup <task> [title]");
    expect(help).toContain("-h, --help");
    expect(help).not.toMatch(/[一-龥]/u);
  });

  test("renders Chinese help for a Chinese system language", () => {
    const help = renderCliHelp("1.2.3", "zh");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("用法：");
    expect(help).toContain("常用命令：");
    expect(help).toContain("server restart [--task <任务>]");
    expect(help).toContain("将安全重启状态发回任务所在会话");
    expect(help).toContain("agentbot [选项] <命令>");
    expect(help).toContain("Codex、TraeX 和兼容 ACP 的 Agent");
    expect(help).toContain("检查并配置 Agent，初始化飞书应用和服务");
    expect(help).toContain("显示服务、飞书 App ID、Agent 进程和安全重启状态");
    expect(help).toContain("task prompt <任务> <提示词>");
    expect(help).toContain("task current [--json]");
    expect(help).toContain("显示当前调用任务的详情");
    expect(help).toContain("task newgroup <任务> [标题]");
    expect(help).toContain("支持 --agent、--dir、--nodir");
    expect(help).toContain("task forkgroup <任务> [标题]");
  });
});
