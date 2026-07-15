import { describe, expect, test, vi } from "vitest";
import { FeishuTurnPresenter } from "../../src/feishu/FeishuTurnPresenter.js";
import type { FeishuOutbound } from "../../src/feishu/types.js";
import type { AgentEvent } from "../../src/runtime/types.js";

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
});
