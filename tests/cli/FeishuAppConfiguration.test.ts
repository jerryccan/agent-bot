import { gunzipSync } from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import {
  ensureFeishuAppConfiguration,
  missingFeishuAppConfiguration,
  REQUIRED_FEISHU_CALLBACKS,
  REQUIRED_FEISHU_EVENTS,
  REQUIRED_FEISHU_SCOPES,
  type FeishuConfigurationChallenge,
} from "../../src/cli/FeishuAppConfiguration.js";

const credentials = {
  appId: "cli_created",
  appSecret: "secret-created",
};

describe("ensureFeishuAppConfiguration", () => {
  test("accepts an application that already has every required configuration", async () => {
    const fetchMock = configurationFetch(() => completeConfiguration());
    const onVerification = vi.fn();

    await expect(
      ensureFeishuAppConfiguration(credentials, {
        fetch: fetchMock,
        onVerification,
      }),
    ).resolves.toEqual({
      status: "ready",
      configuration: {
        scopes: [...REQUIRED_FEISHU_SCOPES].sort(),
        events: [...REQUIRED_FEISHU_EVENTS].sort(),
        callbacks: [...REQUIRED_FEISHU_CALLBACKS].sort(),
      },
      added: {
        scopes: [],
        events: [],
        callbacks: [],
      },
      remaining: {
        scopes: [],
        events: [],
        callbacks: [],
      },
    });
    expect(onVerification).not.toHaveBeenCalled();
  });

  test("builds an incremental launcher link without waiting for optional configuration", async () => {
    const fetchMock = configurationFetch(() => ({
      scopes: REQUIRED_FEISHU_SCOPES.filter((scope) => scope !== "im:chat:create"),
      events: ["im.message.receive_v1"],
      callbacks: [],
    }));
    let challenge: FeishuConfigurationChallenge | undefined;
    const sleep = vi.fn(async () => undefined);

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep,
      onVerification: (value) => {
        challenge = value;
      },
    });

    expect(result.status).toBe("partial");
    expect(result.added).toEqual({
      scopes: [],
      events: [],
      callbacks: [],
    });
    expect(result.remaining).toEqual({
      scopes: ["im:chat:create"],
      events: ["im.chat.updated_v1"],
      callbacks: ["card.action.trigger"],
    });
    expect(challenge?.missing).toEqual(result.remaining);
    expect(challenge?.blocking).toBe(false);
    expect(sleep).not.toHaveBeenCalled();

    const url = new URL(challenge!.verificationUrl);
    expect(url.origin + url.pathname).toBe("https://open.feishu.cn/page/launcher");
    expect(url.searchParams.get("clientID")).toBe(credentials.appId);
    expect(challenge!.verificationUrl).not.toContain(credentials.appSecret);
    const manifest = decodeAddons(url.searchParams.get("addons")!);
    expect(manifest).toEqual({
      scopes: {
        tenant: ["im:chat:create"],
        user: [],
      },
      events: {
        items: {
          tenant: ["im.chat.updated_v1"],
          user: [],
        },
      },
      callbacks: {
        items: ["card.action.trigger"],
      },
    });
  });

  test("waits for core configuration but returns when optional items remain", async () => {
    let coreConfigured = false;
    const fetchMock = configurationFetch(() => ({
      scopes: REQUIRED_FEISHU_SCOPES.filter(
        (scope) => scope !== "im:chat:create" && (coreConfigured || scope !== "im:message.p2p_msg:readonly"),
      ),
      events: ["im.message.receive_v1"],
      callbacks: [],
    }));
    const challenges: FeishuConfigurationChallenge[] = [];

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep: async () => {
        coreConfigured = true;
      },
      onVerification: (value) => {
        challenges.push(value);
      },
    });

    expect(challenges).toHaveLength(2);
    expect(challenges[0]).toMatchObject({
      blocking: true,
      missing: {
        scopes: ["im:message.p2p_msg:readonly"],
        events: [],
        callbacks: [],
      },
    });
    expect(challenges[1]).toMatchObject({
      blocking: false,
      missing: {
        scopes: ["im:chat:create"],
        events: ["im.chat.updated_v1"],
        callbacks: ["card.action.trigger"],
      },
    });
    expect(result.status).toBe("partial");
    expect(result.added).toEqual({
      scopes: ["im:message.p2p_msg:readonly"],
      events: [],
      callbacks: [],
    });
    expect(result.remaining).toEqual({
      scopes: ["im:chat:create"],
      events: ["im.chat.updated_v1"],
      callbacks: ["card.action.trigger"],
    });
  });

  test("does not treat configuration from an unpublished draft as active", async () => {
    let configured = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({
          code: 0,
          msg: "success",
          tenant_access_token: "tenant-token",
        });
      }
      if (url.includes("/app_versions?")) {
        const active = configured ? completeConfiguration() : { scopes: [], events: [], callbacks: [] };
        return jsonResponse({
          code: 0,
          msg: "success",
          data: {
            items: [
              {
                status: 4,
                publish_time: null,
                scopes: REQUIRED_FEISHU_SCOPES.map((scope) => ({ scope, token_types: ["tenant"] })),
                event_infos: REQUIRED_FEISHU_EVENTS.map((eventType) => ({ event_type: eventType })),
              },
              {
                status: 1,
                publish_time: "2026-07-26T00:00:00Z",
                scopes: active.scopes.map((scope) => ({ scope, token_types: ["tenant"] })),
                event_infos: active.events.map((eventType) => ({ event_type: eventType })),
              },
            ],
          },
        });
      }
      return jsonResponse({
        code: 0,
        msg: "success",
        data: {
          app: {
            callback_info: {
              subscribed_callbacks: configured ? REQUIRED_FEISHU_CALLBACKS : [],
            },
          },
        },
      });
    }) as typeof fetch;
    let challenge: FeishuConfigurationChallenge | undefined;

    await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep: async () => {
        configured = true;
      },
      onVerification: (value) => {
        challenge = value;
      },
    });

    expect(challenge).toMatchObject({
      blocking: true,
      missing: coreMissingConfiguration(),
    });
  });

  test("requests the core manifest when application metadata lacks inspection permission", async () => {
    let configured = false;
    const fetchMock = configurationFetch(
      () => completeConfiguration(),
      () => (configured ? undefined : jsonResponse({ code: 99991672, msg: "Access denied: scope missing" }, 400)),
    );
    let challenge: FeishuConfigurationChallenge | undefined;

    await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep: async () => {
        configured = true;
      },
      onVerification: (value) => {
        challenge = value;
      },
    });

    expect(challenge).toMatchObject({
      blocking: true,
      missing: coreMissingConfiguration(),
    });
  });

  test("stops promptly when configuration completion is canceled", async () => {
    const controller = new AbortController();
    const fetchMock = configurationFetch(() => ({
      scopes: [],
      events: [],
      callbacks: [],
    }));
    const neverFinishes = new Promise<void>(() => undefined);

    const completion = ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      signal: controller.signal,
      sleep: () => neverFinishes,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controller.abort(new Error("Initialization was cancelled."));

    await expect(completion).rejects.toThrow("Initialization was cancelled");
  });
});

describe("missingFeishuAppConfiguration", () => {
  test("accepts broader legacy scopes that satisfy the required operations", () => {
    expect(
      missingFeishuAppConfiguration({
        scopes: [
          "application:application:self_manage",
          "im:chat",
          "im:message",
          "im:message.group_at_msg",
          "im:message.p2p_msg",
          "im:resource:upload",
        ],
        events: [...REQUIRED_FEISHU_EVENTS],
        callbacks: [...REQUIRED_FEISHU_CALLBACKS],
      }),
    ).toEqual({
      scopes: [],
      events: [],
      callbacks: [],
    });
  });
});

interface ConfigurationFixture {
  scopes: readonly string[];
  events: readonly string[];
  callbacks: readonly string[];
}

function completeConfiguration(): ConfigurationFixture {
  return {
    scopes: REQUIRED_FEISHU_SCOPES,
    events: REQUIRED_FEISHU_EVENTS,
    callbacks: REQUIRED_FEISHU_CALLBACKS,
  };
}

function coreMissingConfiguration(): FeishuConfigurationChallenge["missing"] {
  return {
    scopes: [
      "application:application:self_manage",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
    ],
    events: ["im.message.receive_v1"],
    callbacks: [],
  };
}

function configurationFetch(
  current: () => ConfigurationFixture,
  applicationOverride?: () => Response | undefined,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({
        code: 0,
        msg: "success",
        tenant_access_token: "tenant-token",
      });
    }

    const fixture = current();
    if (url.includes("/app_versions?")) {
      return jsonResponse({
        code: 0,
        msg: "success",
        data: {
          items: [
            {
              status: 1,
              publish_time: "2026-07-27T00:00:00Z",
              scopes: fixture.scopes.map((scope) => ({
                scope,
                token_types: ["tenant"],
              })),
              event_infos: fixture.events.map((eventType) => ({ event_type: eventType })),
            },
          ],
        },
      });
    }

    const override = applicationOverride?.();
    if (override) return override;
    return jsonResponse({
      code: 0,
      msg: "success",
      data: {
        app: {
          callback_info: {
            subscribed_callbacks: fixture.callbacks,
          },
        },
      },
    });
  }) as typeof fetch;
}

function decodeAddons(value: string): unknown {
  return JSON.parse(gunzipSync(Buffer.from(value, "base64url")).toString("utf8")) as unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
