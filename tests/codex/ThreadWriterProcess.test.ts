import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  parseWindowsLockOwners,
  SystemThreadWriterProcessController,
  threadWriterLockPath,
  type ThreadWriterProcess,
} from "../../src/codex/ThreadWriterProcess.js";

describe("ThreadWriterProcess", () => {
  test("builds a Codex thread-writer lock path only for UUID thread IDs", () => {
    const threadId = "01a05543-1cfd-75b1-9eba-1ce331ab4230";

    expect(threadWriterLockPath("C:\\Users\\Admin\\.codex", threadId)).toBe(
      path.join("C:\\Users\\Admin\\.codex", "thread-writer-locks", `${threadId}.lock`),
    );
    expect(threadWriterLockPath("C:\\Users\\Admin\\.codex", "../../unsafe")).toBeUndefined();
  });

  test("parses a single Restart Manager owner into a stable process fingerprint", () => {
    expect(parseWindowsLockOwners(JSON.stringify({
      writerPid: 53704,
      writerProcessName: "codex.exe",
      writerStartedAt: "2026-09-05T10:00:00.000Z",
      applicationPid: 81552,
      applicationProcessName: "ChatGPT.exe",
      applicationStartedAt: "2026-09-05T09:00:00.000Z",
      displayName: "Codex Desktop",
      canClose: true,
      commandLine: "codex.exe app-server",
    }))).toEqual([{
      writerPid: 53704,
      writerProcessName: "codex.exe",
      writerStartedAt: "2026-09-05T10:00:00.000Z",
      applicationPid: 81552,
      applicationProcessName: "ChatGPT.exe",
      applicationStartedAt: "2026-09-05T09:00:00.000Z",
      displayName: "Codex Desktop",
      canClose: true,
      commandLine: "codex.exe app-server",
    }]);
  });

  test("ignores malformed Restart Manager entries", () => {
    expect(parseWindowsLockOwners(JSON.stringify([
      null,
      { writerPid: 0, writerProcessName: "codex.exe" },
      { writerPid: 12, writerProcessName: "codex.exe", applicationPid: "13" },
    ]))).toEqual([]);
  });

  test("finds every thread lock held by the same application process", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-writer-locks-"));
    const currentThreadId = "01a05543-1cfd-75b1-9eba-1ce331ab4230";
    const siblingThreadId = "019fbc76-5c41-7e53-93b8-1f9fb2e3de1c";
    const otherThreadId = "019fa222-5422-7e20-8c26-8a3603e26159";
    const owner: ThreadWriterProcess = {
      writerPid: 53704,
      writerProcessName: "codex.exe",
      writerStartedAt: "2026-09-05T10:00:00.000Z",
      applicationPid: 81552,
      applicationProcessName: "ChatGPT.exe",
      applicationStartedAt: "2026-09-05T09:00:00.000Z",
      displayName: "Codex Desktop",
      canClose: true,
    };
    try {
      for (const threadId of [currentThreadId, siblingThreadId, otherThreadId]) {
        fs.writeFileSync(path.join(directory, `${threadId}.lock`), "");
      }
      fs.writeFileSync(path.join(directory, ".coordination.lock"), "");
      const controller = new SystemThreadWriterProcessController();
      vi.spyOn(controller, "inspect").mockImplementation(async (lockPath) =>
        lockPath.endsWith(`${siblingThreadId}.lock`)
          ? [owner]
          : [{ ...owner, applicationPid: 99999 }]);

      const ownedThreadIds = await controller.inspectApplicationThreadIds(
        path.join(directory, `${currentThreadId}.lock`),
        owner,
      );

      expect(ownedThreadIds).toEqual(expect.arrayContaining([currentThreadId, siblingThreadId]));
      expect(ownedThreadIds).not.toContain(otherThreadId);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
