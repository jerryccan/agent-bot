import { describe, expect, test } from "vitest";
import {
  RESTART_GROUP_CONTEXTS_ENV,
  RESTART_NOTIFICATION_TARGETS_ENV,
  replacementSupervisorEnvironment,
  restartGroupContextKeysFromEnvironment,
  restartNotificationTargetsFromEnvironment,
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

  test("passes each exact safe-restart notification target to the replacement worker once", () => {
    const environment = replacementSupervisorEnvironment(
      "group restart",
      {},
      [
        { contextKey: "chat_id:first" },
        { contextKey: " chat_id:first ", replyMessageId: " om_topic " },
        { contextKey: "" },
        { contextKey: "chat_id:second" },
      ],
    );

    expect(restartNotificationTargetsFromEnvironment(
      environment[RESTART_NOTIFICATION_TARGETS_ENV],
    )).toEqual([
      { contextKey: "chat_id:first", replyMessageId: "om_topic" },
      { contextKey: "chat_id:second" },
    ]);
    expect(environment[RESTART_GROUP_CONTEXTS_ENV]).toBeUndefined();
    expect(restartNotificationTargetsFromEnvironment("invalid-json")).toEqual([]);
  });

  test("still reads legacy restart group context lists", () => {
    expect(restartGroupContextKeysFromEnvironment(
      '["chat_id:first", " chat_id:first ", "", "chat_id:second"]',
    )).toEqual(["chat_id:first", "chat_id:second"]);
    expect(restartGroupContextKeysFromEnvironment("invalid-json")).toEqual([]);
  });
});
