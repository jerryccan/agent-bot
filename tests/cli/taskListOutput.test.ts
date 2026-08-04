import { describe, expect, test } from "vitest";
import type { SessionRecord } from "../../src/state/StateStore.js";
import {
  currentAppServerThreadIds,
  formatTaskList,
  resolveCurrentTask,
} from "../../src/cli/taskListOutput.js";

describe("formatTaskList", () => {
  test("adds a native App Server ID label without removing existing task details", () => {
    const output = formatTaskList([
      session({
        runtimeKind: "codex",
        remoteSessionId: "019f-native-thread",
      }),
    ], "en", ["019f-native-thread"]);

    expect(output).toContain("1. [Current] [ready/completed] Native task ID");
    expect(output).toContain("Agent: codex · AgentBot task ID: sess_local");
    expect(output).toContain("App Server thread ID: 019f-native-thread");
    expect(output).toContain("019f-native-thread · chat_id:oc_test · 2026-08-04T00:01:00.000Z");
    expect(output.split("\n")).toHaveLength(4);
  });

  test("uses localized labels and distinguishes ACP session IDs", () => {
    const output = formatTaskList([
      session({
        agentName: "coco",
        runtimeKind: "acp",
        acpSessionId: "acp-native-session",
        remoteSessionId: "acp-native-session",
      }),
    ], "zh");

    expect(output).toContain("ACP Session ID：acp-native-session");
    expect(output).toContain("Agent：coco · AgentBot 任务 ID：sess_local");
    expect(output).toContain("acp-native-session · chat_id:oc_test · 2026-08-04T00:01:00.000Z");
    expect(output).not.toContain("App Server 原生任务 ID");
  });

  test("keeps the local task ID fallback before a native task exists", () => {
    const output = formatTaskList([session({ status: "failed" })], "en");

    expect(output).toContain("Agent: codex · AgentBot task ID: sess_local");
    expect(output).toContain("chat_id:oc_test · 2026-08-04T00:01:00.000Z");
    expect(output).not.toContain("App Server thread ID:");
    expect(output).not.toContain("ACP session ID:");
  });

  test("does not mark a current task when the native ID is missing or ambiguous", () => {
    const duplicate = session({ localSessionId: "sess_other", remoteSessionId: "same-thread" });

    expect(formatTaskList([session({ remoteSessionId: "thread-1" })], "en", ["missing-thread"]))
      .not.toContain("[Current]");
    expect(formatTaskList([session({ remoteSessionId: "same-thread" }), duplicate], "en", ["same-thread"]))
      .not.toContain("[Current]");
  });

  test("reads Codex and TraeX thread IDs from the command environment", () => {
    expect(currentAppServerThreadIds({
      CODEX_THREAD_ID: " 019f-codex ",
      TRAECLI_THREAD_ID: " 019f-traex ",
    })).toEqual(["019f-codex", "019f-traex"]);
    expect(currentAppServerThreadIds({ TRAECLI_THREAD_ID: "019f-traex" })).toEqual(["019f-traex"]);
    expect(currentAppServerThreadIds({})).toEqual([]);
  });

  test("marks a TraeX task from TRAECLI_THREAD_ID", () => {
    const output = formatTaskList([
      session({
        agentName: "traex",
        remoteSessionId: "019f-traex",
      }),
    ], "en", currentAppServerThreadIds({ TRAECLI_THREAD_ID: "019f-traex" }));

    expect(output).toContain("[Current]");
    expect(output).toContain("Agent: traex");
  });

  test("prefers the only running match when another Agent Thread ID was inherited", () => {
    const inherited = session({
      localSessionId: "sess_inherited",
      remoteSessionId: "019f-codex",
      status: "ready",
      lastTurnStatus: "completed",
    });
    const current = session({
      localSessionId: "sess_current",
      remoteSessionId: "019f-traex",
      agentName: "traex",
      status: "running",
      lastTurnStatus: "running",
    });

    expect(resolveCurrentTask([inherited, current], ["019f-codex", "019f-traex"]))
      .toEqual({ status: "found", session: current });
    expect(formatTaskList([inherited, current], "en", ["019f-codex", "019f-traex"]))
      .toContain("2. [Current] [running/running]");
  });

  test("reports missing, unmatched, and ambiguous current task identities", () => {
    expect(resolveCurrentTask([], [])).toEqual({ status: "missing-thread-id" });
    expect(resolveCurrentTask([], ["missing"])).toEqual({
      status: "not-found",
      threadIds: ["missing"],
    });

    const first = session({ localSessionId: "sess_first", remoteSessionId: "thread-first", status: "running" });
    const second = session({ localSessionId: "sess_second", remoteSessionId: "thread-second", status: "running" });
    expect(resolveCurrentTask([first, second], ["thread-first", "thread-second"])).toEqual({
      status: "ambiguous",
      sessions: [first, second],
      threadIds: ["thread-first", "thread-second"],
    });
  });
});

function session(patch: Partial<SessionRecord>): SessionRecord {
  return {
    localSessionId: "sess_local",
    contextKey: "chat_id:oc_test",
    agentName: "codex",
    cwd: "D:\\work",
    title: "Native task ID",
    status: "ready",
    lastTurnStatus: "completed",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:01:00.000Z",
    ...patch,
  };
}
