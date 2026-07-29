import { describe, expect, test } from "vitest";
import { startFeishu } from "../../src/startup/startFeishu.js";

describe("startFeishu", () => {
  test("claims the local control endpoint before connecting and sending the startup notification", async () => {
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
      async () => { order.push("control"); },
      () => { order.push("ready"); },
    );

    expect(order).toEqual(["control", "connector", "ready", "notification"]);
  });
});
