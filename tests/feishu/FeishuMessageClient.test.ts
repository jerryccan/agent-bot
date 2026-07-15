import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { FeishuApiError, FeishuMessageClient } from "../../src/feishu/FeishuMessageClient.js";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FeishuMessageClient", () => {
  test("passes a stable UUID with an idempotent final message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    await client.sendMarkdown("chat_id:c1", "answer", "stable-uuid");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.uuid).toBe("stable-uuid");
  });

  test("classifies network failures during card update as retryable", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockRejectedValueOnce(new Error("socket reset"));
    const client = new FeishuMessageClient(config(), logger());
    const error = await client.updateInteractiveCard("om_1", {}).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(FeishuApiError);
    expect((error as FeishuApiError).isRetryable).toBe(true);
  });

  test("uploads local screenshots and sends previewable image elements with the stable UUID", async () => {
    const imagePath = createImage("screen.png");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_screen" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_image" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendMarkdown("chat_id:c1", `前文\n[屏幕截图](${markdownPath(imagePath)})\n后文`, "image-uuid");

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/open-apis/im/v1/images");
    const uploadBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(uploadBody).toBeInstanceOf(FormData);
    expect((uploadBody as FormData).get("image_type")).toBe("message");
    const messageBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(messageBody.content)) as { elements: Array<Record<string, unknown>> };
    expect(messageBody.uuid).toBe("image-uuid");
    expect(card.elements.map((element) => element.tag)).toEqual(["markdown", "img", "markdown"]);
    expect(card.elements[1]).toEqual(expect.objectContaining({ img_key: "img_screen", preview: true }));
  });

  test("sends the remaining answer with a visible notice when image upload fails", async () => {
    const imagePath = createImage("failed.png");
    const testLogger = logger();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 234001, msg: "bad image" }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_fallback" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), testLogger);

    await client.sendMarkdown("chat_id:c1", `答案 [失败截图](${markdownPath(imagePath)}) 继续`, "fallback-uuid");

    const messageBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(String(messageBody.content)).toContain("图片上传失败：失败截图");
    expect(String(messageBody.content)).toContain("答案");
    expect(String(messageBody.content)).toContain("继续");
    expect(testLogger.warn).toHaveBeenCalled();
  });
});

function response(payload: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => payload };
}

function config(): AppConfig {
  return { feishu: { appId: "cli_app", appSecret: "secret" } } as unknown as AppConfig;
}

function logger(): Logger {
  return { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

function createImage(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-client-image-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, "fake image");
  return filePath;
}

function markdownPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
