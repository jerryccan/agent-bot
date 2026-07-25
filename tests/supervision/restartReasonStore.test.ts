import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { restartReasonFile, saveRestartReason, takeRestartReason } from "../../src/supervision/restartReasonStore.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("restartReasonStore", () => {
  test("passes a restart reason across worker and supervisor processes once", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-restart-reason-"));
    directories.push(directory);
    const sqlitePath = path.join(directory, "state.sqlite");

    saveRestartReason(sqlitePath, "部署 CLI 更新");

    expect(path.basename(restartReasonFile(sqlitePath))).toBe("agent-bot-restart-reason.json");
    expect(fs.existsSync(restartReasonFile(sqlitePath))).toBe(true);
    expect(takeRestartReason(sqlitePath)).toBe("部署 CLI 更新");
    expect(takeRestartReason(sqlitePath)).toBeUndefined();
  });
});
