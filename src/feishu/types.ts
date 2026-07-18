export interface IncomingMessage {
  messageId: string;
  contextKey: string;
  chatId?: string;
  chatType?: "p2p" | "group";
  userId?: string;
  replyInThread?: boolean;
  threadContext?: true;
  threadId?: string;
  rootMessageId?: string;
  parentMessageId?: string;
  text: string;
  images?: IncomingImageReference[];
}

export interface IncomingImageReference {
  imageKey: string;
}

export interface MessageReplyTarget {
  messageId: string;
  replyInThread: true;
}

export interface CardAction {
  actionId: string;
  contextKey: string;
  userId?: string;
  messageId?: string;
  value: Record<string, unknown>;
}

export interface FeishuOutbound {
  addReaction?(messageId: string, emojiType: string): Promise<string | undefined>;
  deleteReaction?(messageId: string, reactionId: string): Promise<void>;
  downloadImage?(messageId: string, imageKey: string): Promise<string>;
  sendText(contextKey: string, text: string): Promise<string | undefined>;
  sendMarkdown(contextKey: string, markdown: string, idempotencyKey?: string): Promise<string | undefined>;
  sendInteractiveCard(contextKey: string, card: Record<string, unknown>): Promise<string | undefined>;
  replyText?(
    contextKey: string,
    target: MessageReplyTarget,
    text: string,
    idempotencyKey?: string,
  ): Promise<string | undefined>;
  replyMarkdown?(
    contextKey: string,
    target: MessageReplyTarget,
    markdown: string,
    idempotencyKey?: string,
  ): Promise<string | undefined>;
  replyInteractiveCard?(
    contextKey: string,
    target: MessageReplyTarget,
    card: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined>;
  updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export interface FeishuEventHandler {
  onMessage(message: IncomingMessage): Promise<void>;
  onCardAction(action: CardAction): Promise<void>;
}
