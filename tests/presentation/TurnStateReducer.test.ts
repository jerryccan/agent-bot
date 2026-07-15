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
});
