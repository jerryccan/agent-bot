import { describe, expect, test } from "vitest";
import {
  cliText,
  controlFailureMessage,
  detectCliLanguage,
  localizeCliErrorMessage,
} from "../../src/cli/i18n.js";

describe("CLI language", () => {
  test.each(["zh", "zh-CN", "zh_TW", "zh-Hans-CN"])("detects Chinese locale %s", (locale) => {
    expect(detectCliLanguage(locale)).toBe("zh");
  });

  test.each(["en", "en-US", "fr-FR", "ja-JP", "C", ""])("falls back to English for %s", (locale) => {
    expect(detectCliLanguage(locale)).toBe("en");
  });

  test("selects text for the requested language", () => {
    expect(cliText("Server", "服务", "en")).toBe("Server");
    expect(cliText("Server", "服务", "zh")).toBe("服务");
  });

  test("localizes known configuration errors without changing English output", () => {
    const message = "Config file does not exist: D:/profile/config.yaml";
    expect(localizeCliErrorMessage(message, "en")).toBe(message);
    expect(localizeCliErrorMessage(message, "zh")).toBe(
      "配置文件不存在：D:/profile/config.yaml",
    );
  });

  test("preserves actionable control errors regardless of the CLI language", () => {
    const message = "这个任务已关联飞书会话，不能重复创建群。";
    expect(controlFailureMessage(message, "en")).toBe(message);
    expect(controlFailureMessage(`  ${message}  `, "zh")).toBe(message);
  });

  test("localizes the generic control error when the server provides no detail", () => {
    expect(controlFailureMessage(undefined, "en")).toBe(
      "Agent Bot control operation failed. Check the server logs for details.",
    );
    expect(controlFailureMessage("   ", "zh")).toBe(
      "Agent Bot 控制操作失败，请查看服务日志了解详情。",
    );
  });
});
