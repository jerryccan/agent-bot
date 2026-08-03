import { describe, expect, test } from "vitest";
import {
  RESTART_GROUP_CONTEXTS_ENV,
  replacementSupervisorEnvironment,
  restartGroupContextKeysFromEnvironment,
} from "../../src/supervision/replacementSupervisor.js";

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

  test("passes each safe-restart group to the replacement worker once", () => {
    const environment = replacementSupervisorEnvironment(
      "group restart",
      {},
      ["chat_id:first", " chat_id:first ", "", "chat_id:second"],
    );

    expect(restartGroupContextKeysFromEnvironment(
      environment[RESTART_GROUP_CONTEXTS_ENV],
    )).toEqual(["chat_id:first", "chat_id:second"]);
    expect(restartGroupContextKeysFromEnvironment("invalid-json")).toEqual([]);
  });
});
