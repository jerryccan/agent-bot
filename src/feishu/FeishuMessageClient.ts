import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { LOCAL_CARD_IMAGE_PATH } from "./LocalCardImage.js";
import { renderMarkdownWithLocalImages } from "./LocalImageMarkdown.js";
import type {
  CreatedGroup,
  CreateGroupInput,
  FeishuOutbound,
  MessageReplyTarget,
} from "./types.js";

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

interface CreateGroupResponse {
  code: number;
  msg: string;
  data?: {
    chat_id?: string;
  };
  error?: unknown;
}

interface UploadImageResponse {
  code: number;
  msg: string;
  data?: {
    image_key?: string;
  };
  error?: unknown;
}

interface ReactionResponse {
  code: number;
  msg: string;
  data?: {
    reaction_id?: string;
  };
  error?: unknown;
}

interface DownloadImageErrorResponse {
  code: number;
  msg: string;
  error?: unknown;
}

export class FeishuMessageClient implements FeishuOutbound {
  private token?: {
    value: string;
    expiresAt: number;
  };
  private readonly sendQueues = new Map<string, Promise<void>>();
  private readonly lastSendAt = new Map<string, number>();
  private readonly imageUploads = new Map<string, { mtimeMs: number; upload: Promise<string> }>();
  private readonly imageDownloads = new Map<string, Promise<string>>();
  private readonly minSendIntervalMs = 1200;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async createGroup(input: CreateGroupInput): Promise<CreatedGroup> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        "https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            chat_mode: "group",
            chat_type: "private",
            name: input.name,
            user_id_list: [input.userOpenId],
          }),
        },
      );
      const payload = (await response.json()) as CreateGroupResponse;
      const chatId = payload.data?.chat_id;
      if (!response.ok || payload.code !== 0 || !chatId) {
        throw new FeishuApiError(
          payload.msg || response.statusText,
          payload.code,
          payload,
          "create group",
          response.status,
        );
      }
      return { chatId, name: input.name };
    } catch (error) {
      throw normalizeTransportError(error, "create group");
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
        },
      );
      const payload = (await response.json()) as ReactionResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "add reaction", response.status);
      }
      return payload.data?.reaction_id;
    } catch (error) {
      throw normalizeTransportError(error, "add reaction");
    }
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const payload = (await response.json()) as ReactionResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "delete reaction", response.status);
      }
    } catch (error) {
      throw normalizeTransportError(error, "delete reaction");
    }
  }

  async downloadImage(messageId: string, imageKey: string): Promise<string> {
    const cacheKey = `${messageId}:${imageKey}`;
    const cached = this.imageDownloads.get(cacheKey);
    if (cached) return cached;
    const download = this.downloadImageNow(messageId, imageKey).catch((error: unknown) => {
      if (this.imageDownloads.get(cacheKey) === download) this.imageDownloads.delete(cacheKey);
      throw error;
    });
    this.imageDownloads.set(cacheKey, download);
    return download;
  }

  async sendText(contextKey: string, text: string): Promise<string | undefined> {
    return this.sendMessage(contextKey, "text", { text });
  }

  async sendMarkdown(contextKey: string, markdown: string, idempotencyKey?: string): Promise<string | undefined> {
    const elements = await renderMarkdownWithLocalImages(
      markdown,
      (filePath) => this.uploadImageCached(filePath),
      (error, filePath) => this.logger.warn({ error, filePath }, "Failed to upload local image to Feishu."),
    );
    return this.sendMessage(contextKey, "interactive", finalAnswerCard(elements), idempotencyKey);
  }

  async sendInteractiveCard(
    contextKey: string,
    card: Record<string, unknown>,
  ): Promise<string | undefined> {
    return this.sendMessage(contextKey, "interactive", await this.prepareInteractiveCard(card));
  }

  async replyText(
    contextKey: string,
    target: MessageReplyTarget,
    text: string,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return this.replyMessage(contextKey, target, "text", { text }, idempotencyKey);
  }

  async replyMarkdown(
    contextKey: string,
    target: MessageReplyTarget,
    markdown: string,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    const elements = await renderMarkdownWithLocalImages(
      markdown,
      (filePath) => this.uploadImageCached(filePath),
      (error, filePath) => this.logger.warn({ error, filePath }, "Failed to upload local image to Feishu."),
    );
    return this.replyMessage(contextKey, target, "interactive", finalAnswerCard(elements), idempotencyKey);
  }

  async replyInteractiveCard(
    contextKey: string,
    target: MessageReplyTarget,
    card: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return this.replyMessage(
      contextKey,
      target,
      "interactive",
      await this.prepareInteractiveCard(card),
      idempotencyKey,
    );
  }

  async updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    try {
      const preparedCard = await this.prepareInteractiveCard(card);
      const token = await this.getTenantAccessToken();
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ content: JSON.stringify(preparedCard) }),
      });
      const payload = (await response.json()) as SendMessageResponse;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "update", response.status);
      }
    } catch (error) {
      throw normalizeTransportError(error, "update");
    }
  }

  private async sendMessage(
    contextKey: string,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return this.enqueueSend(contextKey, () => this.sendMessageNow(contextKey, msgType, content, idempotencyKey));
  }

  private async replyMessage(
    contextKey: string,
    target: MessageReplyTarget,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    return this.enqueueSend(contextKey, () =>
      this.replyMessageNow(target, msgType, content, idempotencyKey));
  }

  private async replyMessageNow(
    target: MessageReplyTarget,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    let token: string;
    try {
      token = await this.getTenantAccessToken();
    } catch (error) {
      throw normalizeTransportError(error, "reply");
    }
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await delay(5000 * attempt);

      let error: FeishuApiError;
      try {
        const response = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}/reply`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              msg_type: msgType,
              content: JSON.stringify(content),
              reply_in_thread: target.replyInThread,
              ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
            }),
          },
        );
        const payload = (await response.json()) as SendMessageResponse;
        if (response.ok && payload.code === 0) return payload.data?.message_id;
        error = new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "reply", response.status);
      } catch (caught) {
        error = normalizeTransportError(caught, "reply");
      }
      lastError = error;

      if (!error.isRetryable || attempt === 2) {
        this.logger.error({ error, messageId: target.messageId, msgType }, "Failed to reply to Feishu message.");
        throw error;
      }
      this.logger.warn(
        { code: error.code, messageId: target.messageId, msgType, attempt: attempt + 1 },
        "Retryable Feishu reply failure; retrying after backoff.",
      );
    }

    throw lastError ?? new Error("Failed to reply to Feishu message.");
  }

  private async sendMessageNow(
    contextKey: string,
    msgType: string,
    content: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    let token: string;
    try {
      token = await this.getTenantAccessToken();
    } catch (error) {
      throw normalizeTransportError(error, "send");
    }
    const { receiveId, receiveIdType } = parseContextKey(contextKey);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await delay(5000 * attempt);
      }

      let error: FeishuApiError;
      try {
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
              ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
            }),
          },
        );
        const payload = (await response.json()) as SendMessageResponse;
        if (response.ok && payload.code === 0) return payload.data?.message_id;
        error = new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "send", response.status);
      } catch (caught) {
        error = normalizeTransportError(caught, "send");
      }
      lastError = error;

      if (!error.isRetryable || attempt === 2) {
        this.logger.error({ error, contextKey, msgType }, "Failed to send Feishu message.");
        throw error;
      }

      this.logger.warn(
        { code: error.code, contextKey, msgType, attempt: attempt + 1 },
        "Retryable Feishu send failure; retrying after backoff.",
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

  private async uploadImage(filePath: string): Promise<string> {
    try {
      const contents = await readFile(filePath);
      if (contents.byteLength > 10 * 1024 * 1024) {
        throw new Error(`Image exceeds Feishu's 10 MiB limit: ${filePath}`);
      }
      const token = await this.getTenantAccessToken();
      const form = new FormData();
      form.append("image_type", "message");
      form.append("image", new Blob([new Uint8Array(contents)]), path.basename(filePath));
      const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const payload = (await response.json()) as UploadImageResponse;
      const imageKey = payload.data?.image_key;
      if (!response.ok || payload.code !== 0 || !imageKey) {
        throw new FeishuApiError(payload.msg || response.statusText, payload.code, payload, "upload image", response.status);
      }
      return imageKey;
    } catch (error) {
      throw normalizeTransportError(error, "upload image");
    }
  }

  private async downloadImageNow(messageId: string, imageKey: string): Promise<string> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({
          code: response.status,
          msg: response.statusText,
        })) as DownloadImageErrorResponse;
        throw new FeishuApiError(
          payload.msg || response.statusText,
          payload.code,
          payload,
          "download image",
          response.status,
        );
      }

      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!contentType.startsWith("image/")) {
        throw new Error(`Feishu returned an unexpected image content type: ${contentType || "unknown"}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("Feishu returned an empty image.");
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Feishu image exceeds the 20 MiB input limit.");

      const sqlitePath = this.config.storage?.sqlitePath ?? path.resolve("data/agent-bot.sqlite");
      const directory = path.join(path.dirname(sqlitePath), "inbound-images");
      await mkdir(directory, { recursive: true });
      const digest = createHash("sha256").update(`${messageId}:${imageKey}`).digest("hex");
      const filePath = path.join(directory, `${digest}${imageExtension(contentType)}`);
      await writeFile(filePath, bytes);
      return filePath;
    } catch (error) {
      throw normalizeTransportError(error, "download image");
    }
  }

  private async uploadImageCached(filePath: string): Promise<string> {
    const cacheKey = path.resolve(filePath);
    const mtimeMs = (await stat(cacheKey)).mtimeMs;
    const cached = this.imageUploads.get(cacheKey);
    if (cached?.mtimeMs === mtimeMs) return cached.upload;
    const upload = this.uploadImage(cacheKey).catch((error: unknown) => {
      if (this.imageUploads.get(cacheKey)?.upload === upload) this.imageUploads.delete(cacheKey);
      throw error;
    });
    this.imageUploads.set(cacheKey, { mtimeMs, upload });
    return upload;
  }

  private async prepareInteractiveCard(card: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.prepareCardValue(card) as Record<string, unknown>;
  }

  private async prepareCardValue(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.prepareCardValue(item)));
    if (!isRecord(value)) return value;
    const localImagePath = value[LOCAL_CARD_IMAGE_PATH];
    if (value.tag === "img" && typeof localImagePath === "string") {
      const image = { ...value };
      delete image[LOCAL_CARD_IMAGE_PATH];
      try {
        image.img_key = await this.uploadImageCached(localImagePath);
        return image;
      } catch (error) {
        this.logger.warn({ error, filePath: localImagePath }, "Failed to upload local card image to Feishu.");
        return { tag: "markdown", content: `图片加载失败：${cardImageLabel(value)}` };
      }
    }
    const prepared: Record<string, unknown> = {};
    await Promise.all(Object.entries(value).map(async ([key, child]) => {
      prepared[key] = await this.prepareCardValue(child);
    }));
    return prepared;
  }
}

export class FeishuApiError extends Error {
  readonly isRateLimit: boolean;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    readonly code: number,
    readonly payload:
      | SendMessageResponse
      | CreateGroupResponse
      | UploadImageResponse
      | ReactionResponse
      | DownloadImageErrorResponse,
    operation = "send",
    readonly httpStatus?: number,
    forceRetryable = false,
  ) {
    super(`Failed to ${operation} Feishu message: ${message}`);
    this.name = "FeishuApiError";
    this.isRateLimit = code === 230020 || message.toLowerCase().includes("frequency limit");
    this.isRetryable = forceRetryable || this.isRateLimit || (httpStatus !== undefined && httpStatus >= 500);
  }
}

function imageExtension(contentType: string): string {
  switch (contentType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/bmp": return ".bmp";
    case "image/tiff": return ".tiff";
    default: return ".img";
  }
}

function normalizeTransportError(error: unknown, operation: string): FeishuApiError {
  if (error instanceof FeishuApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FeishuApiError(message, 0, { code: 0, msg: message, error }, operation, undefined, true);
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

function finalAnswerCard(elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
    },
    body: {
      elements,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cardImageLabel(image: Record<string, unknown>): string {
  const alt = image.alt;
  if (isRecord(alt) && typeof alt.content === "string" && alt.content.trim()) return alt.content;
  return "view_image 图片";
}
