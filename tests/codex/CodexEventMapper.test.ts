import { describe, expect, test } from "vitest";
import { mapCodexNotification } from "../../src/codex/CodexEventMapper.js";

describe("mapCodexNotification", () => {
  test("maps plan updates", () => {
    expect(
      mapCodexNotification("turn/plan/updated", {
        threadId: "thr_1",
        turnId: "turn_1",
        plan: [
          { step: "inspect", status: "completed" },
          { step: "fix", status: "inProgress" },
        ],
      }),
    ).toEqual({
      kind: "plan",
      threadId: "thr_1",
      turnId: "turn_1",
      steps: [
        { text: "inspect", status: "completed" },
        { text: "fix", status: "in_progress" },
      ],
    });
  });

  test("maps command lifecycle items", () => {
    expect(
      mapCodexNotification("item/completed", {
        threadId: "thr_1",
        turnId: "turn_1",
        completedAtMs: 2000,
        item: {
          type: "commandExecution",
          id: "item_1",
          command: "npm test",
          status: "completed",
          aggregatedOutput: "11 passed",
          exitCode: 0,
          durationMs: 900,
        },
      }),
    ).toEqual({
      kind: "tool",
      phase: "updated",
      threadId: "thr_1",
      turnId: "turn_1",
      tool: expect.objectContaining({
        id: "item_1",
        title: "npm test",
        command: "npm test",
        status: "completed",
        exitCode: 0,
        output: "11 passed",
      }),
    });
  });
});
