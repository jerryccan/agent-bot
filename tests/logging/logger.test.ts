import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DailyLogStream, dailyLogPath } from "../../src/logging/DailyLogStream.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("DailyLogStream", () => {
  test("adds the local calendar date before the configured extension", () => {
    expect(dailyLogPath(
      path.join("logs", "agent-bot.log"),
      new Date(2026, 7, 14, 23, 59, 59),
    )).toBe(path.join("logs", "agent-bot.2026-08-14.log"));
  });

  test("switches files after the local calendar day changes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-logs-"));
    temporaryDirectories.push(directory);
    const basePath = path.join(directory, "agent-bot.log");
    let now = new Date(2026, 7, 14, 23, 59, 59);
    const stream = new DailyLogStream(basePath, { clock: () => now });

    await write(stream, "first\n");
    await write(stream, "second\n");
    now = new Date(2026, 7, 15, 0, 0, 1);
    await write(stream, "third\n");
    await close(stream);

    expect(fs.readFileSync(path.join(directory, "agent-bot.2026-08-14.log"), "utf8"))
      .toBe("first\nsecond\n");
    expect(fs.readFileSync(path.join(directory, "agent-bot.2026-08-15.log"), "utf8"))
      .toBe("third\n");
    expect(fs.existsSync(basePath)).toBe(false);
  });
});

function write(stream: DailyLogStream, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}

function close(stream: DailyLogStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
