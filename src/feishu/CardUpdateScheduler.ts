export type CardUpdatePriority = "normal" | "critical";

export interface CardUpdateSchedulerOptions<T> {
  render(state: T): Record<string, unknown>;
  write(card: Record<string, unknown>): Promise<void>;
  normalIntervalMs?: number;
  criticalGapMs?: number;
  retryBackoffMs?: number[];
  isRateLimit?: (error: unknown) => boolean;
  isRetryable?: (error: unknown) => boolean;
  onError?: (error: unknown) => void;
}

interface FlushWaiter {
  version: number;
  resolve(): void;
  reject(error: unknown): void;
}

export class CardUpdateScheduler<T> {
  private latestState?: T;
  private version = 0;
  private dirty = false;
  private priority: CardUpdatePriority = "normal";
  private lastWriteAt = Date.now();
  private lastHash?: string;
  private retryIndex = 0;
  private retryAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writing = false;
  private disposed = false;
  private readonly waiters: FlushWaiter[] = [];
  private readonly normalIntervalMs: number;
  private readonly criticalGapMs: number;
  private readonly retryBackoffMs: number[];

  constructor(private readonly options: CardUpdateSchedulerOptions<T>) {
    this.normalIntervalMs = options.normalIntervalMs ?? 2_000;
    this.criticalGapMs = options.criticalGapMs ?? 500;
    this.retryBackoffMs = options.retryBackoffMs ?? [2_000, 4_000, 8_000, 16_000, 30_000];
  }

  seed(state: T): void {
    this.latestState = state;
    this.lastHash = hashCard(this.options.render(state));
    this.lastWriteAt = Date.now();
  }

  invalidateRenderedCard(): void {
    this.lastHash = undefined;
  }

  update(state: T, priority: CardUpdatePriority = "normal"): void {
    if (this.disposed) return;
    this.latestState = state;
    this.version += 1;
    this.dirty = true;
    if (priority === "critical") this.priority = "critical";
    this.schedule();
  }

  flush(state?: T): Promise<void> {
    if (state !== undefined) this.update(state, "critical");
    else if (this.latestState !== undefined) this.update(this.latestState, "critical");
    if (!this.dirty) return Promise.resolve();

    const version = this.version;
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ version, resolve, reject });
      this.schedule();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const error = new Error("Card update scheduler was disposed.");
    this.rejectWaiters(Number.POSITIVE_INFINITY, error);
  }

  private schedule(): void {
    if (this.disposed || this.writing || !this.dirty || this.timer) return;
    const gap = this.priority === "critical" ? this.criticalGapMs : this.normalIntervalMs;
    const dueAt = Math.max(this.lastWriteAt + gap, this.retryAt);
    const delay = Math.max(0, dueAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.writing || !this.dirty || this.latestState === undefined) return;
    this.writing = true;
    const state = this.latestState;
    const version = this.version;
    const card = this.options.render(state);
    const hash = hashCard(card);

    if (hash === this.lastHash) {
      this.markHandled(version);
      this.writing = false;
      this.schedule();
      return;
    }

    try {
      await this.options.write(card);
      this.lastHash = hash;
      this.lastWriteAt = Date.now();
      this.retryAt = 0;
      this.retryIndex = 0;
      this.markHandled(version);
    } catch (error) {
      if (this.isRetryable(error)) {
        const index = Math.min(this.retryIndex, this.retryBackoffMs.length - 1);
        this.retryAt = Date.now() + (this.retryBackoffMs[index] ?? 30_000);
        this.retryIndex += 1;
      } else {
        this.dirty = this.version > version;
        this.rejectWaiters(version, error);
        this.options.onError?.(error);
      }
    } finally {
      this.writing = false;
      this.schedule();
    }
  }

  private markHandled(version: number): void {
    this.dirty = this.version > version;
    if (!this.dirty) this.priority = "normal";
    const ready = this.waiters.filter((waiter) => waiter.version <= version);
    for (const waiter of ready) waiter.resolve();
    this.removeWaiters(ready);
  }

  private rejectWaiters(version: number, error: unknown): void {
    const rejected = this.waiters.filter((waiter) => waiter.version <= version);
    for (const waiter of rejected) waiter.reject(error);
    this.removeWaiters(rejected);
  }

  private removeWaiters(waiters: FlushWaiter[]): void {
    for (const waiter of waiters) {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
    }
  }

  private isRetryable(error: unknown): boolean {
    if (this.options.isRetryable) return this.options.isRetryable(error);
    if (this.options.isRateLimit?.(error)) return true;
    return (
      typeof error === "object" &&
      error !== null &&
      (("isRetryable" in error && error.isRetryable === true) || ("isRateLimit" in error && error.isRateLimit === true))
    );
  }
}

function hashCard(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}
