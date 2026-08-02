import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppServerConnection, AppServerRequestError } from "../../src/codex/AppServerConnection.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AppServerConnection", () => {
  test("writes JSON-RPC-lite requests without a jsonrpc field", async () => {
    const process = fakeChildProcess();
    const connection = new AppServerConnection(process.child, logger());

    const pending = connection.request<{ userAgent: string }>("initialize", {
      clientInfo: { name: "agent-bot", version: "0.1.0" },
    });

    expect(process.writtenJson()).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "agent-bot", version: "0.1.0" } } },
    ]);
    process.pushStdout({ id: 1, result: { userAgent: "codex" } });
    await expect(pending).resolves.toEqual({ userAgent: "codex" });
  });

  test("preserves JSON-RPC error metadata", async () => {
    const process = fakeChildProcess();
    const connection = new AppServerConnection(process.child, logger());
    const pending = connection.request("thread/fork", { threadId: "thr_1", excludeTurns: true });

    process.pushStdout({
      id: 1,
      error: {
        code: -32602,
        message: "Invalid params",
        data: { detail: "unknown field `excludeTurns`" },
      },
    });

    const error = await pending.then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppServerRequestError);
    expect(error).toMatchObject({
      method: "thread/fork",
      code: -32602,
      serverMessage: "Invalid params",
      data: { detail: "unknown field `excludeTurns`" },
    });
  });

  test("emits notifications", async () => {
    const process = fakeChildProcess();
    const connection = new AppServerConnection(process.child, logger());
    const listener = vi.fn();
    connection.onNotification(listener);

    process.pushStdout({ method: "turn/started", params: { threadId: "thr_1" } });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith("turn/started", { threadId: "thr_1" }));
  });

  test("answers server initiated requests", async () => {
    const process = fakeChildProcess();
    const connection = new AppServerConnection(process.child, logger());
    connection.registerRequestHandler("item/commandExecution/requestApproval", async () => ({ decision: "accept" }));

    process.pushStdout({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test" },
    });

    await vi.waitFor(() =>
      expect(process.writtenJson()).toContainEqual({ id: 9, result: { decision: "accept" } }),
    );
  });

  test("rejects timed out requests", async () => {
    vi.useFakeTimers();
    const process = fakeChildProcess();
    const connection = new AppServerConnection(process.child, logger());
    const request = connection.request("model/list", {}, 1000);
    const rejection = expect(request).rejects.toThrow("App Server request timed out: model/list");

    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
  });

  test("applies a finite timeout when callers do not provide one", async () => {
    vi.useFakeTimers();
    const process = fakeChildProcess();
    const connection = new AppServerConnection(process.child, logger());
    const request = connection.request("turn/steer", {});
    const rejection = expect(request).rejects.toThrow("App Server request timed out: turn/steer");

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });

  test("summarizes late responses without logging their payload", async () => {
    vi.useFakeTimers();
    const process = fakeChildProcess();
    const testLogger = logger();
    const connection = new AppServerConnection(process.child, testLogger);
    const request = connection.request("thread/read", {}, 1000);
    const rejection = expect(request).rejects.toThrow("App Server request timed out: thread/read");
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;

    process.pushStdout({
      id: 1,
      result: {
        thread: {
          id: "large_thread",
          turns: [{ items: [{ text: "large payload" }] }],
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(testLogger.warn).toHaveBeenCalledWith(
      { responseId: 1, responseKind: "result" },
      "Received Codex App Server response for unknown request.",
    );
    expect(testLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.anything() }),
      expect.anything(),
    );
  });

  test("ignores malformed output and rejects pending requests when closed", async () => {
    const process = fakeChildProcess();
    const testLogger = logger();
    const connection = new AppServerConnection(process.child, testLogger);
    const request = connection.request("model/list", {});
    const rejection = expect(request).rejects.toThrow("App Server connection closed");

    process.stdout.write("not-json\n");
    process.child.emit("close", 1, null);

    await rejection;
    expect(testLogger.warn).toHaveBeenCalled();
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
    stdout,
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
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}
