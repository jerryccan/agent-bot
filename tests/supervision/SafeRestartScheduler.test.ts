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

  test("keeps only the latest safe restart request", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 0, pendingFinalDeliveries: 0 }),
      onReady,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });
    expect(scheduler.schedule("first")).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(scheduler.schedule("second")).toBe(false);
    expect(scheduler.pendingReason).toBe("second");

    await vi.advanceTimersByTimeAsync(900);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);

    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith("second");
    expect(scheduler.scheduled).toBe(false);
  });

  test("publishes blockers and resets the countdown after new inbound activity", async () => {
    vi.useFakeTimers();
    let state: ServerActivityState = { runningSessions: 1, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    const onStatus = vi.fn();
    const scheduler = new SafeRestartScheduler({
      readActivity: () => state,
      onReady: vi.fn(),
      onStatus,
      quietPeriodMs: 1_000,
      pollIntervalMs: 100,
    });

    scheduler.schedule("card update");
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      scheduleId: 1,
      phase: "waiting_tasks",
      reason: "card update",
    }));

    state = { runningSessions: 0, pendingFinalDeliveries: 0, latestInboundAt: "a" };
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "countdown",
      remainingMs: expect.any(Number),
    }));

    state = { ...state, latestInboundAt: "b" };
    await vi.advanceTimersByTimeAsync(100);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "countdown",
      remainingMs: 1_000,
    }));
  });

  test("waits for each status delivery before publishing another countdown state", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const onStatus = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const scheduler = new SafeRestartScheduler({
      readActivity: () => ({ runningSessions: 0, pendingFinalDeliveries: 0 }),
      onReady: vi.fn(),
      onStatus,
      quietPeriodMs: 10_000,
      pollIntervalMs: 100,
    });

    scheduler.schedule("visible countdown");
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).toHaveBeenCalledOnce();

    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledTimes(2);

    scheduler.cancel();
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  });
});
