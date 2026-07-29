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
  test("creates a private Feishu group and invites the current user", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { chat_id: "oc_new_group" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.createGroup({
      name: "[codex] 广州天气",
      userOpenId: "ou_current_user",
    })).resolves.toEqual({
      chatId: "oc_new_group",
      name: "[codex] 广州天气",
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      chat_mode: "group",
      chat_type: "private",
      name: "[codex] 广州天气",
      user_id_list: ["ou_current_user"],
    });
  });

  test("uploads and assigns an avatar while creating a Feishu group", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_avatar" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { chat_id: "oc_avatar_group" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.createGroup({
      name: "Avatar group",
      userOpenId: "ou_current_user",
      avatarPng: new Uint8Array([137, 80, 78, 71]),
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://open.feishu.cn/open-apis/im/v1/images");
    const form = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get("image_type")).toBe("avatar");
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      chat_mode: "group",
      chat_type: "private",
      name: "Avatar group",
      user_id_list: ["ou_current_user"],
      avatar: "img_avatar",
    });
  });

  test("downloads a Feishu message image into the bot data directory and caches it", async () => {
    const clientConfig = config();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(clientConfig, logger());

    const first = await client.downloadImage("om_input", "img_input");
    const second = await client.downloadImage("om_input", "img_input");

    expect(first).toBe(second);
    expect(path.dirname(first)).toBe(path.join(path.dirname(clientConfig.storage.sqlitePath), "inbound-images"));
    expect(path.extname(first)).toBe(".png");
    expect([...fs.readFileSync(first)]).toEqual([1, 2, 3, 4]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_input/resources/img_input?type=image",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("adds an OnIt reaction to acknowledge an incoming message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { reaction_id: "reaction_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.addReaction("om_received", "OnIt")).resolves.toBe("reaction_1");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_received/reactions",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      reaction_type: { emoji_type: "OnIt" },
    });
  });

  test("deletes the previous reaction when replacing a message status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.deleteReaction("om_received", "reaction_1");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_received/reactions/reaction_1",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    });
  });

  test("passes a stable UUID with an idempotent final message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    await client.sendMarkdown("chat_id:c1", "answer", "stable-uuid");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.uuid).toBe("stable-uuid");
    expect(JSON.parse(String(body.content))).toMatchObject({
      schema: "2.0",
      body: {
        elements: [{ tag: "markdown", content: "answer" }],
      },
    });
  });

  test("uses the base chat id when sending for a thread-scoped task context", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendText("chat_id:oc_private:thread_id:omt_topic", "fallback");

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.receive_id).toBe("oc_private");
  });

  test("replies with an interactive card inside the source message thread", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_progress" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.replyInteractiveCard(
      "chat_id:oc_group",
      { messageId: "om_question", replyInThread: true },
      { schema: "2.0", body: { elements: [] } },
      "stable-progress-uuid",
    )).resolves.toBe("om_progress");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_question/reply",
    );
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      msg_type: "interactive",
      reply_in_thread: true,
      uuid: "stable-progress-uuid",
    });
    expect(JSON.parse(String(body.content))).toEqual({ schema: "2.0", body: { elements: [] } });
  });

  test("uses a Card 2.0 markdown component for final answers in message threads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_final" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const markdown = "调用 `/fork <任务 ID>`，并检查 `aria_role`。";

    await client.replyMarkdown(
      "chat_id:oc_group",
      { messageId: "om_question", replyInThread: true },
      markdown,
      "stable-final-uuid",
    );

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(body.content)) as {
      schema: string;
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card).toEqual({
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      body: { elements: [{ tag: "markdown", content: markdown }] },
    });
  });

  test("makes fenced code blocks nested under list items visible in Feishu cards", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_final" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const markdown = [
      "1. Actor 错误全部转为：",
      "",
      "   ```cpp",
      "   BuaRendererActionError::kActionFailed",
      "   ```",
    ].join("\n");

    await client.sendMarkdown("chat_id:c1", markdown);

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(body.content)) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.body.elements).toEqual([{
      tag: "markdown",
      content: [
        "1. Actor 错误全部转为：",
        "",
        "```cpp",
        "BuaRendererActionError::kActionFailed",
        "```",
      ].join("\n"),
    }]);
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
    const card = JSON.parse(String(messageBody.content)) as { body: { elements: Array<Record<string, unknown>> } };
    expect(messageBody.uuid).toBe("image-uuid");
    expect(card.body.elements.map((element) => element.tag)).toEqual(["markdown", "img", "markdown"]);
    expect(card.body.elements[1]).toEqual(expect.objectContaining({ img_key: "img_screen", preview: true }));
  });

  test("uploads angle-wrapped slash-prefixed Windows screenshot paths from restored Codex answers", async () => {
    const imagePath = createImage("restored.png");
    const slashPrefixedPath = `/${markdownPath(imagePath)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_restored" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_restored" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendMarkdown(
      "chat_id:c1",
      `截图：\n\n![恢复截图](<${slashPrefixedPath}>)`,
      "restored-image-uuid",
    );

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/open-apis/im/v1/images");
    const messageBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(messageBody.content)) as { body: { elements: Array<Record<string, unknown>> } };
    expect(card.body.elements.at(-1)).toEqual(expect.objectContaining({ tag: "img", img_key: "img_restored" }));
    expect(messageBody.uuid).toBe("restored-image-uuid");
  });

  test("removes unsupported image syntax before sending a Feishu card", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_fallback" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendMarkdown(
      "chat_id:c1",
      "截图：![已删除](</D:/missing/screenshot.png>)，远程图：![查看](https://example.com/image.png)",
    );

    const messageBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const content = String(messageBody.content);
    expect(content).toContain("图片不可用：已删除");
    expect(content).toContain("[查看](https://example.com/image.png)");
    expect(content).not.toContain("![");
    expect(content).not.toContain('"tag":"img"');
  });

  test("uploads view_image previews in cards once and reuses the image key on updates", async () => {
    const imagePath = createImage("view.png");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_view" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_view" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const card = {
      schema: "2.0",
      body: {
        elements: [{
          tag: "collapsible_panel",
          expanded: false,
          elements: [{
            tag: "img",
            img_key: "",
            __acp_local_image_path: imagePath,
            alt: { tag: "plain_text", content: "view_image 图片" },
            preview: true,
          }],
        }],
      },
    };

    await client.sendInteractiveCard("chat_id:c1", card);
    await client.updateInteractiveCard("om_view", card);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/im/v1/images"))).toHaveLength(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string };
    const updated = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as { content: string };
    for (const content of [sent.content, updated.content]) {
      expect(content).toContain('"img_key":"img_view"');
      expect(content).not.toContain("__acp_local_image_path");
    }
  });

  test("uploads a replacement image when the same file path has a newer modification time", async () => {
    const imagePath = createImage("replaced-view.png");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_old" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_replaced_view" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_new" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const card = {
      schema: "2.0",
      body: {
        elements: [{
          tag: "img",
          img_key: "",
          __acp_local_image_path: imagePath,
          alt: { tag: "plain_text", content: "view_image 图片" },
          preview: true,
        }],
      },
    };

    await client.sendInteractiveCard("chat_id:c1", card);
    fs.writeFileSync(imagePath, "replacement image");
    const newer = new Date(Date.now() + 2_000);
    fs.utimesSync(imagePath, newer, newer);
    await client.updateInteractiveCard("om_replaced_view", card);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/im/v1/images"))).toHaveLength(2);
    const sent = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string };
    const updated = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as { content: string };
    expect(sent.content).toContain('"img_key":"img_old"');
    expect(updated.content).toContain('"img_key":"img_new"');
  });

  test("keeps the tool card usable when a view_image preview cannot be uploaded", async () => {
    const imagePath = createImage("unavailable.png");
    const testLogger = logger();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 234001, msg: "bad image" }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_fallback" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), testLogger);

    await client.sendInteractiveCard("chat_id:c1", {
      schema: "2.0",
      body: {
        elements: [{
          tag: "collapsible_panel",
          elements: [{
            tag: "img",
            img_key: "",
            __acp_local_image_path: imagePath,
            alt: { tag: "plain_text", content: "view_image 图片" },
          }],
        }],
      },
    });

    const sent = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string };
    expect(sent.content).toContain("图片加载失败：view_image 图片");
    expect(sent.content).not.toContain("__acp_local_image_path");
    expect(testLogger.warn).toHaveBeenCalled();
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-client-data-"));
  temporaryDirectories.push(directory);
  return {
    feishu: { appId: "cli_app", appSecret: "secret" },
    storage: { sqlitePath: path.join(directory, "state.sqlite") },
  } as unknown as AppConfig;
}

function logger(): Logger {
  return { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

function createImage(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-client-image-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, "fake image");
  return filePath;
}

function markdownPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
