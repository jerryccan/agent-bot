import { describe, expect, test } from "vitest";
import { startFeishu } from "../../src/startup/startFeishu.js";

describe("startFeishu", () => {
  test("waits for the connector before sending the startup notification", async () => {
    const order: string[] = [];
    const startedAt = new Date("2026-07-15T05:45:00.000Z");

    await startFeishu(
      { start: async () => { order.push("connector"); } },
      { notify: async (received) => { expect(received).toBe(startedAt); order.push("notification"); } },
      startedAt,
    );

    expect(order).toEqual(["connector", "notification"]);
  });
});
