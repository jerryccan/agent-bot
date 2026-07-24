import type { Logger } from "pino";
import { CardRenderer } from "../feishu/CardRenderer.js";
import type { FeishuOutbound } from "../feishu/types.js";
import type { StateStore } from "../state/StateStore.js";
import type { SafeRestartStatus } from "./SafeRestartScheduler.js";

export class SafeRestartNotifier {
  private readonly messageIds = new Map<string, string>();
  private readonly cardHashes = new Map<string, string>();
  private activeScheduleId?: number;
  private queue = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly outbound: FeishuOutbound,
    private readonly renderer: CardRenderer,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  update(status: SafeRestartStatus): Promise<void> {
    const queued = this.queue.catch(() => undefined).then(() => this.publishStatus(status));
    this.queue = queued;
    return queued;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async publishStatus(status: SafeRestartStatus): Promise<void> {
    if (this.activeScheduleId !== status.scheduleId) {
      this.activeScheduleId = status.scheduleId;
      this.messageIds.clear();
      this.cardHashes.clear();
    }
    await this.publish(status);
  }

  private async publish(status: SafeRestartStatus): Promise<void> {
    const targets = this.store.listChatContexts("p2p");
    if (targets.length === 0) return;
    const waitingTasks = this.store.listAllSessions()
      .filter((session) => session.status === "running" || this.store.countQueuedPrompts(session.localSessionId) > 0)
      .map((session) => ({
        id: session.remoteSessionId ?? session.localSessionId,
        title: session.title,
      }));
    const card = this.renderer.renderSafeRestartStatus({
      reason: status.reason,
      phase: status.phase,
      remainingMs: status.remainingMs,
      pendingFinalDeliveries: status.activity.pendingFinalDeliveries,
      waitingTasks,
    });
    const cardHash = JSON.stringify(card);

    await Promise.all(targets.map(async ({ contextKey }) => {
      const messageId = this.messageIds.get(contextKey);
      if (messageId) {
        if (this.cardHashes.get(contextKey) === cardHash) return;
        try {
          await this.outbound.updateInteractiveCard(messageId, card);
          this.cardHashes.set(contextKey, cardHash);
          return;
        } catch (error) {
          this.logger.warn({ error, contextKey, messageId }, "Failed to update safe restart status card; sending a replacement.");
          this.messageIds.delete(contextKey);
          this.cardHashes.delete(contextKey);
        }
      }
      try {
        const created = await this.outbound.sendInteractiveCard(contextKey, card);
        if (created && this.activeScheduleId === status.scheduleId) {
          this.messageIds.set(contextKey, created);
          this.cardHashes.set(contextKey, cardHash);
        }
      } catch (error) {
        this.logger.warn({ error, contextKey }, "Failed to send safe restart status card.");
      }
    }));
  }
}
