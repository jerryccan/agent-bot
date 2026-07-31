import { describe, expect, test, vi } from "vitest";
import { registerFeishuApp, type FeishuAppRegistrationChallenge } from "../../src/cli/FeishuAppRegistration.js";

describe("registerFeishuApp", () => {
  test("starts a PersonalAgent registration and returns the issued credentials", async () => {
    const requests: Array<{ url: string; body: URLSearchParams }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: new URLSearchParams(String(init?.body)),
      });
      if (requests.length === 1) {
        return jsonResponse({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH",
          expire_in: 600,
          interval: 5,
        });
      }
      return jsonResponse({
        client_id: "cli_created",
        client_secret: "secret-created",
        user_info: {
          open_id: "ou_initializer",
          tenant_brand: "feishu",
        },
      });
    });
    const challenges: FeishuAppRegistrationChallenge[] = [];

    const result = await registerFeishuApp({
      fetch: fetchMock as typeof fetch,
      onVerification: (challenge) => {
        challenges.push(challenge);
      },
    });

    expect(result).toEqual({
      appId: "cli_created",
      appSecret: "secret-created",
      userOpenId: "ou_initializer",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
    expect(Object.fromEntries(requests[0]!.body)).toEqual({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id tenant_brand",
    });
    expect(Object.fromEntries(requests[1]!.body)).toEqual({
      action: "poll",
      device_code: "device-code",
    });
    expect(challenges).toEqual([
      {
        verificationUrl: "https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH",
        userCode: "ABCD-EFGH",
        expiresIn: 600,
        interval: 5,
      },
    ]);
  });

  test("polls through pending and slow_down responses", async () => {
    const responses = [
      {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        expire_in: 30,
        interval: 1,
      },
      { error: "authorization_pending" },
      { error: "slow_down" },
      { client_id: "cli_created", client_secret: "secret-created" },
    ];
    const fetchMock = vi.fn(async () => jsonResponse(responses.shift()));
    const waits: number[] = [];
    let verificationUrl = "";

    await expect(
      registerFeishuApp({
        fetch: fetchMock as typeof fetch,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
        onVerification: (challenge) => {
          verificationUrl = challenge.verificationUrl;
        },
      }),
    ).resolves.toEqual({
      appId: "cli_created",
      appSecret: "secret-created",
    });

    expect(waits).toEqual([1_000, 6_000]);
    expect(verificationUrl).toBe("https://open.feishu.cn/page/cli?user_code=ABCD-EFGH&from=cli");
  });

  test("reports rejection without continuing to poll", async () => {
    const responses = [{ device_code: "device-code", user_code: "ABCD-EFGH", interval: 1 }, { error: "access_denied" }];
    const fetchMock = vi.fn(async () => jsonResponse(responses.shift()));

    await expect(
      registerFeishuApp({
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow("Lark app creation was cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("rejects an invalid begin response before displaying a link", async () => {
    const onVerification = vi.fn();

    await expect(
      registerFeishuApp({
        fetch: vi.fn(async () => jsonResponse({ user_code: "ABCD-EFGH" })) as typeof fetch,
        onVerification,
      }),
    ).rejects.toThrow("missing device_code or user_code");
    expect(onVerification).not.toHaveBeenCalled();
  });

  test("stops promptly when initialization is canceled during a polling wait", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        fetchMock.mock.calls.length === 1
          ? { device_code: "device-code", user_code: "ABCD-EFGH", interval: 5 }
          : { error: "authorization_pending" },
      ),
    );
    const neverFinishes = new Promise<void>(() => undefined);

    const registration = registerFeishuApp({
      fetch: fetchMock as typeof fetch,
      signal: controller.signal,
      sleep: () => neverFinishes,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort(new Error("Initialization was cancelled."));

    await expect(registration).rejects.toThrow("Initialization was cancelled");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
