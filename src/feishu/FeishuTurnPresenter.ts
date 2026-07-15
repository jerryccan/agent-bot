import type { AgentEvent } from "../runtime/types.js";
import { createTurnViewState, reduceTurnEvent } from "../presentation/TurnStateReducer.js";
import { splitMarkdown } from "../presentation/splitMarkdown.js";
import type { TurnViewState } from "../presentation/turnViewTypes.js";
import { CardRenderer } from "./CardRenderer.js";
import { CardUpdateScheduler } from "./CardUpdateScheduler.js";
import type { FeishuOutbound } from "./types.js";
import { createId } from "../utils/id.js";
import { createHash } from "node:crypto";

interface TurnDeliveryRecord {
  finalDelivered: boolean;
  finalMessageIds: string[];
}

export interface TurnPresentationStore {
  saveTurnSnapshot(turnId: string, localSessionId: string, snapshot: unknown): void;
  getTurnSnapshot(turnId: string): unknown;
  saveTurnDelivery(turnId: string, patch: { progressMessageId?: string; lastCardHash?: string }): void;
  saveFinalDeliveryProgress(turnId: string, messageIds: string[]): void;
  markFinalDelivered(turnId: string, messageIds: string[]): void;
  getTurnDelivery(turnId: string): TurnDeliveryRecord | undefined;
}

export interface FeishuTurnPresenterOptions {
  normalIntervalMs?: number;
  criticalGapMs?: number;
  finalChunkLength?: number;
  onError?: (error: unknown) => void;
  finalRetryBackoffMs?: number[];
}

interface TurnEntry {
  contextKey: string;
  state: TurnViewState;
  initializing: Promise<void>;
  messageId?: string;
  scheduler?: CardUpdateScheduler<TurnViewState>;
  finalizing?: Promise<void>;
}

export class FeishuTurnPresenter {
  private readonly sessionContexts = new Map<string, string>();
  private readonly entries = new Map<string, TurnEntry>();
  private readonly pendingEntries = new Map<string, TurnEntry>();
  private readonly renderer: CardRenderer;

  constructor(
    private readonly outbound: FeishuOutbound,
    private readonly store: TurnPresentationStore,
    renderer?: CardRenderer,
    private readonly options: FeishuTurnPresenterOptions = {},
  ) {
    this.renderer = renderer ?? new CardRenderer();
  }

  registerSession(sessionId: string, contextKey: string): void {
    this.sessionContexts.set(sessionId, contextKey);
  }

  unregisterSession(sessionId: string): void {
    this.sessionContexts.delete(sessionId);
  }

  async startPendingTurn(sessionId: string, contextKey: string): Promise<void> {
    const existing = this.pendingEntries.get(sessionId);
    if (existing) {
      await existing.initializing;
      return;
    }
    this.sessionContexts.set(sessionId, contextKey);
    const state = createTurnViewState(sessionId, createId("pending"), Date.now());
    const entry = { contextKey, state, initializing: Promise.resolve() } as TurnEntry;
    this.entries.set(state.turnId, entry);
    this.pendingEntries.set(sessionId, entry);
    this.store.saveTurnSnapshot(state.turnId, sessionId, state);
    entry.initializing = this.initializeEntry(entry);
    try {
      await entry.initializing;
    } catch (error) {
      if (this.pendingEntries.get(sessionId) === entry) this.pendingEntries.delete(sessionId);
      this.entries.delete(state.turnId);
      throw error;
    }
  }

  async failPendingTurn(sessionId: string, message: string): Promise<void> {
    const entry = this.pendingEntries.get(sessionId);
    if (!entry) return;
    this.pendingEntries.delete(sessionId);
    entry.state = { ...entry.state, status: "failed", error: message, completedAt: Date.now() };
    this.store.saveTurnSnapshot(entry.state.turnId, sessionId, entry.state);
    await entry.initializing;
    try {
      await entry.scheduler?.flush(entry.state);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async onEvent(event: AgentEvent): Promise<void> {
    let existing = this.entries.get(event.turnId);
    let eventApplied = false;
    if (!existing && event.type === "turn_started") {
      const pending = this.pendingEntries.get(event.sessionId);
      if (pending) {
        this.pendingEntries.delete(event.sessionId);
        this.entries.delete(pending.state.turnId);
        pending.state = reduceTurnEvent(
          createTurnViewState(event.sessionId, event.turnId, event.startedAt),
          event,
        );
        this.entries.set(event.turnId, pending);
        this.store.saveTurnSnapshot(event.turnId, event.sessionId, pending.state);
        existing = pending;
        eventApplied = true;
      }
    }
    const entry = existing ?? this.createEntry(event);
    if (!entry) return;

    if (existing && !eventApplied) {
      entry.state = reduceTurnEvent(entry.state, event);
      this.store.saveTurnSnapshot(event.turnId, event.sessionId, entry.state);
    }

    await entry.initializing;
    if (!entry.scheduler) return;

    if (isTerminalEvent(event)) {
      if (!entry.finalizing) {
        const finalizing = this.finalize(entry);
        entry.finalizing = finalizing;
        void finalizing.catch(() => {
          if (entry.finalizing === finalizing) entry.finalizing = undefined;
        });
      }
      await entry.finalizing;
      return;
    }

    entry.scheduler.update(entry.state, eventPriority(event));
  }

  async showDetails(contextKey: string, turnId: string): Promise<void> {
    const snapshot = this.store.getTurnSnapshot(turnId);
    if (!isTurnViewState(snapshot)) {
      await this.outbound.sendText(contextKey, "未找到这次执行的详情。可能已被清理。");
      return;
    }
    await this.outbound.sendInteractiveCard(contextKey, this.renderer.renderTurnDetails(snapshot));
  }

  async resumeDelivery(_sessionId: string, contextKey: string, turnId: string): Promise<void> {
    const delivery = this.store.getTurnDelivery(turnId);
    if (delivery?.finalDelivered) return;
    const snapshot = this.store.getTurnSnapshot(turnId);
    if (!isTurnViewState(snapshot) || snapshot.status !== "completed" || !snapshot.finalResponse) return;
    await this.deliverFinal(contextKey, snapshot);
  }

  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await entry.initializing;
        await entry.scheduler?.flush();
      }),
    );
  }

  private createEntry(event: AgentEvent): TurnEntry | undefined {
    const contextKey = this.sessionContexts.get(event.sessionId);
    if (!contextKey) return undefined;
    const startedAt = event.type === "turn_started" ? event.startedAt : Date.now();
    const state = reduceTurnEvent(createTurnViewState(event.sessionId, event.turnId, startedAt), event);
    const entry = { contextKey, state, initializing: Promise.resolve() } as TurnEntry;
    this.entries.set(event.turnId, entry);
    this.store.saveTurnSnapshot(event.turnId, event.sessionId, state);
    entry.initializing = this.initializeEntry(entry);
    return entry;
  }

  private async initializeEntry(entry: TurnEntry): Promise<void> {
    const sentState = entry.state;
    const messageId = await this.outbound.sendInteractiveCard(entry.contextKey, this.renderer.renderTurn(sentState));
    entry.messageId = messageId;
    if (!messageId) return;
    this.store.saveTurnDelivery(entry.state.turnId, { progressMessageId: messageId });
    entry.scheduler = new CardUpdateScheduler<TurnViewState>({
      render: (state) => this.renderer.renderTurn(state),
      write: (card) => this.outbound.updateInteractiveCard(messageId, card),
      normalIntervalMs: this.options.normalIntervalMs,
      criticalGapMs: this.options.criticalGapMs,
      onError: this.options.onError,
    });
    entry.scheduler.seed(sentState);
    if (entry.state !== sentState) entry.scheduler.update(entry.state, "critical");
  }

  private async finalize(entry: TurnEntry): Promise<void> {
    try {
      await entry.scheduler?.flush(entry.state);
    } catch (error) {
      this.options.onError?.(error);
    }
    if (entry.state.status !== "completed" || !entry.state.finalResponse) return;
    await this.deliverFinal(entry.contextKey, entry.state);
  }

  private async deliverFinal(contextKey: string, state: TurnViewState): Promise<void> {
    const delivery = this.store.getTurnDelivery(state.turnId);
    if (delivery?.finalDelivered || !state.finalResponse) return;
    const chunks = splitMarkdown(state.finalResponse, this.options.finalChunkLength ?? 4_000);
    const messageIds = [...(delivery?.finalMessageIds ?? [])];
    for (let index = messageIds.length; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      const messageId = await this.sendFinalChunk(contextKey, chunk, finalMessageKey(state.turnId, index));
      messageIds.push(messageId ?? `delivered-chunk-${index}`);
      this.store.saveFinalDeliveryProgress(state.turnId, messageIds);
    }
    this.store.markFinalDelivered(state.turnId, messageIds);
  }

  private async sendFinalChunk(contextKey: string, chunk: string, idempotencyKey: string): Promise<string | undefined> {
    const backoffs = this.options.finalRetryBackoffMs ?? [2_000, 4_000, 8_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.outbound.sendMarkdown(contextKey, chunk, idempotencyKey);
      } catch (error) {
        if (!isRetryableError(error) || attempt >= backoffs.length) throw error;
        await delay(backoffs[attempt] ?? 8_000);
      }
    }
  }
}

function eventPriority(event: AgentEvent): "normal" | "critical" {
  if (event.type === "turn_started" || event.type === "approval_requested" || event.type === "approval_resolved" || event.type === "tool_started") {
    return "critical";
  }
  return "normal";
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed";
}

function isTurnViewState(value: unknown): value is TurnViewState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<TurnViewState>;
  return (
    typeof state.sessionId === "string" &&
    typeof state.turnId === "string" &&
    typeof state.status === "string" &&
    typeof state.startedAt === "number" &&
    Array.isArray(state.plan) &&
    Array.isArray(state.completedTools) &&
    Array.isArray(state.failedTools) &&
    Array.isArray(state.fileSummary)
  );
}

function isRetryableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("isRetryable" in error && error.isRetryable === true) || ("isRateLimit" in error && error.isRateLimit === true))
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function finalMessageKey(turnId: string, index: number): string {
  const digest = createHash("sha256").update(`${turnId}:${index}`).digest("hex").slice(0, 32);
  return `codex-final-${digest}`;
}
