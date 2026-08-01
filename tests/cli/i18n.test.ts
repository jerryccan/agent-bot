import { describe, expect, test } from "vitest";
import {
  cliText,
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
});
