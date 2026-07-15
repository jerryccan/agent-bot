import { describe, expect, test, vi } from "vitest";
import type { AgentConfig } from "../../src/config/schema.js";
import { AgentRuntimeRegistry } from "../../src/runtime/AgentRuntimeRegistry.js";
import type { AgentRuntime } from "../../src/runtime/types.js";

describe("AgentRuntimeRegistry", () => {
  test("selects the runtime matching the agent kind", () => {
    const acp = { kind: "acp", createSession: vi.fn() } as unknown as AgentRuntime;
    const codex = { kind: "codex", createSession: vi.fn() } as unknown as AgentRuntime;
    const registry = new AgentRuntimeRegistry({ acp, codex });

    expect(registry.forAgent({ kind: "codex" } as AgentConfig)).toBe(codex);
    expect(registry.forAgent({ kind: "acp" } as AgentConfig)).toBe(acp);
  });
});
