import { describe, expect, test } from "vitest";
import type { SessionRecord } from "../../src/state/StateStore.js";
import {
  resolveCurrentTaskFromEnvironment,
  resolveTaskCommandTarget,
} from "../../src/cli/taskTarget.js";

describe("task CLI target resolution", () => {
  const first = session("sess_first", "thread-first");
  const current = session("sess_current", "thread-current");
  const sessions = [first, current];
  const hosted = { AGENT_BOT: "1", CODEX_THREAD_ID: "thread-current" };

  test("uses the current task and preserves command arguments inside Agent Bot", () => {
    expect(resolveTaskCommandTarget(sessions, ["write", "tests"], "prompt", { env: hosted })).toEqual({
      session: current,
      args: ["write", "tests"],
      source: "current",
    });
  });

  test("keeps the legacy positional task reference when it resolves", () => {
    expect(resolveTaskCommandTarget(sessions, ["sess_first", "hello"], "prompt", { env: hosted })).toEqual({
      session: first,
      args: ["hello"],
      source: "explicit",
    });
  });

  test("supports --task anywhere and removes it from command arguments", () => {
    expect(resolveTaskCommandTarget(sessions, ["hello", "--task", "2", "world"], "prompt", { env: hosted })).toEqual({
      session: current,
      args: ["hello", "world"],
      source: "explicit",
    });
  });

  test("uses the current task as the switch anchor even when a target is supplied", () => {
    expect(resolveTaskCommandTarget(sessions, ["sess_first"], "switch", {
      env: hosted,
      preferCurrent: true,
    })).toEqual({
      session: current,
      args: ["sess_first"],
      source: "current",
    });
  });

  test("requires an explicit task outside Agent Bot", () => {
    expect(() => resolveTaskCommandTarget(sessions, [], "status", { env: {} }))
      .toThrow("requires a task number or task ID outside Agent Bot");
  });

});

function session(localSessionId: string, remoteSessionId: string): SessionRecord {
  return {
    localSessionId,
    remoteSessionId,
    agentName: "codex",
    contextKey: `feishu:${localSessionId}`,
    cwd: "D:\\work",
    status: "ready",
    lastTurnStatus: "completed",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}
