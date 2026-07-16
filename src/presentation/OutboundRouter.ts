import type { AgentEvent } from "../runtime/types.js";
import type { FeishuOutbound } from "../feishu/types.js";

export interface TurnPresenter {
  registerSession(sessionId: string, contextKey: string, taskTitle?: string): void;
  updateSessionTitle(sessionId: string, taskTitle: string): void;
  unregisterSession(sessionId: string): void;
  startPendingTurn(sessionId: string, contextKey: string, taskTitle?: string): Promise<void>;
  failPendingTurn(sessionId: string, message: string): Promise<void>;
  onEvent(event: AgentEvent): Promise<void>;
  showDetails(contextKey: string, turnId: string): Promise<void>;
  resumeDelivery(sessionId: string, contextKey: string, turnId: string): Promise<void>;
  flushAll(): Promise<void>;
}

export interface OutboundRoute {
  matches(contextKey: string): boolean;
  outbound: FeishuOutbound;
  presenter: TurnPresenter;
}

export class OutboundRouter {
  private readonly sessionRoutes = new Map<string, OutboundRoute>();

  constructor(private readonly routes: OutboundRoute[]) {
    if (routes.length === 0) throw new Error("At least one outbound route is required.");
  }

  registerSession(sessionId: string, contextKey: string, taskTitle?: string): void {
    const route = this.route(contextKey);
    this.sessionRoutes.set(sessionId, route);
    route.presenter.registerSession(sessionId, contextKey, taskTitle);
  }

  updateSessionTitle(sessionId: string, taskTitle: string): void {
    this.sessionRoutes.get(sessionId)?.presenter.updateSessionTitle(sessionId, taskTitle);
  }

  unregisterSession(sessionId: string): void {
    const route = this.sessionRoutes.get(sessionId);
    route?.presenter.unregisterSession(sessionId);
    this.sessionRoutes.delete(sessionId);
  }

  async startPendingTurn(sessionId: string, contextKey: string, taskTitle?: string): Promise<void> {
    await this.route(contextKey).presenter.startPendingTurn(sessionId, contextKey, taskTitle);
  }

  async failPendingTurn(sessionId: string, message: string): Promise<void> {
    await this.sessionRoutes.get(sessionId)?.presenter.failPendingTurn(sessionId, message);
  }

  async onEvent(event: AgentEvent): Promise<void> {
    await this.sessionRoutes.get(event.sessionId)?.presenter.onEvent(event);
  }

  async showDetails(contextKey: string, turnId: string): Promise<void> {
    await this.route(contextKey).presenter.showDetails(contextKey, turnId);
  }

  async resumeDelivery(sessionId: string, contextKey: string, turnId: string): Promise<void> {
    await this.route(contextKey).presenter.resumeDelivery(sessionId, contextKey, turnId);
  }

  sendText(contextKey: string, text: string): Promise<string | undefined> {
    return this.route(contextKey).outbound.sendText(contextKey, text);
  }

  sendMarkdown(contextKey: string, markdown: string): Promise<string | undefined> {
    return this.route(contextKey).outbound.sendMarkdown(contextKey, markdown);
  }

  sendInteractiveCard(contextKey: string, card: Record<string, unknown>): Promise<string | undefined> {
    return this.route(contextKey).outbound.sendInteractiveCard(contextKey, card);
  }

  async flushAll(): Promise<void> {
    const presenters = [...new Set(this.routes.map((route) => route.presenter))];
    await Promise.all(presenters.map((presenter) => presenter.flushAll()));
  }

  private route(contextKey: string): OutboundRoute {
    const route = this.routes.find((candidate) => candidate.matches(contextKey));
    if (!route) throw new Error(`No outbound route for context: ${contextKey}`);
    return route;
  }
}
