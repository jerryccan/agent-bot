export interface ServerActivityState {
  runningSessions: number;
  pendingFinalDeliveries: number;
  latestInboundAt?: string;
}

export type SafeRestartPhase =
  | "waiting_tasks"
  | "waiting_delivery"
  | "countdown"
  | "restarting"
  | "cancelled";

export interface SafeRestartStatus {
  scheduleId: number;
  reason: string;
  phase: SafeRestartPhase;
  activity: ServerActivityState;
  remainingMs?: number;
}

export interface SafeRestartSchedulerOptions {
  readActivity(): ServerActivityState;
  onReady(reason: string): void | Promise<void>;
  onStatus?(status: SafeRestartStatus): void | Promise<void>;
  onStatusError?(error: unknown): void;
  quietPeriodMs?: number;
  pollIntervalMs?: number;
}

export class SafeRestartScheduler {
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private pollAgain = false;
  private reason?: string;
  private idleSince?: number;
  private idleInboundAt?: string;
  private scheduleId = 0;

  constructor(private readonly options: SafeRestartSchedulerOptions) {}

  get scheduled(): boolean {
    return Boolean(this.reason);
  }

  get pendingReason(): string | undefined {
    return this.reason;
  }

  schedule(reason: string): boolean {
    const newlyScheduled = !this.reason;
    if (newlyScheduled) this.scheduleId += 1;
    this.reason = reason;
    this.idleSince = undefined;
    this.idleInboundAt = undefined;
    if (!this.timer) {
      this.timer = setInterval(() => this.requestPoll(), this.options.pollIntervalMs ?? 1_000);
    }
    this.requestPoll();
    return newlyScheduled;
  }

  cancel(): void {
    this.clear();
  }

  async cancelCurrent(): Promise<boolean> {
    if (!this.reason) return false;
    return this.cancelScheduled(this.scheduleId);
  }

  async cancelScheduled(expectedScheduleId: number): Promise<boolean> {
    const reason = this.reason;
    if (!reason || this.scheduleId !== expectedScheduleId) return false;
    const activity = this.options.readActivity();
    this.clear();
    await this.emitStatus({
      scheduleId: expectedScheduleId,
      reason,
      phase: "cancelled",
      activity,
    });
    return true;
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.reason = undefined;
    this.idleSince = undefined;
    this.idleInboundAt = undefined;
  }

  private async poll(): Promise<void> {
    const reason = this.reason;
    if (!reason) return;
    const state = this.options.readActivity();
    if (state.runningSessions > 0 || state.pendingFinalDeliveries > 0) {
      this.idleSince = undefined;
      this.idleInboundAt = undefined;
      await this.emitStatus({
        scheduleId: this.scheduleId,
        reason,
        phase: state.runningSessions > 0 ? "waiting_tasks" : "waiting_delivery",
        activity: state,
      });
      return;
    }
    const quietPeriodMs = this.options.quietPeriodMs ?? 15_000;
    const latestInboundAt = state.latestInboundAt ?? "";
    if (this.idleSince === undefined || this.idleInboundAt !== latestInboundAt) {
      this.idleSince = Date.now();
      this.idleInboundAt = latestInboundAt;
      await this.emitStatus({ scheduleId: this.scheduleId, reason, phase: "countdown", activity: state, remainingMs: quietPeriodMs });
      return;
    }
    const remainingMs = Math.max(0, quietPeriodMs - (Date.now() - this.idleSince));
    if (remainingMs > 0) {
      await this.emitStatus({ scheduleId: this.scheduleId, reason, phase: "countdown", activity: state, remainingMs });
      return;
    }
    const confirmed = this.options.readActivity();
    if (
      confirmed.runningSessions > 0
      || confirmed.pendingFinalDeliveries > 0
      || (confirmed.latestInboundAt ?? "") !== this.idleInboundAt
    ) {
      this.idleSince = undefined;
      this.idleInboundAt = undefined;
      if (confirmed.runningSessions > 0 || confirmed.pendingFinalDeliveries > 0) {
        await this.emitStatus({
          scheduleId: this.scheduleId,
          reason,
          phase: confirmed.runningSessions > 0 ? "waiting_tasks" : "waiting_delivery",
          activity: confirmed,
        });
      } else {
        await this.emitStatus({
          scheduleId: this.scheduleId,
          reason,
          phase: "countdown",
          activity: confirmed,
          remainingMs: quietPeriodMs,
        });
      }
      return;
    }
    const scheduleId = this.scheduleId;
    this.clear();
    await this.emitStatus({ scheduleId, reason, phase: "restarting", activity: confirmed, remainingMs: 0 });
    await this.options.onReady(reason);
  }

  private requestPoll(): void {
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = this.drainPolls().finally(() => {
      this.polling = undefined;
      if (this.pollAgain && this.reason) this.requestPoll();
    });
  }

  private async drainPolls(): Promise<void> {
    do {
      this.pollAgain = false;
      await this.poll();
    } while (this.pollAgain && this.reason);
  }

  private async emitStatus(status: SafeRestartStatus): Promise<void> {
    if (!this.options.onStatus) return;
    await Promise.resolve(this.options.onStatus(status)).catch((error: unknown) => {
      this.options.onStatusError?.(error);
    });
  }
}
