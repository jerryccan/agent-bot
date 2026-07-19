import { afterEach, describe, expect, test, vi } from "vitest";
import { SafeRestartScheduler, type ServerActivityState } from "../../src/supervision/SafeRestartScheduler.js";

afterEach(() => vi.useRealTimers());

describe("SafeRestartScheduler", () => {
  test("waits for all tasks and final deliveries plus a quiet inbound window", async () => {
    vi.useFakeTimers();
    let state: ServerActivityState = { runningSessions: 1, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    const onReady = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => state,
      onReady,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });

    expect(scheduler.schedule("code updated")).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReady).not.toHaveBeenCalled();

    state = { runningSessions: 0, pendingFinalDeliveries: 1, latestInboundAt: "a" };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onReady).not.toHaveBeenCalled();

    state = { runningSessions: 0, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    await vi.advanceTimersByTimeAsync(900);
    state = { ...state, latestInboundAt: "b" };
    await vi.advanceTimersByTimeAsync(900);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);

    expect(onReady).toHaveBeenCalledWith("code updated");
    expect(scheduler.scheduled).toBe(false);
  });

  test("updates the reason of an already scheduled restart", () => {
    vi.useFakeTimers();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 1, pendingFinalDeliveries: 0 }),
      onReady: vi.fn(),
    });
    expect(scheduler.schedule("first")).toBe(true);
    expect(scheduler.schedule("second")).toBe(false);
    expect(scheduler.pendingReason).toBe("second");
    scheduler.cancel();
  });
});
