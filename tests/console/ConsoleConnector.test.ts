import readline from "node:readline";
import type { Logger } from "pino";
import { expect, test, vi } from "vitest";
import { ConsoleConnector } from "../../src/console/ConsoleConnector.js";

const readlineMock = vi.hoisted(() => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    handlers,
    prompt: vi.fn(),
    close: vi.fn(),
    createInterface: vi.fn(() => ({
      prompt: readlineMock.prompt,
      close: readlineMock.close,
      on: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
        handlers[name] = handler;
      }),
    })),
  };
});

vi.mock("node:readline", () => ({ default: { createInterface: readlineMock.createInterface } }));

test("uses an independent console context and remains responsive", async () => {
  const handler = { onMessage: vi.fn(async () => undefined), onCardAction: vi.fn(async () => undefined) };
  const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const connector = new ConsoleConnector(handler, logger);
  connector.start();
  readlineMock.handlers.line?.("inspect repo");
  await vi.waitFor(() => expect(handler.onMessage).toHaveBeenCalled());

  expect(readline.createInterface).toHaveBeenCalledOnce();
  expect(handler.onMessage).toHaveBeenCalledWith(expect.objectContaining({ contextKey: "console:local", text: "inspect repo" }));
  connector.stop();
  expect(readlineMock.close).toHaveBeenCalled();
});
