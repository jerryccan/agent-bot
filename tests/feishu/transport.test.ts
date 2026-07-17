import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { appConfigSchema } from "../../src/config/schema.js";
import { FeishuConnector } from "../../src/feishu/FeishuConnector.js";
import { resolveFeishuTransport } from "../../src/feishu/transport.js";

const larkSdkMock = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => Promise<unknown>>,
  register: vi.fn((handlers: Record<string, (data: unknown) => Promise<unknown>>) => {
    larkSdkMock.handlers = handlers;
    return { kind: "eventDispatcher" };
  }),
  start: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  WSClient: vi.fn(function () {
    return { start: larkSdkMock.start };
  }),
  EventDispatcher: vi.fn(function () {
    return { register: larkSdkMock.register };
  }),
}));

const options = {
  transport: "auto" as const,
  appId: undefined,
  appSecret: undefined,
  useConsoleWhenMissingCredentials: true,
};

describe("resolveFeishuTransport", () => {
  test("uses the SDK in auto mode when both credentials exist", () => {
    expect(resolveFeishuTransport({ ...options, appId: "cli_app", appSecret: "secret" })).toBe("sdk");
  });

  test("uses console in auto mode when credentials are missing and fallback is enabled", () => {
    expect(resolveFeishuTransport(options)).toBe("console");
  });

  test("rejects auto mode without credentials when fallback is disabled", () => {
    expect(() => resolveFeishuTransport({ ...options, useConsoleWhenMissingCredentials: false })).toThrow(
      "Feishu appId/appSecret are required.",
    );
  });

  test("rejects explicit SDK mode without complete credentials", () => {
    expect(() => resolveFeishuTransport({ ...options, transport: "sdk" })).toThrow(
      "Feishu appId/appSecret are required.",
    );
  });

  test("rejects explicit SDK mode when only one credential is configured", () => {
    expect(() => resolveFeishuTransport({ ...options, transport: "sdk", appId: "cli_app" })).toThrow(
      "Feishu appId/appSecret are required.",
    );
  });

  test("honors explicit console mode even when credentials exist", () => {
    expect(
      resolveFeishuTransport({ ...options, transport: "console", appId: "cli_app", appSecret: "secret" }),
    ).toBe("console");
  });
});

test("the configuration rejects unsupported transport values", () => {
  expect(() =>
    appConfigSchema.parse({
      feishu: { transport: "unsupported" },
      agents: { example: { title: "Example", command: "node" } },
    }),
  ).toThrow();
});

test("dispatches direct Feishu SDK message events", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  const handler = { onMessage: vi.fn(), onCardAction: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger);

  await connector.start();
  await larkSdkMock.handlers["im.message.receive_v1"]({
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      message_type: "text",
      content: JSON.stringify({ text: "/help" }),
    },
    sender: {
      sender_id: {
        open_id: "ou_1",
      },
    },
  });

  expect(handler.onMessage).toHaveBeenCalledWith({
    messageId: "om_1",
    contextKey: "chat_id:oc_1",
    chatId: "oc_1",
    userId: "ou_1",
    text: "/help",
  });
});

test("dispatches direct Feishu SDK card action events", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  const handler = { onMessage: vi.fn(), onCardAction: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger);

  await connector.start();
  await larkSdkMock.handlers["card.action.trigger"]({
    header: { event_id: "evt_card_1" },
    action: {
      tag: "interactive_container",
      name: "approve",
      value: { action: "permission", permissionId: "perm_1", optionId: "allow" },
    },
    operator: {
      open_id: "ou_1",
    },
    context: {
      open_chat_id: "oc_1",
      open_message_id: "om_card_1",
    },
  });

  expect(handler.onCardAction).toHaveBeenCalledWith({
    actionId: "evt_card_1",
    contextKey: "chat_id:oc_1",
    userId: "ou_1",
    messageId: "om_card_1",
    value: { action: "permission", permissionId: "perm_1", optionId: "allow" },
  });
});

test("acknowledges card callbacks before asynchronous card updates finish", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  let finishAction!: () => void;
  const pendingAction = new Promise<void>((resolve) => {
    finishAction = resolve;
  });
  const handler = {
    onMessage: vi.fn(),
    onCardAction: vi.fn(() => pendingAction),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger);

  await connector.start();
  const response = await larkSdkMock.handlers["card.action.trigger"]({
    header: { event_id: "evt_card_async" },
    action: {
      value: { action: "session_more", visibleCount: "5" },
    },
    operator: { open_id: "ou_1" },
    context: {
      open_chat_id: "oc_1",
      open_message_id: "om_card_async",
    },
  });

  expect(response).toEqual({ toast: { type: "success", content: "已处理" } });
  expect(handler.onCardAction).toHaveBeenCalledOnce();
  finishAction();
  await pendingAction;
});
