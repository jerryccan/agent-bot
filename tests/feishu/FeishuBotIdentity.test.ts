import { describe, expect, test, vi } from "vitest";
import { resolveFeishuBotOpenId } from "../../src/feishu/FeishuBotIdentity.js";

describe("resolveFeishuBotOpenId", () => {
  test("resolves the current bot open ID without additional scopes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        tenant_access_token: "tenant-token",
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        bot: { open_id: "ou_bot" },
      }));

    await expect(resolveFeishuBotOpenId("cli_app", "secret", fetchMock)).resolves.toBe("ou_bot");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ app_id: "cli_app", app_secret: "secret" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/bot/v3/info",
      { headers: { Authorization: "Bearer tenant-token" } },
    );
  });

  test("rejects a bot information response without an open ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        tenant_access_token: "tenant-token",
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok", bot: {} }));

    await expect(resolveFeishuBotOpenId("cli_app", "secret", fetchMock)).rejects.toThrow(
      "Failed to get Lark bot information",
    );
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}
