import { describe, expect, test } from "vitest";
import { createTurnViewState, reduceTurnEvent } from "../../src/presentation/TurnStateReducer.js";
import type { AgentEvent, ToolState } from "../../src/runtime/types.js";

const tool = (id: string, title: string, status: ToolState["status"], extra: Partial<ToolState> = {}): ToolState => ({
  id,
  title,
  kind: "command",
  status,
  ...extra,
});

function event(type: AgentEvent["type"], fields: Record<string, unknown>): AgentEvent {
  return { type, sessionId: "s1", turnId: "turn_1", ...fields } as AgentEvent;
}

describe("TurnStateReducer", () => {
  test("keeps the active tool visible and moves successful tools to bounded history", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, event("tool_started", { tool: tool("t1", "npm test", "running") }));
    expect(state.activeTool?.title).toBe("npm test");

    state = reduceTurnEvent(
      state,
      event("tool_updated", { tool: tool("t1", "npm test", "completed", { output: "ok", completedAt: 2_000 }) }),
    );
    expect(state.activeTool).toBeUndefined();
    expect(state.completedTools).toHaveLength(1);
    expect(state.completedTools[0]?.output).toBe("ok");

    for (let index = 2; index <= 25; index += 1) {
      state = reduceTurnEvent(state, event("tool_updated", { tool: tool(`t${index}`, `tool ${index}`, "completed") }));
    }
    expect(state.completedTools).toHaveLength(20);
    expect(state.completedTools[0]?.id).toBe("t6");
  });

  test("keeps failed tools separate and records plans, files, progress, and completion", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(
      state,
      event("plan_updated", {
        steps: [
          { text: "Inspect", status: "completed" },
          { text: "Implement", status: "in_progress" },
        ],
      }),
    );
    state = reduceTurnEvent(state, event("progress", { text: "正在分析调用链" }));
    state = reduceTurnEvent(
      state,
      event("tool_updated", {
        tool: tool("f1", "修改文件", "failed", {
          error: "permission denied",
          files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
        }),
      }),
    );
    state = reduceTurnEvent(state, event("turn_completed", { finalResponse: "done", durationMs: 2_500 }));

    expect(state.plan[1]).toMatchObject({ text: "Implement", status: "in_progress" });
    expect(state.progressText).toBe("正在分析调用链");
    expect(state.failedTools).toHaveLength(1);
    expect(state.fileSummary).toEqual([{ path: "src/index.ts", additions: 3, deletions: 1 }]);
    expect(state).toMatchObject({ status: "completed", finalResponse: "done", durationMs: 2_500 });
  });

  test("ignores events belonging to another turn and bounds verbose fields", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(state, {
      type: "progress",
      sessionId: "s1",
      turnId: "another",
      text: "ignore me",
    });
    expect(state.progressText).toBeUndefined();

    state = reduceTurnEvent(state, event("progress", { text: "x".repeat(7_000) }));
    expect(state.progressText?.length).toBeLessThanOrEqual(6_000);
  });

  test("preserves reasoning and tool activity order while updating entries in place", () => {
    let state = createTurnViewState("s1", "turn_1", 1_000);
    state = reduceTurnEvent(
      state,
      event("progress", { activityId: "reasoning:r1:0", text: "分析仓库", append: true }),
    );
    state = reduceTurnEvent(state, event("tool_started", { tool: tool("t1", "rg --files", "running") }));
    state = reduceTurnEvent(
      state,
      event("tool_updated", { tool: tool("t1", "rg --files", "completed", { output: "a.ts" }) }),
    );
    state = reduceTurnEvent(
      state,
      event("progress", { activityId: "reasoning:r2:0", text: "准备测试", append: true }),
    );
    state = reduceTurnEvent(state, event("tool_started", { tool: tool("t2", "npm test", "running") }));
    state = reduceTurnEvent(
      state,
      event("progress", { activityId: "reasoning:r1:0", text: "并定位入口", append: true }),
    );

    expect(state.activities.map((activity) => activity.id)).toEqual([
      "reasoning:r1:0",
      "t1",
      "reasoning:r2:0",
      "t2",
    ]);
    expect(state.activities[0]).toEqual({
      kind: "reasoning",
      id: "reasoning:r1:0",
      text: "分析仓库并定位入口",
    });
    expect(state.activities[1]).toMatchObject({
      kind: "tool",
      id: "t1",
      tool: { status: "completed", output: "a.ts" },
    });
  });
});
