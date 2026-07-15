import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentRuntimeRegistry } from "../../src/runtime/AgentRuntimeRegistry.js";
import { StateStore } from "../../src/state/StateStore.js";
import { SessionMetadataHydrator } from "../../src/startup/SessionMetadataHydrator.js";

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(title?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-hydrator-"));
  directories.push(directory);
  const store = new StateStore(path.join(directory, "state.sqlite"));
  stores.push(store);
  store.createSession({
    localSessionId: "sess_1",
    contextKey: "chat_id:c1",
    agentName: "codex",
    cwd: process.cwd(),
    status: "ready",
  });
  store.updateRuntimeSession("sess_1", {
    runtimeKind: "codex",
    remoteSessionId: "thread_1",
    title,
  });
  const readSessionMetadata = vi.fn(async () => ({ title: "Hydrated title" }));
  const runtimes = {
    get: vi.fn(() => ({ readSessionMetadata })),
  } as unknown as AgentRuntimeRegistry;
  return {
    store,
    readSessionMetadata,
    hydrator: new SessionMetadataHydrator(store, runtimes),
    session: store.getSession("sess_1")!,
  };
}

describe("SessionMetadataHydrator", () => {
  test("reads and persists missing runtime metadata", async () => {
    const { hydrator, readSessionMetadata, session, store } = fixture();

    await expect(hydrator.hydrate(session)).resolves.toMatchObject({ title: "Hydrated title" });
    expect(readSessionMetadata).toHaveBeenCalledWith("thread_1");
    expect(store.getSession("sess_1")?.title).toBe("Hydrated title");
  });

  test("does not read metadata for a session that already has a title", async () => {
    const { hydrator, readSessionMetadata, session } = fixture("Existing title");

    await expect(hydrator.hydrate(session)).resolves.toBe(session);
    expect(readSessionMetadata).not.toHaveBeenCalled();
  });
});
