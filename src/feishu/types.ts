export interface IncomingMessage {
  messageId: string;
  contextKey: string;
  chatId?: string;
  userId?: string;
  text: string;
}

export interface CardAction {
  actionId: string;
  contextKey: string;
  userId?: string;
  messageId?: string;
  value: Record<string, unknown>;
}

export interface FeishuOutbound {
  sendText(contextKey: string, text: string): Promise<string | undefined>;
  sendMarkdown(contextKey: string, markdown: string, idempotencyKey?: string): Promise<string | undefined>;
  sendInteractiveCard(contextKey: string, card: Record<string, unknown>): Promise<string | undefined>;
  updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export interface FeishuEventHandler {
  onMessage(message: IncomingMessage): Promise<void>;
  onCardAction(action: CardAction): Promise<void>;
}
