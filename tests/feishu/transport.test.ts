import type { Logger } from "pino";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { appConfigSchema } from "../../src/config/schema.js";
import { FeishuConnector } from "../../src/feishu/FeishuConnector.js";
import { requireServerFeishuTransport } from "../../src/feishu/transport.js";

const larkSdkMock = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => Promise<unknown>>,
  register: vi.fn((handlers: Record<string, (data: unknown) => Promise<unknown>>) => {
    larkSdkMock.handlers = handlers;
    return { kind: "eventDispatcher" };
  }),
  constructorOptions: undefined as undefined | Record<string, unknown>,
  start: vi.fn(async () => undefined),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  WSClient: vi.fn(function (options: Record<string, unknown>) {
    larkSdkMock.constructorOptions = options;
    return { start: larkSdkMock.start };
  }),
  EventDispatcher: vi.fn(function () {
    return { register: larkSdkMock.register };
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  larkSdkMock.handlers = {};
  larkSdkMock.constructorOptions = undefined;
  larkSdkMock.start.mockResolvedValue(undefined);
});

describe("requireServerFeishuTransport", () => {
  test("uses the SDK when both credentials exist", () => {
    expect(requireServerFeishuTransport({ appId: "cli_app", appSecret: "secret" })).toBe("sdk");
  });

  test("rejects a server start without complete credentials", () => {
    expect(() => requireServerFeishuTransport({ appId: "cli_app" })).toThrow(
      "Lark bot is not configured. Run agentbot init",
    );
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

test("starts the Feishu WebSocket without inspecting SDK logs or private state", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  const handler = { onMessage: vi.fn(), onCardAction: vi.fn() };
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger);

  await connector.start();

  expect(larkSdkMock.constructorOptions).toEqual({
    appId: "cli_app",
    appSecret: "secret",
  });
  expect(larkSdkMock.start).toHaveBeenCalledWith({ eventDispatcher: { kind: "eventDispatcher" } });
  expect(logger.info).toHaveBeenCalledWith("Feishu WebSocket connector started.");
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
    chatType: "p2p",
    userId: "ou_1",
    text: "/help",
  });
});

test("dispatches Feishu chat name changes", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  const handler = { onMessage: vi.fn(), onCardAction: vi.fn(), onChatUpdated: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger);

  await connector.start();
  await larkSdkMock.handlers["im.chat.updated_v1"]({
    chat_id: "oc_group",
    before_change: { name: "[codex] old title" },
    after_change: { name: "[codex] abc" },
  });

  await vi.waitFor(() => expect(handler.onChatUpdated).toHaveBeenCalledWith({
    chatId: "oc_group",
    beforeName: "[codex] old title",
    afterName: "[codex] abc",
  }));
});

test("ignores chat update events that do not change the group name", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  const handler = { onMessage: vi.fn(), onCardAction: vi.fn(), onChatUpdated: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger);

  await connector.start();
  await larkSdkMock.handlers["im.chat.updated_v1"]({
    chat_id: "oc_group",
    before_change: { name: "[codex] same" },
    after_change: { name: "[codex] same", description: "updated" },
  });
  await larkSdkMock.handlers["im.chat.updated_v1"]({
    chat_id: "oc_group",
    before_change: { description: "before" },
    after_change: { description: "after" },
  });

  expect(handler.onChatUpdated).not.toHaveBeenCalled();
});

test("dispatches an image message with its Feishu image key", async () => {
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
      message_id: "om_image",
      chat_id: "oc_image",
      chat_type: "group",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_v2_input" }),
    },
    sender: { sender_id: { open_id: "ou_member" } },
  });

  await vi.waitFor(() => expect(handler.onMessage).toHaveBeenCalledWith({
    messageId: "om_image",
    contextKey: "chat_id:oc_image",
    chatId: "oc_image",
    chatType: "group",
    userId: "ou_member",
    text: "",
    images: [{ imageKey: "img_v2_input" }],
  }));
});

test("extracts text and de-duplicated images from a rich-text message", async () => {
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
      message_id: "om_post",
      chat_id: "oc_post",
      message_type: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "截图问题",
          content: [
            [{ tag: "at", user_id: "ou_bot" }, { tag: "text", text: "请检查 " }, { tag: "a", text: "这个页面" }],
            [{ tag: "img", image_key: "img_first" }, { tag: "img", image_key: "img_first" }],
            [{ tag: "text", text: "以及第二张" }, { tag: "img", image_key: "img_second" }],
          ],
        },
      }),
    },
    sender: { sender_id: { open_id: "ou_post" } },
  });

  await vi.waitFor(() => expect(handler.onMessage).toHaveBeenCalledWith({
    messageId: "om_post",
    contextKey: "chat_id:oc_post",
    chatId: "oc_post",
    chatType: "p2p",
    userId: "ou_post",
    text: "截图问题\n请检查 这个页面\n以及第二张",
    images: [{ imageKey: "img_first" }, { imageKey: "img_second" }],
  }));
});

test("extracts images from the top-level rich-text shape used by received Feishu events", async () => {
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
      message_id: "om_real_post",
      chat_id: "oc_real_post",
      message_type: "post",
      content: JSON.stringify({
        title: "",
        content: [
          [{ tag: "img", image_key: "img_v3_real" }],
          [{ tag: "text", text: "右侧的方块的左上角是否有圆角" }],
        ],
      }),
    },
    sender: { sender_id: { open_id: "ou_real_post" } },
  });

  await vi.waitFor(() => expect(handler.onMessage).toHaveBeenCalledWith({
    messageId: "om_real_post",
    contextKey: "chat_id:oc_real_post",
    chatId: "oc_real_post",
    chatType: "p2p",
    userId: "ou_real_post",
    text: "右侧的方块的左上角是否有圆角",
    images: [{ imageKey: "img_v3_real" }],
  }));
});

test("acknowledges message events before asynchronous message handling finishes", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  let finishMessage!: () => void;
  const pendingMessage = new Promise<void>((resolve) => {
    finishMessage = resolve;
  });
  const handler = {
    onMessage: vi.fn(() => pendingMessage),
    onCardAction: vi.fn(),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger);

  await connector.start();
  let acknowledged = false;
  const dispatch = larkSdkMock.handlers["im.message.receive_v1"]({
    message: {
      message_id: "om_async",
      chat_id: "oc_async",
      message_type: "text",
      content: JSON.stringify({ text: "run a long task" }),
    },
    sender: { sender_id: { open_id: "ou_async" } },
  }).then(() => {
    acknowledged = true;
  });

  await vi.waitFor(() => expect(handler.onMessage).toHaveBeenCalledOnce());
  await Promise.resolve();
  const acknowledgedBeforeHandlingFinished = acknowledged;
  finishMessage();
  await Promise.all([dispatch, pendingMessage]);

  expect(acknowledgedBeforeHandlingFinished).toBe(true);
});

test("dispatches group-thread mentions with an isolated task context and thread reply target", async () => {
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
      message_id: "om_topic_1",
      chat_id: "oc_topic_1",
      chat_type: "group",
      message_type: "text",
      root_id: "om_topic_root",
      thread_id: "omt_topic_1",
      content: JSON.stringify({ text: "  @_user_1   /status" }),
      mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "Agent Bot" }],
    },
    sender: { sender_id: { open_id: "ou_member" } },
  });

  expect(handler.onMessage).toHaveBeenCalledWith({
    messageId: "om_topic_1",
    contextKey: "chat_id:oc_topic_1:thread_id:omt_topic_1",
    chatId: "oc_topic_1",
    chatType: "group",
    userId: "ou_member",
    replyInThread: true,
    threadContext: true,
    threadId: "omt_topic_1",
    rootMessageId: "om_topic_root",
    text: "/status",
  });
});

test("dispatches group-main mentions without creating a thread reply", async () => {
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
      message_id: "om_group_main",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 hello group" }),
      mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "Agent Bot" }],
    },
    sender: { sender_id: { open_id: "ou_member" } },
  });

  expect(handler.onMessage).toHaveBeenCalledWith({
    messageId: "om_group_main",
    contextKey: "chat_id:oc_group",
    chatId: "oc_group",
    chatType: "group",
    userId: "ou_member",
    text: "hello group",
  });
});

test("requires a mention of the current bot when all group messages are disabled", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      respondToAllGroupMessages: false,
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  const handler = { onMessage: vi.fn(), onCardAction: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const resolveBotOpenId = vi.fn(async () => "ou_current_bot");
  const connector = new FeishuConnector(config, handler, logger, resolveBotOpenId);

  await connector.start();
  await larkSdkMock.handlers["im.message.receive_v1"]({
    message: {
      message_id: "om_without_mention",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "ordinary message" }),
    },
    sender: { sender_id: { open_id: "ou_member" } },
  });
  await larkSdkMock.handlers["im.message.receive_v1"]({
    message: {
      message_id: "om_other_mention",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 hello" }),
      mentions: [{ key: "@_user_1", id: "ou_other_user", id_type: "open_id" }],
    },
    sender: { sender_id: { open_id: "ou_member" } },
  });
  await larkSdkMock.handlers["im.message.receive_v1"]({
    message: {
      message_id: "om_bot_mention",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_2 run this" }),
      mentions: [{ key: "@_user_2", id: "ou_current_bot", id_type: "open_id" }],
    },
    sender: { sender_id: { open_id: "ou_member" } },
  });

  await vi.waitFor(() => expect(handler.onMessage).toHaveBeenCalledOnce());
  expect(resolveBotOpenId).toHaveBeenCalledWith("cli_app", "secret");
  expect(handler.onMessage).toHaveBeenCalledWith(expect.objectContaining({
    messageId: "om_bot_mention",
    text: "run this",
  }));
});

test("keeps private messages enabled when group messages require a mention", async () => {
  const config = {
    feishu: {
      transport: "sdk",
      appId: "cli_app",
      appSecret: "secret",
      respondToAllGroupMessages: false,
      useConsoleWhenMissingCredentials: true,
    },
  } as AppConfig;
  const handler = { onMessage: vi.fn(), onCardAction: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const connector = new FeishuConnector(config, handler, logger, async () => "ou_current_bot");

  await connector.start();
  await larkSdkMock.handlers["im.message.receive_v1"]({
    message: {
      message_id: "om_private",
      chat_id: "oc_private",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello privately" }),
    },
    sender: { sender_id: { open_id: "ou_member" } },
  });

  await vi.waitFor(() => expect(handler.onMessage).toHaveBeenCalledOnce());
});

test("dispatches private-chat thread messages with an isolated task context", async () => {
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
      message_id: "om_private_reply",
      chat_id: "oc_private",
      chat_type: "p2p",
      message_type: "text",
      root_id: "om_source_turn",
      parent_id: "om_source_turn",
      thread_id: "omt_private_topic",
      content: JSON.stringify({ text: "continue from here" }),
    },
    sender: { sender_id: { open_id: "ou_private" } },
  });

  expect(handler.onMessage).toHaveBeenCalledWith({
    messageId: "om_private_reply",
    contextKey: "chat_id:oc_private:thread_id:omt_private_topic",
    chatId: "oc_private",
    chatType: "p2p",
    userId: "ou_private",
    replyInThread: true,
    threadContext: true,
    threadId: "omt_private_topic",
    rootMessageId: "om_source_turn",
    parentMessageId: "om_source_turn",
    text: "continue from here",
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
      value: { action: "session_page", page: "1" },
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
