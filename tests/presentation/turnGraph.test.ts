import { describe, expect, test } from "vitest";
import { buildTurnGraphRows } from "../../src/presentation/turnGraph.js";

describe("buildTurnGraphRows", () => {
  test("keeps a reset branch open until it merges into the selected parent", () => {
    const rows = buildTurnGraphRows([
      { turnId: "turn_1", parentTurnId: "turn_2" },
      { turnId: "turn_2", parentTurnId: "turn_3" },
      { turnId: "turn_3", parentTurnId: "turn_4" },
      { turnId: "turn_4", parentTurnId: "turn_5" },
      { turnId: "turn_5", parentTurnId: "turn_8" },
      { turnId: "turn_6", parentTurnId: "turn_7" },
      { turnId: "turn_7", parentTurnId: "turn_8" },
      { turnId: "turn_8" },
    ]);

    expect(rows.map(({ nodeLine, connectorLine }) => ({ nodeLine, connectorLine }))).toEqual([
      { nodeLine: "● 1", connectorLine: "│" },
      { nodeLine: "● 2", connectorLine: "│" },
      { nodeLine: "● 3", connectorLine: "│" },
      { nodeLine: "● 4", connectorLine: "│" },
      { nodeLine: "● 5", connectorLine: "│" },
      { nodeLine: "│ ● 6", connectorLine: "│ │" },
      { nodeLine: "│ ● 7", connectorLine: "│ ╱" },
      { nodeLine: "● 8", connectorLine: undefined },
    ]);
  });
});
