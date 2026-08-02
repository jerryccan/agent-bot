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
});

describe("CodexProcessManager", () => {
  test("declares experimental API support during initialization", async () => {
    const process = fakeChildProcess();
    mocks.spawnStdioCommand.mockReturnValue(process.child);
    const manager = new CodexProcessManager("codex", ["app-server"], {}, logger());

    const client = manager.getClient();
    await vi.waitFor(() => expect(process.writtenJson()).toHaveLength(1));

    expect(process.writtenJson()[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent-bot", title: "Agent Bot", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });

    process.pushStdout({ id: 1, result: { userAgent: "codex" } });
    await expect(client).resolves.toBeDefined();
    expect(process.writtenJson()[1]).toEqual({ method: "initialized", params: {} });

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
