import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { FeishuOutbound } from "./types.js";

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface SendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id?: string;
  };
  error?: unknown;
}

export class FeishuMessageClient implements FeishuOutbound {
  private token?: {
    value: string;
    expiresAt: number;
  };
  private readonly sendQueues = new Map<string, Promise<void>>();
  private readonly lastSendAt = new Map<string, number>();
  private readonly minSendIntervalMs = 1200;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async sendText(contextKey: string, text: string): Promise<string | undefined> {
    return this.sendMessage(contextKey, "text", { text });
  }

  async sendMarkdown(contextKey: string, markdown: string): Promise<string | undefined> {
    return this.sendMessage(contextKey, "interactive", {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      elements: [
        {
          tag: "markdown",
          content: markdown,
        },
      ],
    });
  }

  async sendInteractiveCard(
    contextKey: string,
    card: Record<string, unknown>,
  ): Promise<string | undefined> {
    return this.sendMessage(contextKey, "interactive", card);
  }

  async updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
      }),
    });

    const payload = (await response.json()) as SendMessageResponse;
    if (!response.ok || payload.code !== 0) {
      throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "update");
    }
  }

  private async sendMessage(
    contextKey: string,
    msgType: string,
    content: Record<string, unknown>,
  ): Promise<string | undefined> {
    return this.enqueueSend(contextKey, () => this.sendMessageNow(contextKey, msgType, content));
  }

  private async sendMessageNow(
    contextKey: string,
    msgType: string,
    content: Record<string, unknown>,
  ): Promise<string | undefined> {
    const token = await this.getTenantAccessToken();
    const { receiveId, receiveIdType } = parseContextKey(contextKey);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await delay(5000 * attempt);
      }

      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: msgType,
            content: JSON.stringify(content),
          }),
        },
      );

      const payload = (await response.json()) as SendMessageResponse;
      if (response.ok && payload.code === 0) {
        return payload.data?.message_id;
      }

      const error = new FeishuApiError(payload.msg || response.statusText, payload.code, payload);
      lastError = error;

      if (!error.isRateLimit || attempt === 2) {
        this.logger.error({ payload, contextKey, msgType }, "Failed to send Feishu message.");
        throw error;
      }

      this.logger.warn(
        { code: payload.code, contextKey, msgType, attempt: attempt + 1 },
        "Feishu chat rate limit hit; retrying after backoff.",
      );
    }

    throw lastError ?? new Error("Failed to send Feishu message.");
  }

  private enqueueSend<T>(contextKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sendQueues.get(contextKey) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const lastSendAt = this.lastSendAt.get(contextKey) ?? 0;
      const elapsed = Date.now() - lastSendAt;
      if (elapsed < this.minSendIntervalMs) {
        await delay(this.minSendIntervalMs - elapsed);
      }

      const result = await task();
      this.lastSendAt.set(contextKey, Date.now());
      return result;
    });

    const stored = queued.then(
      () => undefined,
      () => undefined,
    );
    this.sendQueues.set(contextKey, stored);
    stored.finally(() => {
      if (this.sendQueues.get(contextKey) === stored) {
        this.sendQueues.delete(contextKey);
      }
    });

    return queued;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) {
      return this.token.value;
    }

    const appId = this.config.feishu.appId;
    const appSecret = this.config.feishu.appSecret;
    if (!appId || !appSecret) {
      throw new Error("Feishu appId/appSecret are required for real Feishu messaging.");
    }

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
    });

    const payload = (await response.json()) as TenantTokenResponse;
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Failed to get Feishu tenant_access_token: ${payload.msg || response.statusText}`);
    }

    this.token = {
      value: payload.tenant_access_token,
      expiresAt: now + (payload.expire ?? 7200) * 1000,
    };

    return this.token.value;
  }
}

export class FeishuApiError extends Error {
  readonly isRateLimit: boolean;

  constructor(
    message: string,
    readonly code: number,
    readonly payload: SendMessageResponse,
    operation = "send",
  ) {
    super(`Failed to ${operation} Feishu message: ${message}`);
    this.name = "FeishuApiError";
    this.isRateLimit = code === 230020 || message.toLowerCase().includes("frequency limit");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseContextKey(contextKey: string): { receiveIdType: string; receiveId: string } {
  const [receiveIdType, receiveId] = contextKey.split(":", 2);
  if (!receiveIdType || !receiveId) {
    throw new Error(`Invalid contextKey for Feishu receive_id: ${contextKey}`);
  }

  return { receiveIdType, receiveId };
}
