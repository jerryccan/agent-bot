import { describe, expect, test } from "vitest";
import { mapCodexNotification } from "../../src/codex/CodexEventMapper.js";

describe("mapCodexNotification", () => {
  test("preserves assistant message item ids and commentary phases", () => {
    expect(
      mapCodexNotification("item/started", {
        threadId: "thr_1",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "message_1", text: "", phase: "commentary" },
      }),
    ).toEqual({
      kind: "agent_message_phase",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "message_1",
      phase: "commentary",
    });
    expect(
      mapCodexNotification("item/agentMessage/delta", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "message_1",
        delta: "先检查官方文档",
      }),
    ).toEqual({
      kind: "agent_delta",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "message_1",
      text: "先检查官方文档",
    });
  });

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

  test("maps image view lifecycle using the notification phase", () => {
    const item = {
      type: "imageView",
      id: "image_1",
      path: "D:\\dev\\acp-bot\\.tmp\\monitor-1.png",
    };

    expect(mapCodexNotification("item/started", { threadId: "thr_1", turnId: "turn_1", item })).toEqual({
      kind: "tool",
      phase: "started",
      threadId: "thr_1",
      turnId: "turn_1",
      tool: expect.objectContaining({
        id: "image_1",
        kind: "image_view",
        status: "running",
        command: "view_image D:\\dev\\acp-bot\\.tmp\\monitor-1.png",
      }),
    });
    expect(mapCodexNotification("item/completed", { threadId: "thr_1", turnId: "turn_1", item })).toEqual({
      kind: "tool",
      phase: "updated",
      threadId: "thr_1",
      turnId: "turn_1",
      tool: expect.objectContaining({
        id: "image_1",
        kind: "image_view",
        status: "completed",
        command: "view_image D:\\dev\\acp-bot\\.tmp\\monitor-1.png",
      }),
    });
  });

  test("preserves MCP and dynamic tool arguments and successful results", () => {
    const mcp = mapCodexNotification("item/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "mcpToolCall",
        id: "mcp_1",
        server: "lark",
        tool: "search",
        status: "completed",
        arguments: { query: "Codex" },
        result: { content: [{ type: "text", text: "found" }], structuredContent: { total: 1 } },
      },
    });
    const dynamic = mapCodexNotification("item/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      item: {
        type: "dynamicToolCall",
        id: "dynamic_1",
        tool: "inspect",
        status: "completed",
        arguments: { path: "a.png" },
        contentItems: [{ type: "inputText", text: "image inspected" }],
      },
    });

    expect(mcp).toEqual(expect.objectContaining({
      kind: "tool",
      tool: expect.objectContaining({
        command: expect.stringContaining('"query": "Codex"'),
        output: expect.stringContaining('"text": "found"'),
      }),
    }));
    expect(dynamic).toEqual(expect.objectContaining({
      kind: "tool",
      tool: expect.objectContaining({
        command: expect.stringContaining('"path": "a.png"'),
        output: expect.stringContaining('"text": "image inspected"'),
      }),
    }));
  });

  test("maps reasoning summary deltas with a stable activity id", () => {
    expect(
      mapCodexNotification("item/reasoning/summaryTextDelta", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "reason_1",
        summaryIndex: 2,
        delta: "正在分析调用链",
      }),
    ).toEqual({
      kind: "progress",
      threadId: "thr_1",
      turnId: "turn_1",
      activityId: "reasoning:reason_1:2",
      text: "正在分析调用链",
      append: true,
    });
  });

  test("does not expose raw reasoning text deltas", () => {
    expect(
      mapCodexNotification("item/reasoning/textDelta", {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "reason_1",
        contentIndex: 0,
        delta: "private raw reasoning",
      }),
    ).toBeUndefined();
  });
});
