import { describe, expect, test } from "vitest";
import { taskChatRoute } from "../../src/cli/taskChatRoute.js";
import type { SessionRecord } from "../../src/state/StateStore.js";

describe("taskChatRoute", () => {
  test("returns the Feishu chat id for a group-bound Codex task", () => {
    expect(taskChatRoute(session("chat_id:oc_group"))).toEqual({
      taskId: "019f-task",
      chatId: "oc_group",
      contextKey: "chat_id:oc_group",
    });
  });

  test("returns the base chat id and thread id for a topic-bound task", () => {
    expect(taskChatRoute(session("chat_id:oc_group:thread_id:omt_topic"))).toEqual({
      taskId: "019f-task",
      chatId: "oc_group",
      contextKey: "chat_id:oc_group:thread_id:omt_topic",
      threadId: "omt_topic",
    });
  });

  test("rejects a task without a Feishu chat route", () => {
    expect(() => taskChatRoute(session("console:default"))).toThrow("任务没有绑定飞书会话");
  });
});

function session(contextKey: string): SessionRecord {
  return {
    localSessionId: "sess_1",
    remoteSessionId: "019f-task",
    runtimeKind: "codex",
    contextKey,
    agentName: "codex",
    cwd: "D:\\work",
    status: "ready",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}
