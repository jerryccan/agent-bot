import { describe, expect, test, vi } from "vitest";
import { FeishuTurnPresenter } from "../../src/feishu/FeishuTurnPresenter.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import type { AgentEvent } from "../../src/runtime/types.js";
import type { TurnPresentationStore } from "../../src/feishu/FeishuTurnPresenter.js";

function completed(finalResponse = "answer"): AgentEvent {
  return { type: "turn_completed", sessionId: "s1", turnId: "turn_1", finalResponse, durationMs: 1_000 };
}

function createFixture(delivered = false) {
  const outbound: FeishuOutbound = {
    sendText: vi.fn(async () => "text_1"),
    sendMarkdown: vi.fn(async () => "final_1"),
    sendInteractiveCard: vi.fn(async () => "progress_1"),
    replyMarkdown: vi.fn(async () => "thread_final_1"),
    replyInteractiveCard: vi.fn(async () => "thread_progress_1"),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
  const store = {
    saveTurnSnapshot: vi.fn(),
    getTurnSnapshot: vi.fn(),
    getTurnContextKey: vi.fn(),
    saveTurnDelivery: vi.fn(),
    saveFinalDeliveryProgress: vi.fn(),
    markFinalDelivered: vi.fn(),
    getTurnDelivery: vi.fn(() => (delivered ? { finalDelivered: true, finalMessageIds: ["old"] } : undefined)),
  };
  const presenter = new FeishuTurnPresenter(outbound, store, undefined, {
    normalIntervalMs: 1,
    criticalGapMs: 0,
  });
  presenter.registerSession("s1", "chat_id:c1", undefined, "D:\\dev\\agent-bot");
  return { presenter, outbound, store };
}

describe("FeishuTurnPresenter", () => {
  test("creates one progress card and delivers a duplicated completion once", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    await Promise.all([presenter.onEvent(completed()), presenter.onEvent(completed())]);

    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
    expect(store.markFinalDelivered).toHaveBeenCalledOnce();
    expect(store.markFinalDelivered).toHaveBeenCalledWith("turn_1", ["final_1"]);
    expect(store.saveTurnSnapshot).toHaveBeenCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({ projectCwd: "D:\\dev\\agent-bot" }),
      "chat_id:c1",
    );
  });

  test("reuses the immediate starting card when the real turn id arrives", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.startPendingTurn("s1", "chat_id:c1");
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(outbound.updateInteractiveCard).toHaveBeenCalled());
  });

  test("keeps a group turn progress card and final answer inside the triggering message thread", async () => {
    const { presenter, outbound, store } = createFixture();
    const target = { messageId: "om_question", replyInThread: true as const };

    await presenter.startPendingTurn("s1", "chat_id:c1", "Group question", target);
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent(completed("thread answer"));

    expect(outbound.replyInteractiveCard).toHaveBeenCalledWith(
      "chat_id:c1",
      target,
      expect.any(Object),
      expect.stringMatching(/^codex-progress-/),
    );
    expect(outbound.replyMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      target,
      "thread answer",
      expect.stringMatching(/^codex-final-/),
    );
    expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.sendMarkdown).not.toHaveBeenCalled();
    expect(store.saveTurnSnapshot).toHaveBeenCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({ replyTarget: target }),
      "chat_id:c1",
    );
  });

  test("updates the active card when Codex generates a new task title", async () => {
    const { presenter, outbound } = createFixture();
    presenter.registerSession("s1", "chat_id:c1", "Initial title");
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });

    presenter.updateSessionTitle("s1", "Generated title");
    await presenter.flushAll();

    expect(outbound.updateInteractiveCard).toHaveBeenCalledWith(
      "progress_1",
      expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({ content: "Codex 正在处理：Generated title" }),
        }),
      }),
    );
  });

  test("persists a steer message and updates the active thinking card", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });

    await presenter.appendSteerMessage("s1", "turn_1", "同时补充测试", "om_steer");
    await presenter.flushAll();

    expect(store.saveTurnSnapshot).toHaveBeenLastCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({
        activities: expect.arrayContaining([
          { kind: "user", id: "steer:om_steer", text: "同时补充测试" },
        ]),
      }),
      "chat_id:c1",
    );
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]))
      .toContain("💬 同时补充测试");
  });

  test("coalesces command output deltas into an incremental tool panel update", async () => {
    const { presenter, outbound, store } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await presenter.onEvent({
      type: "tool_started",
      sessionId: "s1",
      turnId: "turn_1",
      tool: { id: "command_1", title: "npm test", kind: "command", status: "running", command: "npm test" },
    });
    await presenter.flushAll();
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent({
      type: "tool_output_delta",
      sessionId: "s1",
      turnId: "turn_1",
      toolId: "command_1",
      delta: "test 1 passed\n",
    });
    await presenter.onEvent({
      type: "tool_output_delta",
      sessionId: "s1",
      turnId: "turn_1",
      toolId: "command_1",
      delta: "test 2 passed\n",
    });
    await presenter.flushAll();

    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1])).toContain(
      "test 1 passed\\ntest 2 passed",
    );
    expect(store.saveTurnSnapshot).toHaveBeenLastCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({ activeTool: expect.objectContaining({ output: "test 1 passed\ntest 2 passed\n" }) }),
      "chat_id:c1",
    );
  });

  test("freezes in-place history pages and resumes live updates on the latest page", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    for (let index = 1; index <= 45; index += 1) {
      await presenter.onEvent({
        type: "progress",
        sessionId: "s1",
        turnId: "turn_1",
        activityId: `reasoning:${index}`,
        text: `Activity ${index}`,
      });
    }
    await presenter.flushAll();
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.showActivityPage("chat_id:c1", "turn_1", 0, "progress_1");

    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    let rendered = JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(rendered).toContain("思考活动历史 · 1/2");
    expect(rendered).toContain("Activity 1");
    expect(rendered).not.toContain("Activity 45");
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent({
      type: "progress",
      sessionId: "s1",
      turnId: "turn_1",
      activityId: "reasoning:46",
      text: "Activity 46",
    });
    await presenter.flushAll();
    expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();

    await presenter.showActivityPage("chat_id:c1", "turn_1", "latest", "progress_1");
    expect(outbound.updateInteractiveCard).toHaveBeenCalledOnce();
    rendered = JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(rendered).toContain("Activity 46");
    expect(rendered).toContain("Codex 正在处理");
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent({
      type: "progress",
      sessionId: "s1",
      turnId: "turn_1",
      activityId: "reasoning:47",
      text: "Activity 47",
    });
    await presenter.flushAll();
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1])).toContain(
      "Activity 47",
    );
  });

  test("delivers a terminal answer without replacing the history page until latest is selected", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    for (let index = 1; index <= 41; index += 1) {
      await presenter.onEvent({
        type: "progress",
        sessionId: "s1",
        turnId: "turn_1",
        activityId: `reasoning:${index}`,
        text: `Activity ${index}`,
      });
    }
    await presenter.flushAll();
    await presenter.showActivityPage("chat_id:c1", "turn_1", 0, "progress_1");
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockClear();

    await presenter.onEvent(completed("terminal answer"));

    expect(outbound.updateInteractiveCard).not.toHaveBeenCalled();
    expect(outbound.sendMarkdown).toHaveBeenCalledWith(
      "chat_id:c1",
      "terminal answer",
      expect.stringMatching(/^codex-final-/),
    );

    await presenter.showActivityPage("chat_id:c1", "turn_1", "latest", "progress_1");
    expect(JSON.stringify((outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1])).toContain(
      "Codex 已完成",
    );
  });

  test("cleans up a failed starting card so a later prompt can retry", async () => {
    const { presenter, outbound } = createFixture();
    (outbound.sendInteractiveCard as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce("progress_2");
    await expect(presenter.startPendingTurn("s1", "chat_id:c1")).rejects.toThrow("network down");
    await expect(presenter.startPendingTurn("s1", "chat_id:c1")).resolves.toBeUndefined();
    expect(outbound.sendInteractiveCard).toHaveBeenCalledTimes(2);
  });

  test("delivers a rehydrated turn failure to its persisted group instead of the latest session context", async () => {
    const { presenter, outbound, store } = createFixture();
    const persisted = {
      sessionId: "s1",
      turnId: "turn_1",
      status: "running" as const,
      startedAt: Date.now() - 1_000,
      assistantText: "",
      plan: [],
      activities: [],
      totalToolCount: 0,
      completedToolCount: 0,
      failedToolCount: 0,
      toolStatuses: {},
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    };
    store.getTurnSnapshot.mockReturnValue(persisted);
    store.getTurnContextKey.mockReturnValue("chat_id:origin_group");
    presenter.registerSession("s1", "chat_id:current_private");

    await presenter.onEvent({
      type: "turn_failed",
      sessionId: "s1",
      turnId: "turn_1",
      message: "stream disconnected before completion",
    });

    expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(
      "chat_id:origin_group",
      expect.any(Object),
    );
    expect(store.saveTurnSnapshot).toHaveBeenLastCalledWith(
      "turn_1",
      "s1",
      expect.objectContaining({
        status: "failed",
        error: "stream disconnected before completion",
      }),
      "chat_id:origin_group",
    );
  });

  test("does not resend a final answer already recorded as delivered", async () => {
    const { presenter, outbound } = createFixture(true);
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    await presenter.onEvent(completed("historical answer"));
    expect(outbound.sendMarkdown).not.toHaveBeenCalled();
  });

  test("details are rendered from the saved snapshot without runtime history", async () => {
    const { presenter, outbound, store } = createFixture();
    store.getTurnSnapshot.mockReturnValue({
      sessionId: "s1",
      turnId: "turn_1",
      status: "completed",
      startedAt: 1,
      assistantText: "",
      plan: [],
      completedTools: [],
      failedTools: [],
      fileSummary: [],
    });
    await presenter.showDetails("chat_id:c1", "turn_1");
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
  });

  test("still sends the final answer when the terminal card update fails permanently", async () => {
    const { presenter, outbound } = createFixture();
    (outbound.updateInteractiveCard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bad card"));
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    await presenter.onEvent(completed());
    expect(outbound.sendMarkdown).toHaveBeenCalledOnce();
  });

  test("checkpoints final chunks and resumes only unsent chunks", async () => {
    const store = new MemoryStore();
    const firstOutbound = outboundWithMarkdown(
      vi.fn().mockResolvedValueOnce("part_1").mockRejectedValueOnce(new Error("permanent failure")),
    );
    const first = new FeishuTurnPresenter(firstOutbound, store, undefined, { finalChunkLength: 32, criticalGapMs: 0 });
    first.registerSession("s1", "chat_id:c1");
    await first.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() });
    await expect(first.onEvent(completed("x".repeat(50)))).rejects.toThrow("permanent failure");
    expect(store.getTurnDelivery("turn_1")?.finalMessageIds).toEqual(["part_1"]);
    expect((firstOutbound.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatch(/^codex-final-/);

    const secondSend = vi.fn().mockResolvedValue("part_2");
    const second = new FeishuTurnPresenter(outboundWithMarkdown(secondSend), store, undefined, { finalChunkLength: 32 });
    second.registerSession("s1", "chat_id:c1");
    await second.resumeDelivery("s1", "chat_id:c1", "turn_1");

    expect(secondSend).toHaveBeenCalledOnce();
    expect(store.getTurnDelivery("turn_1")).toMatchObject({ finalDelivered: true, finalMessageIds: ["part_1", "part_2"] });
  });
});

class MemoryStore implements TurnPresentationStore {
  private readonly snapshots = new Map<string, unknown>();
  private readonly contexts = new Map<string, string>();
  private readonly deliveries = new Map<string, { finalDelivered: boolean; finalMessageIds: string[] }>();
  saveTurnSnapshot(turnId: string, _sessionId: string, snapshot: unknown, contextKey?: string): void {
    this.snapshots.set(turnId, snapshot);
    if (contextKey) this.contexts.set(turnId, contextKey);
  }
  getTurnSnapshot(turnId: string): unknown { return this.snapshots.get(turnId); }
  getTurnContextKey(turnId: string): string | undefined { return this.contexts.get(turnId); }
  saveTurnDelivery(turnId: string): void {
    if (!this.deliveries.has(turnId)) this.deliveries.set(turnId, { finalDelivered: false, finalMessageIds: [] });
  }
  saveFinalDeliveryProgress(turnId: string, messageIds: string[]): void {
    this.deliveries.set(turnId, { finalDelivered: false, finalMessageIds: [...messageIds] });
  }
  markFinalDelivered(turnId: string, messageIds: string[]): void {
    this.deliveries.set(turnId, { finalDelivered: true, finalMessageIds: [...messageIds] });
  }
  getTurnDelivery(turnId: string) { return this.deliveries.get(turnId); }
}

function outboundWithMarkdown(sendMarkdown: FeishuOutbound["sendMarkdown"]): FeishuOutbound {
  return {
    sendText: vi.fn(async () => "text"),
    sendMarkdown,
    sendInteractiveCard: vi.fn(async () => "progress"),
    updateInteractiveCard: vi.fn(async () => undefined),
  };
}
