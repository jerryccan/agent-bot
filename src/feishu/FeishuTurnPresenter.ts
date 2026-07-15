import type { AgentEvent } from "../runtime/types.js";
import { createTurnViewState, reduceTurnEvent } from "../presentation/TurnStateReducer.js";
import { splitMarkdown } from "../presentation/splitMarkdown.js";
import type { TurnViewState } from "../presentation/turnViewTypes.js";
import { CardRenderer } from "./CardRenderer.js";
import { CardUpdateScheduler } from "./CardUpdateScheduler.js";
import type { FeishuOutbound } from "./types.js";

interface TurnDeliveryRecord {
  finalDelivered: boolean;
  finalMessageIds: string[];
}

export interface TurnPresentationStore {
  saveTurnSnapshot(turnId: string, localSessionId: string, snapshot: unknown): void;
  getTurnSnapshot(turnId: string): unknown;
  saveTurnDelivery(turnId: string, patch: { progressMessageId?: string; lastCardHash?: string }): void;
  markFinalDelivered(turnId: string, messageIds: string[]): void;
  getTurnDelivery(turnId: string): TurnDeliveryRecord | undefined;
}

export interface FeishuTurnPresenterOptions {
  normalIntervalMs?: number;
  criticalGapMs?: number;
  finalChunkLength?: number;
  onError?: (error: unknown) => void;
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

  async onEvent(event: AgentEvent): Promise<void> {
    const existing = this.entries.get(event.turnId);
    const entry = existing ?? this.createEntry(event);
    if (!entry) return;

    if (existing) {
      entry.state = reduceTurnEvent(entry.state, event);
      this.store.saveTurnSnapshot(event.turnId, event.sessionId, entry.state);
    }

    await entry.initializing;
    if (!entry.scheduler) return;

    if (isTerminalEvent(event)) {
      entry.finalizing ??= this.finalize(entry);
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
    await entry.scheduler?.flush(entry.state);
    if (entry.state.status !== "completed" || !entry.state.finalResponse) return;
    if (this.store.getTurnDelivery(entry.state.turnId)?.finalDelivered) return;

    const messageIds: string[] = [];
    for (const chunk of splitMarkdown(entry.state.finalResponse, this.options.finalChunkLength ?? 4_000)) {
      const messageId = await this.outbound.sendMarkdown(entry.contextKey, chunk);
      if (messageId) messageIds.push(messageId);
    }
    this.store.markFinalDelivered(entry.state.turnId, messageIds);
  }
}

function eventPriority(event: AgentEvent): "normal" | "critical" {
  if (event.type === "approval_requested" || event.type === "approval_resolved" || event.type === "tool_started") {
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
