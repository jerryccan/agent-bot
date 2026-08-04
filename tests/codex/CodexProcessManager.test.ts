import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnStdioCommand: vi.fn(),
}));

vi.mock("../../src/utils/spawnCommand.js", () => ({
  spawnStdioCommand: mocks.spawnStdioCommand,
}));

import { CodexProcessManager } from "../../src/codex/CodexProcessManager.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("CodexProcessManager", () => {
  test("declares experimental API support during initialization", async () => {
    const process = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(process.child);
    const manager = new CodexProcessManager("codex", ["app-server"], {}, logger());
    expect(manager.getProcessInfo()).toEqual({});

    const client = manager.getClient();
    await vi.waitFor(() => expect(process.writtenJson()).toHaveLength(1));
    expect(manager.getProcessInfo()).toEqual({ pid: 4321 });

    expect(process.writtenJson()[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent-bot", title: "Agent Bot", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });

    process.pushStdout({ id: 1, result: { userAgent: "codex-cli/0.146.0" } });
    await expect(client).resolves.toBeDefined();
    expect(process.writtenJson()[1]).toEqual({ method: "initialized", params: {} });
    expect(manager.getProcessInfo()).toEqual({ pid: 4321, version: "0.146.0" });

    manager.close();
  });

  test("resolves safe Agent Bot context lazily without exposing the Feishu App Secret", async () => {
    vi.stubEnv("FEISHU_APP_SECRET", "worker-secret");
    vi.stubEnv("PARENT_VALUE", "preserved");
    const process = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(process.child);
    const context = { larkBotOpenId: undefined as string | undefined };
    const manager = new CodexProcessManager(
      "codex",
      ["app-server"],
      {},
      logger(),
      () => ({
        profilePath: "C:\\Users\\tester\\.agent-bot",
        larkAppId: "cli_app",
        larkBotOpenId: context.larkBotOpenId,
      }),
    );
    context.larkBotOpenId = "ou_bot";

    const client = manager.getClient();
    await vi.waitFor(() => expect(mocks.spawnStdioCommand).toHaveBeenCalledOnce());
    const environment = mocks.spawnStdioCommand.mock.calls[0]?.[2] as NodeJS.ProcessEnv;
    expect(environment).toMatchObject({
      PARENT_VALUE: "preserved",
      AGENT_BOT: "1",
      AGENT_BOT_HOME: "C:\\Users\\tester\\.agent-bot",
      AGENT_BOT_LARK_APP_ID: "cli_app",
      AGENT_BOT_LARK_BOT_OPEN_ID: "ou_bot",
    });
    expect(environment.FEISHU_APP_SECRET).toBeUndefined();

    process.pushStdout({ id: 1, result: { userAgent: "codex" } });
    await client;
    manager.close();
  });
});

function fakeChildProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    pid: 4321,
    kill: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const writes: string[] = [];
  stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  return {
    child,
    pushStdout(value: unknown) {
      stdout.write(`${JSON.stringify(value)}\n`);
    },
    writtenJson() {
      return writes
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
    },
  };
}

function logger(): Logger {
  const childLogger = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => childLogger),
  } as unknown as Logger;
}
