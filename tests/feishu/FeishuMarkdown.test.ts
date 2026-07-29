import { describe, expect, test } from "vitest";
import { normalizeFeishuMarkdown } from "../../src/feishu/FeishuMarkdown.js";

describe("normalizeFeishuMarkdown", () => {
  test("moves fenced code blocks nested under list items to the top level", () => {
    const markdown = [
      "1. Actor 错误全部转为：",
      "",
      "   ```cpp",
      "   BuaRendererActionError::kActionFailed",
      "   ```",
      "",
      "2. 最终统一生成：",
      "",
      "   ```json",
      "   {",
      "     \"code\": \"action_failed\"",
      "   }",
      "   ```",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe([
      "1. Actor 错误全部转为：",
      "",
      "```cpp",
      "BuaRendererActionError::kActionFailed",
      "```",
      "",
      "2. 最终统一生成：",
      "",
      "```json",
      "{",
      "  \"code\": \"action_failed\"",
      "}",
      "```",
    ].join("\n"));
  });

  test("leaves top-level fences and their contents unchanged", () => {
    const markdown = [
      "```text",
      "   ```this is code, not a nested fence",
      "value",
      "```",
    ].join("\r\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe(markdown);
  });
});
