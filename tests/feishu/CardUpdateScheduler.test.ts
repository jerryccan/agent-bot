import { describe, expect, test, vi } from "vitest";
import { CardUpdateScheduler } from "../../src/feishu/CardUpdateScheduler.js";

describe("CardUpdateScheduler", () => {
  test("coalesces normal updates and writes only the latest state", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const scheduler = new CardUpdateScheduler<{ text: string }>({
      render: (state) => ({ text: state.text }),
      write,
      normalIntervalMs: 2_000,
      criticalGapMs: 500,
    });

    scheduler.update({ text: "one" });
    scheduler.update({ text: "two" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ text: "two" });
    vi.useRealTimers();
  });

  test("skips equivalent renders and applies a shorter gap to critical updates", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const scheduler = new CardUpdateScheduler<{ text: string }>({
      render: (state) => ({ text: state.text }),
      write,
      normalIntervalMs: 2_000,
      criticalGapMs: 500,
    });

    scheduler.update({ text: "same" }, "critical");
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledOnce();
    scheduler.update({ text: "same" }, "critical");
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test("retries rate limits with backoff while retaining the latest state", async () => {
    vi.useFakeTimers();
    const rateLimit = Object.assign(new Error("limited"), { isRateLimit: true });
    const write = vi.fn().mockRejectedValueOnce(rateLimit).mockResolvedValue(undefined);
    const scheduler = new CardUpdateScheduler<{ text: string }>({
      render: (state) => ({ text: state.text }),
      write,
      normalIntervalMs: 100,
      criticalGapMs: 50,
      retryBackoffMs: [2_000],
    });

    scheduler.update({ text: "old" });
    await vi.advanceTimersByTimeAsync(100);
    scheduler.update({ text: "latest" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenLastCalledWith({ text: "latest" });
    vi.useRealTimers();
  });
});
