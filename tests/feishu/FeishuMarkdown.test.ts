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

  test("includes Windows local file line references in link labels", () => {
    const markdown = "见 [app_controller_mac.mm](/D:/dev/lark2/aha/chrome/browser/app_controller_mac.mm:536)。";

    expect(normalizeFeishuMarkdown(markdown)).toBe(
      "见 [app_controller_mac.mm:536](/D:/dev/lark2/aha/chrome/browser/app_controller_mac.mm:536)。",
    );
  });

  test("includes line and column references for local file links across platforms", () => {
    const markdown = [
      "[worker.ts](/home/user/project/worker.ts:42:7)",
      "[worker.ts](file:///D:/project/worker.ts:42)",
      "[worker.ts](D:\\project\\worker.ts:42)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe([
      "[worker.ts:42:7](/home/user/project/worker.ts:42:7)",
      "[worker.ts:42](file:///D:/project/worker.ts:42)",
      "[worker.ts:42](D:\\project\\worker.ts:42)",
    ].join("\n"));
  });

  test("does not duplicate references or rewrite web links, images, or fenced code", () => {
    const markdown = [
      "[worker.ts:42](/D:/project/worker.ts:42)",
      "[service](https://example.com/service:42)",
      "![diagram](/D:/project/diagram.png:42)",
      "```markdown",
      "[worker.ts](/D:/project/worker.ts:42)",
      "```",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe(markdown);
  });
});
