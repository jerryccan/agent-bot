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

  test("does not request all-group-message permission in mention-only mode", async () => {
    const fetchMock = configurationFetch(() => ({
      ...completeConfiguration(),
      scopes: REQUIRED_FEISHU_SCOPES.filter((scope) => scope !== "im:message.group_msg"),
    }));
    const onVerification = vi.fn();

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      respondToAllGroupMessages: false,
      onVerification,
    });

    expect(result.status).toBe("ready");
    expect(result.remaining).toEqual({ scopes: [], events: [], callbacks: [] });
    expect(onVerification).not.toHaveBeenCalled();
  });

  test("keeps all-group-message permission out of other authorization links in mention-only mode", async () => {
    const optionalSkip = new AbortController();
    const fetchMock = configurationFetch(() => {
      const configuration = configurationWithoutOptionalCapabilities();
      return {
        ...configuration,
        scopes: configuration.scopes.filter((scope) => scope !== "im:message.group_msg"),
      };
    });
    const challenges: FeishuConfigurationChallenge[] = [];

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      respondToAllGroupMessages: false,
      optionalSkipSignal: optionalSkip.signal,
      onVerification: (challenge) => {
        challenges.push(challenge);
        optionalSkip.abort();
      },
    });

    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ kind: "launcher", blocking: false });
    expect(challenges[0]?.missing.scopes).not.toContain("im:message.group_msg");
    expect(result.remaining.scopes).not.toContain("im:message.group_msg");
  });

  test("builds an incremental launcher link and continues when optional configuration is skipped", async () => {
    const fetchMock = configurationFetch(() => ({
      scopes: REQUIRED_FEISHU_SCOPES.filter((scope) => scope !== "im:chat:create"),
      events: ["im.message.receive_v1"],
      callbacks: [],
    }));
    let challenge: FeishuConfigurationChallenge | undefined;
    const sleep = vi.fn(async () => undefined);
    const optionalSkip = new AbortController();

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep,
      optionalSkipSignal: optionalSkip.signal,
      onVerification: (value) => {
        challenge = value;
        optionalSkip.abort();
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
    expect(challenge?.kind).toBe("launcher");
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

  test("waits for optional configuration when authorization is accepted", async () => {
    let configured = false;
    const fetchMock = configurationFetch(
      () => configured ? completeConfiguration() : configurationWithoutOptionalCapabilities(),
    );
    const sleep = vi.fn(async () => {
      configured = true;
    });

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep,
    });

    expect(sleep).toHaveBeenCalledOnce();
    expect(result.status).toBe("updated");
    expect(result.added).toEqual({
      scopes: ["im:chat:create"],
      events: ["im.chat.updated_v1"],
      callbacks: ["card.action.trigger"],
    });
    expect(result.remaining).toEqual({
      scopes: [],
      events: [],
      callbacks: [],
    });
  });

  test("continues when accepted optional configuration does not become active before timeout", async () => {
    const fetchMock = configurationFetch(() => configurationWithoutOptionalCapabilities());
    const sleep = vi.fn(async () => undefined);

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      optionalTimeoutMs: 2,
      sleep,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("partial");
    expect(result.remaining).toEqual({
      scopes: ["im:chat:create"],
      events: ["im.chat.updated_v1"],
      callbacks: ["card.action.trigger"],
    });
  });

  test("stops an active optional wait when the user skips authorization", async () => {
    const optionalSkip = new AbortController();
    const fetchMock = configurationFetch(() => configurationWithoutOptionalCapabilities());
    const sleep = vi.fn(async () => {
      optionalSkip.abort();
    });

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      optionalTimeoutMs: 10,
      sleep,
      optionalSkipSignal: optionalSkip.signal,
    });

    expect(sleep).toHaveBeenCalledOnce();
    expect(result.status).toBe("partial");
    expect(result.remaining).toEqual({
      scopes: ["im:chat:create"],
      events: ["im.chat.updated_v1"],
      callbacks: ["card.action.trigger"],
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
    const optionalSkip = new AbortController();

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep: async () => {
        coreConfigured = true;
      },
      optionalSkipSignal: optionalSkip.signal,
      onVerification: (value) => {
        challenges.push(value);
        if (!value.blocking) optionalSkip.abort();
      },
    });

    expect(challenges).toHaveLength(2);
    expect(challenges[0]).toMatchObject({
      kind: "launcher",
      blocking: true,
      missing: {
        scopes: ["im:message.p2p_msg:readonly"],
        events: [],
        callbacks: [],
      },
    });
    expect(challenges[1]).toMatchObject({
      kind: "launcher",
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

  test("requires all-user group messages when an app can only receive mentions", async () => {
    let configured = false;
    const mentionOnlyScopes = REQUIRED_FEISHU_SCOPES
      .filter((scope) => scope !== "im:message.group_msg")
      .concat("im:message.group_at_msg:readonly");
    const fetchMock = configurationFetch(() => ({
      scopes: configured ? REQUIRED_FEISHU_SCOPES : mentionOnlyScopes,
      events: REQUIRED_FEISHU_EVENTS,
      callbacks: REQUIRED_FEISHU_CALLBACKS,
    }));
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
      kind: "manual_scope",
      blocking: true,
      missing: {
        scopes: ["im:message.group_msg"],
        events: [],
        callbacks: [],
      },
    });
    const url = new URL(challenge!.verificationUrl);
    expect(url.origin + url.pathname).toBe("https://open.feishu.cn/app/cli_created/auth");
    expect(url.searchParams.get("q")).toBe("im:message.group_msg");
    expect(url.searchParams.get("op_from")).toBe("openapi");
    expect(url.searchParams.get("token_type")).toBe("tenant");
    expect(url.searchParams.has("addons")).toBe(false);
  });

  test("continues with a partial result when manual group-message permission waiting is skipped", async () => {
    const manualPermissionSkip = new AbortController();
    const scopes = REQUIRED_FEISHU_SCOPES.filter((scope) => scope !== "im:message.group_msg");
    const fetchMock = configurationFetch(() => ({
      scopes,
      events: REQUIRED_FEISHU_EVENTS,
      callbacks: REQUIRED_FEISHU_CALLBACKS,
    }));
    const sleep = vi.fn(async () => undefined);

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      manualPermissionSkipSignal: manualPermissionSkip.signal,
      pollIntervalMs: 1,
      sleep,
      onVerification: (challenge) => {
        if (challenge.kind === "manual_scope") manualPermissionSkip.abort();
      },
    });

    expect(sleep).not.toHaveBeenCalled();
    expect(result.status).toBe("partial");
    expect(result.added).toEqual({ scopes: [], events: [], callbacks: [] });
    expect(result.remaining).toEqual({
      scopes: ["im:message.group_msg"],
      events: [],
      callbacks: [],
    });
  });

  test("keeps waiting for other core configuration after manual permission waiting is skipped", async () => {
    const manualPermissionSkip = new AbortController();
    let privateMessagesReady = false;
    const fetchMock = configurationFetch(() => ({
      scopes: REQUIRED_FEISHU_SCOPES.filter(
        (scope) => scope !== "im:message.group_msg"
          && (privateMessagesReady || scope !== "im:message.p2p_msg:readonly"),
      ),
      events: REQUIRED_FEISHU_EVENTS,
      callbacks: REQUIRED_FEISHU_CALLBACKS,
    }));
    const sleep = vi.fn(async () => {
      privateMessagesReady = true;
    });
    const challenges: FeishuConfigurationChallenge[] = [];

    const result = await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      manualPermissionSkipSignal: manualPermissionSkip.signal,
      pollIntervalMs: 1,
      sleep,
      onVerification: (challenge) => {
        challenges.push(challenge);
        if (challenge.kind === "manual_scope") manualPermissionSkip.abort();
      },
    });

    expect(challenges.map((challenge) => challenge.kind)).toEqual(["launcher", "manual_scope"]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(result.status).toBe("partial");
    expect(result.added.scopes).toEqual(["im:message.p2p_msg:readonly"]);
    expect(result.remaining).toEqual({
      scopes: ["im:message.group_msg"],
      events: [],
      callbacks: [],
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
    const challenges: FeishuConfigurationChallenge[] = [];

    await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep: async () => {
        configured = true;
      },
      onVerification: (value) => {
        challenges.push(value);
      },
    });

    expect(challenges).toHaveLength(2);
    expect(challenges[0]).toMatchObject({
      kind: "launcher",
      blocking: true,
      missing: launcherCoreMissingConfiguration(),
    });
    expect(challenges[1]).toMatchObject({
      kind: "manual_scope",
      blocking: true,
      missing: manualCoreMissingConfiguration(),
    });
  });

  test("requests the core manifest when application metadata lacks inspection permission", async () => {
    let configured = false;
    const fetchMock = configurationFetch(
      () => completeConfiguration(),
      () => (configured ? undefined : jsonResponse({ code: 99991672, msg: "Access denied: scope missing" }, 400)),
    );
    const challenges: FeishuConfigurationChallenge[] = [];

    await ensureFeishuAppConfiguration(credentials, {
      fetch: fetchMock,
      pollIntervalMs: 1,
      sleep: async () => {
        configured = true;
      },
      onVerification: (value) => {
        challenges.push(value);
      },
    });

    expect(challenges).toHaveLength(2);
    expect(challenges[0]).toMatchObject({
      kind: "launcher",
      blocking: true,
      missing: launcherCoreMissingConfiguration(),
    });
    expect(challenges[1]).toMatchObject({
      kind: "manual_scope",
      blocking: true,
      missing: manualCoreMissingConfiguration(),
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
          "im:message.group_msg",
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

  test("does not treat group @ message access as access to ordinary group messages", () => {
    const scopes = REQUIRED_FEISHU_SCOPES
      .filter((scope) => scope !== "im:message.group_msg")
      .concat("im:message.group_at_msg:readonly");

    expect(
      missingFeishuAppConfiguration({
        scopes,
        events: [...REQUIRED_FEISHU_EVENTS],
        callbacks: [...REQUIRED_FEISHU_CALLBACKS],
      }),
    ).toEqual({
      scopes: ["im:message.group_msg"],
      events: [],
      callbacks: [],
    });
  });

  test("accepts the readonly group-message alias from existing app versions", () => {
    const scopes = REQUIRED_FEISHU_SCOPES
      .filter((scope) => scope !== "im:message.group_msg")
      .concat("im:message.group_msg:readonly");

    expect(
      missingFeishuAppConfiguration({
        scopes,
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

function configurationWithoutOptionalCapabilities(): ConfigurationFixture {
  return {
    scopes: REQUIRED_FEISHU_SCOPES.filter((scope) => scope !== "im:chat:create"),
    events: ["im.message.receive_v1"],
    callbacks: [],
  };
}

function coreMissingConfiguration(): FeishuConfigurationChallenge["missing"] {
  return {
    scopes: [
      "application:application:self_manage",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
    ],
    events: ["im.message.receive_v1"],
    callbacks: [],
  };
}

function launcherCoreMissingConfiguration(): FeishuConfigurationChallenge["missing"] {
  const missing = coreMissingConfiguration();
  return {
    ...missing,
    scopes: missing.scopes.filter((scope) => scope !== "im:message.group_msg"),
  };
}

function manualCoreMissingConfiguration(): FeishuConfigurationChallenge["missing"] {
  return {
    scopes: ["im:message.group_msg"],
    events: [],
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
