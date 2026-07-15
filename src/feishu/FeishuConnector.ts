import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { FeishuEventHandler, IncomingMessage } from "./types.js";

export class FeishuConnector {
  constructor(
    private readonly config: AppConfig,
    private readonly handler: FeishuEventHandler,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const { appId, appSecret } = this.config.feishu;
    if (!appId || !appSecret) {
      throw new Error("Feishu appId/appSecret are required.");
    }

    await this.startFeishuWs(appId, appSecret);
  }

  stop(): void {
    // SDK connector currently relies on process lifetime.
  }

  private async startFeishuWs(appId: string, appSecret: string): Promise<void> {
    const lark = (await import("@larksuiteoapi/node-sdk")) as Record<string, any>;
    const wsClient = new lark.WSClient({ appId, appSecret });
    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        const message = toIncomingMessage(data);
        if (!message) {
          this.logger.debug({ data }, "Ignored unsupported Feishu message event.");
          return;
        }

        try {
          await this.handler.onMessage(message);
        } catch (error) {
          this.logger.error({ error, messageId: message.messageId }, "Failed to handle Feishu message event.");
        }
      },
      "card.action.trigger": async (data: unknown) => {
        const action = toCardAction(data);
        if (!action) {
          this.logger.debug({ data }, "Ignored unsupported Feishu card action.");
          return {};
        }

        try {
          await this.handler.onCardAction(action);
        } catch (error) {
          this.logger.error({ error, actionId: action.actionId }, "Failed to handle Feishu card action.");
        }
        return {
          toast: {
            type: "success",
            content: "已处理",
          },
        };
      },
    });

    wsClient.start({ eventDispatcher });
    this.logger.info("Feishu WebSocket connector started.");
  }
}

function toIncomingMessage(data: unknown): IncomingMessage | undefined {
  const event = getFeishuEvent(data);
  const message = event?.message;
  if (!message) {
    return undefined;
  }

  const messageType = message.message_type;
  if (messageType !== "text") {
    return undefined;
  }

  const content = parseJsonObject(message.content);
  const text = typeof content.text === "string" ? content.text : "";
  const chatId = message.chat_id;
  const senderId =
    event.sender?.sender_id?.open_id ??
    event.sender?.sender_id?.user_id ??
    event.sender?.sender_id?.union_id;

  if (!chatId && !senderId) {
    return undefined;
  }

  return {
    messageId: message.message_id ?? `${Date.now()}`,
    contextKey: chatId ? `chat_id:${chatId}` : `open_id:${senderId}`,
    chatId,
    userId: senderId,
    text,
  };
}

function toCardAction(data: unknown) {
  const event = getFeishuEvent(data);
  if (!event?.action) {
    return undefined;
  }

  const openId = event.operator?.open_id ?? event.operator?.user_id;
  const chatId = event.context?.open_chat_id ?? event.chat_id;
  return {
    actionId: event.action.name ?? `${Date.now()}`,
    contextKey: chatId ? `chat_id:${chatId}` : `open_id:${openId}`,
    userId: openId,
    ...(typeof event.context?.open_message_id === "string" ? { messageId: event.context.open_message_id } : {}),
    value: isRecord(event.action.value) ? event.action.value : {},
  };
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
