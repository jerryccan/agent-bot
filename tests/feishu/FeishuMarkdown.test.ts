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

  test("shows complete paths for files outside the current project", () => {
    const markdown = [
      "[controller.ts](D:\\dev\\agent-bot\\src\\controller.ts:42)",
      "[runner.py](C:\\Users\\Admin\\sandbox_runtime\\runner.py:122)",
      "[cache.cc](/D:/dev/another-project/sandbox_env_cache.cc:490)",
      "[cell.py](file:///C:/Users/Admin/runtime/cell.py:248)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown, "D:\\dev\\agent-bot")).toBe([
      "[controller.ts:42](D:\\dev\\agent-bot\\src\\controller.ts:42)",
      "runner.py(`C:\\Users\\Admin\\sandbox_runtime\\runner.py:122`)",
      "cache.cc(`D:\\dev\\another-project\\sandbox_env_cache.cc:490`)",
      "cell.py(`C:\\Users\\Admin\\runtime\\cell.py:248`)",
    ].join("\n"));
  });

  test("shows file names for local file links inside a Windows project", () => {
    const markdown = [
      "[app.ts](D:\\dev\\agent-bot\\src\\app.ts:12)",
      "[index.ts](/D:/dev/agent-bot/src/index.ts:18)",
      "[README.md](D:\\dev\\agent-bot\\README.md:7)",
      "[转换后的 Trace Markdown](D:/dev/agent-bot/.cache/runs/moa-trace.execution-timeline.md)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown, "D:\\dev\\agent-bot")).toBe([
      "[app.ts:12](D:\\dev\\agent-bot\\src\\app.ts:12)",
      "[index.ts:18](/D:/dev/agent-bot/src/index.ts:18)",
      "[README.md:7](D:\\dev\\agent-bot\\README.md:7)",
      "转换后的 Trace Markdown(`moa-trace.execution-timeline.md`)",
    ].join("\n"));
  });

  test("shows complete POSIX paths only outside the current project", () => {
    const markdown = [
      "[worker.ts](/home/user/project/src/worker.ts:12)",
      "[cell.py](/home/user/project/runtime/cell.py:248)",
      "[shared.ts](/opt/shared/shared.ts:7)",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown, "/home/user/project")).toBe([
      "[worker.ts:12](/home/user/project/src/worker.ts:12)",
      "[cell.py:248](/home/user/project/runtime/cell.py:248)",
      "shared.ts(`/opt/shared/shared.ts:7`)",
    ].join("\n"));
  });

  test("does not append the visible local path more than once", () => {
    const markdown = "[转换后的 Trace Markdown](D:/dev/agent-bot/output.md)";
    const normalized = normalizeFeishuMarkdown(markdown, "D:\\dev\\agent-bot");

    expect(normalized).toBe("转换后的 Trace Markdown(`output.md`)");
    expect(normalizeFeishuMarkdown(normalized, "D:\\dev\\agent-bot")).toBe(normalized);
  });

  test("does not duplicate references or rewrite web links, images, or fenced code", () => {
    const markdown = [
      "[worker.ts:42](/D:/project/worker.ts:42)",
      "[service](https://example.com/service:42)",
      "[screenshot](/D:/project/screenshot.png)",
      "![diagram](/D:/project/diagram.png:42)",
      "```markdown",
      "[worker.ts](/D:/project/worker.ts:42)",
      "```",
    ].join("\n");

    expect(normalizeFeishuMarkdown(markdown)).toBe(markdown);
  });
});
