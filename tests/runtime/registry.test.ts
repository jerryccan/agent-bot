import { describe, expect, test, vi } from "vitest";
import { AgentRuntimeRegistry } from "../../src/runtime/AgentRuntimeRegistry.js";
import type { AgentRuntime } from "../../src/runtime/types.js";

describe("AgentRuntimeRegistry", () => {
  test("selects isolated runtimes by Agent standard name", () => {
    const codex = { kind: "codex", close: vi.fn() } as unknown as AgentRuntime;
    const traex = { kind: "codex", close: vi.fn() } as unknown as AgentRuntime;
    const coco = { kind: "acp", close: vi.fn() } as unknown as AgentRuntime;
    const registry = new AgentRuntimeRegistry({ codex, traex, coco });

    expect(registry.forAgent("codex")).toBe(codex);
    expect(registry.forAgent("traex")).toBe(traex);
    expect(registry.forAgent("coco")).toBe(coco);
    expect(registry.entries("codex")).toEqual([["codex", codex], ["traex", traex]]);
    expect(() => registry.forAgent("missing")).toThrow("Unknown agent runtime: missing");

    registry.close();
    expect(codex.close).toHaveBeenCalledOnce();
    expect(traex.close).toHaveBeenCalledOnce();
    expect(coco.close).toHaveBeenCalledOnce();
  });
});
