import { describe, expect, test } from "vitest";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";

function collectObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectObjects);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectObjects)];
}

function state(): TurnViewState {
  const completed = {
    id: "ok",
    title: "npm test",
    kind: "command",
    status: "completed" as const,
    command: "npm test",
    output: "\u001b[32mall passed\u001b[0m",
    exitCode: 0,
  };
  const failed = {
    id: "bad",
    title: "npm run lint",
    kind: "command",
    status: "failed" as const,
    command: "npm run lint",
    error: "命令失败",
    exitCode: 1,
  };
  return {
    sessionId: "s1",
    turnId: "turn_1",
    status: "running",
    startedAt: 1_000,
    durationMs: 51_600,
    progressText: "正在运行测试",
    assistantText: "",
    plan: [{ text: "执行测试", status: "in_progress" }],
    activities: [
      { kind: "reasoning", id: "reasoning:r1:0", text: "先检查测试配置" },
      { kind: "tool", id: "ok", tool: completed },
      { kind: "reasoning", id: "reasoning:r2:0", text: "再检查代码风格" },
      { kind: "tool", id: "bad", tool: failed },
    ],
    completedTools: [completed],
    failedTools: [failed],
    fileSummary: [{ path: "src/index.ts", additions: 5, deletions: 2 }],
  };
}

describe("CardRenderer", () => {
  test("renders a callback-free startup status card with resumable task state", () => {
    const card = new CardRenderer().renderStartupStatus({
      startedAt: new Date("2026-07-15T05:45:00.000Z"),
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      cwd: "D:\\dev\\acp-bot",
      currentTask: {
        id: "sess_1",
        agentName: "codex",
        sessionStatus: "running",
        lastTurnStatus: "running",
      },
    });
    const serialized = JSON.stringify(card);
    const objects = collectObjects(card);

    expect(serialized).toContain("acp-bot 已启动");
    expect(serialized).toContain("在线");
    expect(serialized).toContain("Codex");
    expect(serialized).toContain("D:\\\\dev\\\\acp-bot");
    expect(serialized).toContain("sess_1");
    expect(serialized).toContain("下一条消息时恢复");
    expect(serialized).toContain("/new");
    expect(serialized).toContain("/status");
    expect(objects.filter((item) => item.tag === "button" || item.tag === "action")).toHaveLength(0);
  });

  test("renders visible reasoning and one collapsed panel per tool in chronological order", () => {
    const card = new CardRenderer().renderTurn(state());
    const objects = collectObjects(card);
    const panels = objects.filter((item) => item.tag === "collapsible_panel");
    const toolPanels = panels.filter((panel) => !panelTitle(panel).startsWith("文件变更"));
    const serialized = JSON.stringify(card);
    const markdownContents = objects
      .filter((item) => item.tag === "markdown")
      .map((item) => String(item.content ?? ""))
      .join("\n");
    const topLevel = ((card as { elements: unknown[] }).elements).map((element) => JSON.stringify(element));
    const activityOrder = ["先检查测试配置", "npm test", "再检查代码风格", "npm run lint"].map((text) =>
      topLevel.findIndex((element) => element.includes(text)),
    );

    expect(toolPanels).toHaveLength(2);
    expect(toolPanels.every((panel) => panel.expanded === false)).toBe(true);
    const completedPanel = toolPanels.find((panel) => panelTitle(panel).includes("npm test"));
    const detailElements = (completedPanel?.elements ?? []) as Array<{ content?: string }>;
    expect(detailElements).toHaveLength(1);
    expect(detailElements[0]?.content).toBe("```\n$ npm test\nall passed\n```");
    expect(activityOrder).toEqual([...activityOrder].sort((left, right) => left - right));
    expect(new Set(activityOrder).size).toBe(4);
    expect(markdownContents).toContain("耗时：51.6s");
    expect(markdownContents).toContain("先检查测试配置");
    expect(markdownContents).toContain("```\n$ npm test\nall passed\n```");
    expect(markdownContents).toContain("```\n$ npm run lint\n命令失败\n```");
    for (const label of [
      "**状态**",
      "**耗时**",
      "**💭 思考**",
      "**工具**",
      "**命令**",
      "**退出码**",
      "**结果摘要**",
      "**错误摘要**",
    ]) {
      expect(markdownContents).not.toContain(label);
    }
    expect(markdownContents).not.toContain("\u001b");
    expect(markdownContents).not.toContain("完整内容请查看本地日志");
    expect(serialized).not.toContain("turn_details");
    expect(serialized).not.toContain("查看详情");
    expect(serialized).not.toContain("turn_cancel");
    expect(serialized).not.toContain("已完成的工具（");
    expect(serialized).not.toContain("失败的工具（");
    expect(serialized).not.toContain("/cancel");
  });

  test("uses a compact trailing ellipsis in long tool headers", () => {
    const running = state();
    const command = `Get-Content ${"x".repeat(150)}`;
    const active = { id: "long", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: active.id, tool: active }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel");

    expect(panelTitle(panel ?? {})).toMatch(/\.\.\.$/);
    expect(panelTitle(panel ?? {})).not.toContain("已截断");
  });

  test("shows the active tool prominently and uses a completed header on completion", () => {
    const running = state();
    running.activeTool = { id: "active", title: "查看仓库", kind: "command", status: "running", command: "rg --files" };
    running.activities.push({ kind: "tool", id: "active", tool: running.activeTool });
    expect(JSON.stringify(new CardRenderer().renderTurn(running))).toContain("查看仓库");

    const completed = { ...state(), status: "completed" as const, completedAt: 4_000, durationMs: 3_000 };
    expect(JSON.stringify(new CardRenderer().renderTurn(completed))).toContain("已完成");
  });
});

function panelTitle(panel: Record<string, unknown>): string {
  const header = panel.header as { title?: { content?: string } } | undefined;
  return header?.title?.content ?? "";
}
