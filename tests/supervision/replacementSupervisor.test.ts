import { describe, expect, test } from "vitest";
import { replacementSupervisorEnvironment } from "../../src/supervision/replacementSupervisor.js";

describe("replacementSupervisorEnvironment", () => {
  test("passes the actual requested restart reason to the replacement supervisor", () => {
    expect(replacementSupervisorEnvironment("更新 /forkgroup Status 卡片", {
      PATH: "test-path",
      AGENT_BOT_RESTART_REASON: "旧原因",
    })).toMatchObject({
      PATH: "test-path",
      AGENT_BOT_START_DELAY_MS: "250",
      AGENT_BOT_RESTART_REASON: "更新 /forkgroup Status 卡片",
    });
  });
});
