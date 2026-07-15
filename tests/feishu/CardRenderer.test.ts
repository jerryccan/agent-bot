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
  return {
    sessionId: "s1",
    turnId: "turn_1",
    status: "running",
    startedAt: 1_000,
    progressText: "正在运行测试",
    assistantText: "",
    plan: [{ text: "执行测试", status: "in_progress" }],
    completedTools: [{ id: "ok", title: "npm test", kind: "command", status: "completed", output: "all passed" }],
    failedTools: [{ id: "bad", title: "npm run lint", kind: "command", status: "failed", error: "命令失败" }],
    fileSummary: [{ path: "src/index.ts", additions: 5, deletions: 2 }],
  };
}

describe("CardRenderer", () => {
  test("keeps tool details inside native panels without a callback-only details action", () => {
    const card = new CardRenderer().renderTurn(state());
    const objects = collectObjects(card);
    const panels = objects.filter((item) => item.tag === "collapsible_panel");
    const serialized = JSON.stringify(card);

    expect(panels).toEqual(expect.arrayContaining([expect.objectContaining({ expanded: false }), expect.objectContaining({ expanded: true })]));
    expect(serialized).toContain("命令失败");
    expect(serialized).toContain("命令");
    expect(serialized).toContain("npm test");
    expect(serialized).toContain("结果摘要");
    expect(serialized).toContain("all passed");
    expect(serialized).not.toContain("turn_details");
    expect(serialized).not.toContain("查看详情");
  });

  test("shows the active tool prominently and uses a completed header on completion", () => {
    const running = state();
    running.activeTool = { id: "active", title: "查看仓库", kind: "command", status: "running", command: "rg --files" };
    expect(JSON.stringify(new CardRenderer().renderTurn(running))).toContain("查看仓库");

    const completed = { ...state(), status: "completed" as const, completedAt: 4_000, durationMs: 3_000 };
    expect(JSON.stringify(new CardRenderer().renderTurn(completed))).toContain("已完成");
  });
});
