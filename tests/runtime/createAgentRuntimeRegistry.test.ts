import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { createAgentRuntimeRegistry } from "../../src/runtime/createAgentRuntimeRegistry.js";

describe("createAgentRuntimeRegistry", () => {
  test("creates a distinct runtime for every configured Agent regardless of kind", () => {
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    Object.assign(logger, { child: vi.fn(() => logger) });
    const config = {
      agents: {
        codex: { kind: "codex", title: "Codex", command: "codex", args: [], env: {} },
        traex: { kind: "codex", title: "TraeX", command: "traex", args: ["app-server"], env: {} },
        coco: { kind: "acp", title: "Coco", command: "coco", args: [], env: {} },
      },
    } as unknown as AppConfig;

    const registry = createAgentRuntimeRegistry(config, logger);

    expect(registry.forAgent("codex")).not.toBe(registry.forAgent("traex"));
    expect(registry.forAgent("codex").kind).toBe("codex");
    expect(registry.forAgent("traex").kind).toBe("codex");
    expect(registry.forAgent("coco").kind).toBe("acp");
    registry.close();
  });
});
