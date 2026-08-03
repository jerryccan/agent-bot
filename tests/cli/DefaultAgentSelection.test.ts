import { describe, expect, test } from "vitest";
import {
  parseMaintenanceSelection,
  resolveDefaultAgentChoice,
  selectableDefaultAgents,
} from "../../src/cli/DefaultAgentSelection.js";

describe("selectableDefaultAgents", () => {
  test("keeps installed supported Agents and custom Agents while omitting missing supported Agents", () => {
    expect(selectableDefaultAgents([
      { name: "codex", title: "Codex" },
      { name: "traex", title: "TraeX" },
      { name: "custom", title: "Custom Agent" },
    ], [
      {
        id: "codex",
        name: "Codex",
        state: "ready",
        installedVersion: "0.146.0",
      },
      {
        id: "traex",
        name: "TraeX",
        state: "missing",
        action: { kind: "install", command: "install-traex" },
      },
    ])).toEqual([
      { name: "codex", title: "Codex", installedVersion: "0.146.0" },
      { name: "custom", title: "Custom Agent" },
    ]);
  });
});

describe("parseMaintenanceSelection", () => {
  test("accepts comma-separated choices, all, and an empty skip", () => {
    expect(parseMaintenanceSelection("2, 1,2", 2)).toEqual([0, 1]);
    expect(parseMaintenanceSelection("1，2", 2)).toEqual([0, 1]);
    expect(parseMaintenanceSelection("all", 2)).toEqual([0, 1]);
    expect(parseMaintenanceSelection("", 2)).toEqual([]);
    expect(parseMaintenanceSelection("3", 2)).toBeUndefined();
  });
});

describe("resolveDefaultAgentChoice", () => {
  const choices = [
    { name: "codex", title: "Codex", installedVersion: "0.146.0" },
    { name: "traex", title: "TraeX", installedVersion: "0.201.1-alpha.8" },
  ];

  test("accepts a number, a standard name, or an empty current selection", () => {
    expect(resolveDefaultAgentChoice("2", choices, "codex")).toBe(1);
    expect(resolveDefaultAgentChoice("TRaEx", choices, "codex")).toBe(1);
    expect(resolveDefaultAgentChoice("", choices, "codex")).toBe(0);
    expect(resolveDefaultAgentChoice("", choices, "missing")).toBeUndefined();
    expect(resolveDefaultAgentChoice("unknown", choices, "codex")).toBeUndefined();
  });
});
