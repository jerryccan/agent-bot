export interface ServerActivityState {
  runningSessions: number;
  pendingFinalDeliveries: number;
  latestInboundAt?: string;
}

export interface SafeRestartSchedulerOptions {
  readActivity(): ServerActivityState;
  onReady(reason: string): void | Promise<void>;
  quietPeriodMs?: number;
  pollIntervalMs?: number;
}

export class SafeRestartScheduler {
  private timer?: NodeJS.Timeout;
  private reason?: string;
  private idleSince?: number;
  private idleInboundAt?: string;

  constructor(private readonly options: SafeRestartSchedulerOptions) {}

  get scheduled(): boolean {
    return Boolean(this.reason);
  }

  get pendingReason(): string | undefined {
    return this.reason;
  }

  schedule(reason: string): boolean {
    const newlyScheduled = !this.reason;
    this.reason = reason;
    this.idleSince = undefined;
    this.idleInboundAt = undefined;
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? 2_000);
      void this.poll();
    }
    return newlyScheduled;
  }

  cancel(): void {
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
      return;
    }
    const latestInboundAt = state.latestInboundAt ?? "";
    if (this.idleSince === undefined || this.idleInboundAt !== latestInboundAt) {
      this.idleSince = Date.now();
      this.idleInboundAt = latestInboundAt;
      return;
    }
    if (Date.now() - this.idleSince < (this.options.quietPeriodMs ?? 15_000)) return;
    const confirmed = this.options.readActivity();
    if (
      confirmed.runningSessions > 0
      || confirmed.pendingFinalDeliveries > 0
      || (confirmed.latestInboundAt ?? "") !== this.idleInboundAt
    ) {
      this.idleSince = undefined;
      this.idleInboundAt = undefined;
      return;
    }
    this.cancel();
    await this.options.onReady(reason);
  }
}
