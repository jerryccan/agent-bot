import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { threadContextKey } from "./contextKey.js";
import { resolveFeishuBotOpenId } from "./FeishuBotIdentity.js";
import type { ChatUpdatedEvent, FeishuEventHandler, IncomingMessage } from "./types.js";

type BotOpenIdResolver = (appId: string, appSecret: string) => Promise<string>;
type BotOpenIdListener = (botOpenId: string) => void;

export class FeishuConnector {
  constructor(
    private readonly config: AppConfig,
    private readonly handler: FeishuEventHandler,
    private readonly logger: Logger,
    private readonly botOpenIdResolver: BotOpenIdResolver = resolveFeishuBotOpenId,
    private readonly onBotOpenId?: BotOpenIdListener,
  ) {}

  async start(): Promise<void> {
    const { appId, appSecret } = this.config.feishu;
    if (!appId || !appSecret) {
      throw new Error("Feishu appId/appSecret are required.");
    }

    const respondToAllGroupMessages = this.config.feishu.respondToAllGroupMessages !== false;
    let botOpenId: string | undefined;
    if (!respondToAllGroupMessages || this.onBotOpenId) {
      try {
        botOpenId = await this.botOpenIdResolver(appId, appSecret);
        this.onBotOpenId?.(botOpenId);
      } catch (error) {
        if (!respondToAllGroupMessages) throw error;
        this.logger.warn({ error }, "Failed to resolve the Lark bot Open ID for the Agent environment.");
      }
    }
    await this.startFeishuWs(appId, appSecret, respondToAllGroupMessages ? undefined : botOpenId);
  }

  stop(): void {
    // SDK connector currently relies on process lifetime.
  }

  private async startFeishuWs(appId: string, appSecret: string, requiredMentionOpenId?: string): Promise<void> {
    const lark = (await import("@larksuiteoapi/node-sdk")) as Record<string, any>;
    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const message = toIncomingMessage(data, requiredMentionOpenId);
        if (!message) {
          this.logger.debug({ data }, "Ignored unsupported Feishu message event.");
          return;
        }

        void Promise.resolve()
          .then(() => this.handler.onMessage(message))
          .catch((error: unknown) => {
            this.logger.error({ error, messageId: message.messageId }, "Failed to handle Feishu message event.");
          });
      },
      "im.chat.updated_v1": async (data: unknown) => {
        const update = toChatUpdatedEvent(data);
        if (!update) {
          this.logger.debug({ data }, "Ignored Feishu chat update without a name change.");
          return;
        }
        if (!this.handler.onChatUpdated) return;

        void Promise.resolve()
          .then(() => this.handler.onChatUpdated!(update))
          .catch((error: unknown) => {
            this.logger.error(
              { error, chatId: update.chatId, afterName: update.afterName },
              "Failed to handle Feishu chat name update.",
            );
          });
      },
      "card.action.trigger": async (data: unknown) => {
        const action = toCardAction(data);
        if (!action) {
          this.logger.debug({ data }, "Ignored unsupported Feishu card action.");
          return {};
        }

        void Promise.resolve()
          .then(() => this.handler.onCardAction(action))
          .catch((error: unknown) => {
            this.logger.error({ error, actionId: action.actionId }, "Failed to handle Feishu card action.");
          });
        return {
          toast: {
            type: "success",
            content: "已处理",
          },
        };
      },
    });
    const wsClient = new lark.WSClient({
      appId,
      appSecret,
    });
    await wsClient.start({ eventDispatcher });
    this.logger.info("Feishu WebSocket connector started.");
  }
}

function toChatUpdatedEvent(data: unknown): ChatUpdatedEvent | undefined {
  const event = getFeishuEvent(data);
  const chatId = typeof event?.chat_id === "string" ? event.chat_id : undefined;
  const beforeName = typeof event?.before_change?.name === "string" ? event.before_change.name : undefined;
  const afterName = typeof event?.after_change?.name === "string" ? event.after_change.name : undefined;
  if (!chatId || !afterName || beforeName === afterName) return undefined;
  return {
    chatId,
    ...(beforeName !== undefined ? { beforeName } : {}),
    afterName,
  };
}

function toIncomingMessage(data: unknown, requiredMentionOpenId?: string): IncomingMessage | undefined {
  const event = getFeishuEvent(data);
  const message = event?.message;
  if (!message) {
    return undefined;
  }

  const messageType = message.message_type;
  const content = parseJsonObject(message.content);
  const parsed = parseMessageContent(messageType, content, message.mentions);
  if (!parsed) return undefined;
  const chatId = message.chat_id;
  const chatType = message.chat_type === "group" ? "group" : "p2p";
  if (
    chatType === "group" &&
    requiredMentionOpenId &&
    !mentionsOpenId(message.mentions, requiredMentionOpenId)
  ) {
    return undefined;
  }
  const threadId = typeof message.thread_id === "string" && message.thread_id ? message.thread_id : undefined;
  const rootMessageId = typeof message.root_id === "string" && message.root_id ? message.root_id : undefined;
  const parentMessageId = typeof message.parent_id === "string" && message.parent_id ? message.parent_id : undefined;
  const threadContext = Boolean(chatId && threadId);
  const senderId =
    event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id ?? event.sender?.sender_id?.union_id;

  if (!chatId && !senderId) {
    return undefined;
  }

  return {
    messageId: message.message_id ?? `${Date.now()}`,
    contextKey: chatId
      ? threadContext
        ? threadContextKey(chatId, threadId!)
        : `chat_id:${chatId}`
      : `open_id:${senderId}`,
    chatId,
    chatType,
    userId: senderId,
    ...(threadId ? { replyInThread: true as const } : {}),
    ...(threadContext ? { threadContext: true as const } : {}),
    ...(threadId ? { threadId } : {}),
    ...(rootMessageId ? { rootMessageId } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
    text: parsed.text,
    ...(parsed.images.length > 0 ? { images: parsed.images.map((imageKey) => ({ imageKey })) } : {}),
  };
}

function mentionsOpenId(value: unknown, openId: string): boolean {
  return Array.isArray(value) && value.some((mention) =>
    isRecord(mention) && mention.id === openId);
}

function parseMessageContent(
  messageType: unknown,
  content: Record<string, unknown>,
  mentions: unknown,
): { text: string; images: string[] } | undefined {
  if (messageType === "text") {
    const rawText = typeof content.text === "string" ? content.text : "";
    return { text: stripLeadingMentions(rawText, mentions), images: [] };
  }
  if (messageType === "image") {
    const imageKey = typeof content.image_key === "string" ? content.image_key : undefined;
    return imageKey ? { text: "", images: [imageKey] } : undefined;
  }
  if (messageType !== "post") return undefined;

  const locale = selectPostLocale(content);
  if (!locale) return undefined;
  const paragraphs: string[] = [];
  const title = typeof locale.title === "string" ? locale.title.trim() : "";
  if (title) paragraphs.push(title);
  const images: string[] = [];
  if (Array.isArray(locale.content)) {
    for (const row of locale.content) {
      if (!Array.isArray(row)) continue;
      let rowText = "";
      for (const element of row) {
        if (!isRecord(element)) continue;
        if ((element.tag === "text" || element.tag === "a") && typeof element.text === "string") {
          rowText += element.text;
        } else if (element.tag === "img" && typeof element.image_key === "string") {
          images.push(element.image_key);
        }
      }
      if (rowText.trim()) paragraphs.push(rowText.trim());
    }
  }
  return { text: paragraphs.join("\n"), images: [...new Set(images)] };
}

function selectPostLocale(content: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Array.isArray(content.content)) return content;
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    if (isRecord(content[locale])) return content[locale];
  }
  return Object.values(content).find(isRecord);
}

function stripLeadingMentions(text: string, value: unknown): string {
  if (!Array.isArray(value)) return text;
  const mentionKeys = value.flatMap((mention): string[] => {
    if (!isRecord(mention) || typeof mention.key !== "string" || !mention.key) return [];
    return [mention.key];
  });
  let remaining = text.trimStart();
  while (remaining) {
    const key = mentionKeys.find((candidate) => {
      if (!remaining.startsWith(candidate)) return false;
      const next = remaining[candidate.length];
      return next === undefined || /\s/u.test(next);
    });
    if (!key) break;
    remaining = remaining.slice(key.length).trimStart();
  }
  return remaining;
}

function toCardAction(data: unknown) {
  const event = getFeishuEvent(data);
  if (!event?.action) {
    return undefined;
  }

  const openId = event.operator?.open_id ?? event.operator?.user_id;
  const chatId = event.context?.open_chat_id ?? event.chat_id;
  return {
    actionId: getEventId(data) ?? event.action.action_id ?? event.action.name ?? `${Date.now()}`,
    contextKey: chatId ? `chat_id:${chatId}` : `open_id:${openId}`,
    userId: openId,
    ...(typeof event.context?.open_message_id === "string" ? { messageId: event.context.open_message_id } : {}),
    value: isRecord(event.action.value) ? event.action.value : {},
  };
}

function getEventId(data: unknown): string | undefined {
  const value = getNested<unknown>(data, ["header", "event_id"]) ?? getNested(data, ["data", "header", "event_id"]);
  return typeof value === "string" ? value : undefined;
}

function getFeishuEvent(data: unknown): Record<string, any> | undefined {
  return getNested<Record<string, any>>(data, ["event"]) ?? getNested(data, ["data", "event"]) ?? asRecord(data);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getNested<T>(value: unknown, path: string[]): T | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return isRecord(value) ? value : undefined;
}
