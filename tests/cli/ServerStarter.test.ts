import { describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import {
  startInitializedServer,
  startServer,
  type ServerStarterDependencies,
} from "../../src/cli/ServerStarter.js";

const config = {
  feishu: {
    appId: "cli_app",
    appSecret: "secret",
  },
  storage: {
    sqlitePath: "D:/tmp/agent-bot-test.sqlite",
  },
} as AppConfig;

describe("startServer", () => {
  test("returns without spawning when the server is already ready", async () => {
    const dependencies = createDependencies({ running: true });

    await expect(startServer(config, dependencies)).resolves.toEqual({
      status: "already-running",
    });
    expect(dependencies.isReachable).not.toHaveBeenCalled();
    expect(dependencies.spawnSupervisor).not.toHaveBeenCalled();
  });

  test("spawns the supervisor and waits for readiness", async () => {
    const dependencies = createDependencies({
      running: false,
      reachable: false,
      readyAfterWait: true,
    });

    await expect(startServer(config, dependencies)).resolves.toEqual({
      status: "started",
    });
    expect(dependencies.spawnSupervisor).toHaveBeenCalledWith(config);
    expect(dependencies.waitUntilRunning).toHaveBeenCalledWith(expect.any(String), 45_000);
  });

  test("waits for an existing startup without spawning another supervisor", async () => {
    const dependencies = createDependencies({
      running: false,
      reachable: true,
      readyAfterWait: true,
    });

    await expect(startServer(config, dependencies)).resolves.toEqual({
      status: "started",
    });
    expect(dependencies.spawnSupervisor).not.toHaveBeenCalled();
  });

  test("reports when a spawned supervisor never becomes ready", async () => {
    const dependencies = createDependencies({
      running: false,
      reachable: false,
      readyAfterWait: false,
    });

    await expect(startServer(config, dependencies)).rejects.toThrow(
      "server did not connect to Lark within 45 seconds",
    );
  });

  test("rejects missing Feishu credentials before inspecting processes", async () => {
    const dependencies = createDependencies({});

    await expect(startServer({
      ...config,
      feishu: {
        ...config.feishu,
        appId: undefined,
        appSecret: undefined,
      },
    }, dependencies)).rejects.toThrow("Lark bot is not configured");
    expect(dependencies.isRunning).not.toHaveBeenCalled();
  });
});

describe("startInitializedServer", () => {
  test("starts the server with the initialized configuration", async () => {
    const loadInitializedConfig = vi.fn(() => config);
    const startInitializedConfig = vi.fn(async () => ({ status: "started" as const }));

    await expect(startInitializedServer(
      { skipFeishu: false, configPath: "D:/profile/config.yaml" },
      {
        loadConfig: loadInitializedConfig,
        startServer: startInitializedConfig,
      },
    )).resolves.toEqual({ status: "started" });
    expect(loadInitializedConfig).toHaveBeenCalledWith("D:/profile/config.yaml");
    expect(startInitializedConfig).toHaveBeenCalledWith(config);
  });

  test("does not load configuration or start a server for Console-only initialization", async () => {
    const loadInitializedConfig = vi.fn(() => config);
    const startInitializedConfig = vi.fn(async () => ({ status: "started" as const }));

    await expect(startInitializedServer(
      { skipFeishu: true },
      {
        loadConfig: loadInitializedConfig,
        startServer: startInitializedConfig,
      },
    )).resolves.toEqual({
      status: "skipped",
      reason: "feishu-skipped",
    });
    expect(loadInitializedConfig).not.toHaveBeenCalled();
    expect(startInitializedConfig).not.toHaveBeenCalled();
  });
});

function createDependencies(options: {
  running?: boolean;
  reachable?: boolean;
  readyAfterWait?: boolean;
}): ServerStarterDependencies {
  return {
    isRunning: vi.fn(async () => options.running ?? false),
    isReachable: vi.fn(async () => options.reachable ?? false),
    waitUntilRunning: vi.fn(async () => options.readyAfterWait ?? false),
    spawnSupervisor: vi.fn(),
  };
}
