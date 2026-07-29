import { describe, expect, test } from "vitest";
import { renderCliHelp, resolveCliLanguage } from "../../src/cli/help.js";

describe("CLI help", () => {
  test("selects Chinese from locale environment variables", () => {
    expect(resolveCliLanguage({ LANG: "zh_CN.UTF-8" }, "en-US")).toBe("zh");
    expect(resolveCliLanguage({ LC_ALL: "zh-TW", LANG: "en_US.UTF-8" }, "en-US")).toBe("zh");
  });

  test("uses English for non-Chinese and fallback locales", () => {
    expect(resolveCliLanguage({ LANG: "en_US.UTF-8" }, "zh-CN")).toBe("en");
    expect(resolveCliLanguage({}, "de-DE")).toBe("en");
  });

  test("renders concise Chinese help with common commands", () => {
    const help = renderCliHelp("1.2.3", "zh");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("用法：");
    expect(help).toContain("常用命令：");
    expect(help).toContain("agent-bot [选项] <命令>");
    expect(help).toContain("server restart");
    expect(help).toContain("task prompt <task> <prompt>");
    expect(help).toContain("-v, --version");
    expect(help).not.toContain("Usage:");
  });

  test("renders concise English help with common commands", () => {
    const help = renderCliHelp("1.2.3", "en");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("Usage:");
    expect(help).toContain("Common commands:");
    expect(help).toContain("agent-bot [options] <command>");
    expect(help).toContain("server restart");
    expect(help).toContain("task prompt <task> <prompt>");
    expect(help).toContain("-h, --help");
    expect(help).not.toContain("用法：");
  });
});
