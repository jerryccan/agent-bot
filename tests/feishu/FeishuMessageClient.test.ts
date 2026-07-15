import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { FeishuApiError, FeishuMessageClient } from "../../src/feishu/FeishuMessageClient.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

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
