import { describe, expect, test } from "vitest";
import { privateRestartNotificationTarget } from "../../src/supervision/restartNotificationTarget.js";

describe("privateRestartNotificationTarget", () => {
  test("routes a CLI restart to the configured user's private chat", () => {
    expect(privateRestartNotificationTarget("  ou_owner  ")).toEqual({
      contextKey: "open_id:ou_owner",
    });
  });

  test("requires an owner Open ID so the restart card cannot be silently dropped", () => {
    expect(() => privateRestartNotificationTarget("  ")).toThrow(
      "feishu.userOpenId is not configured",
    );
  });
});
