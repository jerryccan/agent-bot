import { describe, expect, test } from "vitest";
import { startFeishu } from "../../src/startup/startFeishu.js";

describe("startFeishu", () => {
  test("waits for the connector before sending the startup notification", async () => {
    const order: string[] = [];
    const startedAt = new Date("2026-07-15T05:45:00.000Z");

    await startFeishu(
      { start: async () => { order.push("connector"); } },
      {
        notify: async (received, reason) => {
          expect(received).toBe(startedAt);
          expect(reason).toBe("test restart");
          order.push("notification");
        },
      },
      startedAt,
      "test restart",
    );

    expect(order).toEqual(["connector", "notification"]);
  });
});
