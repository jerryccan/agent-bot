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
    updateInteractiveCard: vi.fn(async () => undefined),
  };
  const store = {
    saveTurnSnapshot: vi.fn(),
    getTurnSnapshot: vi.fn(),
    saveTurnDelivery: vi.fn(),
    saveFinalDeliveryProgress: vi.fn(),
    markFinalDelivered: vi.fn(),
    getTurnDelivery: vi.fn(() => (delivered ? { finalDelivered: true, finalMessageIds: ["old"] } : undefined)),
  };
  const presenter = new FeishuTurnPresenter(outbound, store, undefined, {
    normalIntervalMs: 1,
    criticalGapMs: 0,
  });
  presenter.registerSession("s1", "chat_id:c1");
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
  });

  test("reuses the immediate starting card when the real turn id arrives", async () => {
    const { presenter, outbound } = createFixture();
    await presenter.startPendingTurn("s1", "chat_id:c1");
    await presenter.onEvent({ type: "turn_started", sessionId: "s1", turnId: "turn_1", startedAt: Date.now() - 1_000 });
    expect(outbound.sendInteractiveCard).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(outbound.updateInteractiveCard).toHaveBeenCalled());
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
  private readonly deliveries = new Map<string, { finalDelivered: boolean; finalMessageIds: string[] }>();
  saveTurnSnapshot(turnId: string, _sessionId: string, snapshot: unknown): void { this.snapshots.set(turnId, snapshot); }
  getTurnSnapshot(turnId: string): unknown { return this.snapshots.get(turnId); }
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
