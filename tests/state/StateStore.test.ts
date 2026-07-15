import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { StateStore } from "../../src/state/StateStore.js";

const tempDirectories: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("StateStore runtime metadata", () => {
  test("lists all persisted user contexts in creation order", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.getOrCreateUserContext("chat_id:c1", "codex");
    store.getOrCreateUserContext("console:local", "codex");

    expect(store.listUserContexts().map((context) => context.contextKey)).toEqual([
      "chat_id:c1",
      "console:local",
    ]);
  });

  test("persists Codex thread settings", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);
    store.createSession({
      localSessionId: "s1",
      contextKey: "chat_id:c1",
      agentName: "codex",
      cwd: process.cwd(),
      status: "ready",
    });

    store.updateRuntimeSession("s1", {
      runtimeKind: "codex",
      remoteSessionId: "thr_1",
      title: "Show startup metadata",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });

    expect(store.getSession("s1")).toMatchObject({
      runtimeKind: "codex",
      remoteSessionId: "thr_1",
      title: "Show startup metadata",
      model: "gpt-test",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
  });

  test("stores bounded turn snapshots and final delivery state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const store = new StateStore(path.join(directory, "state.sqlite"));
    stores.push(store);

    store.saveTurnSnapshot("turn_1", "s1", { status: "completed", summary: "done" });
    store.saveTurnDelivery("turn_1", { progressMessageId: "om_progress" });
    store.saveFinalDeliveryProgress("turn_1", ["om_part_1"]);
    store.markFinalDelivered("turn_1", ["om_final"]);

    expect(store.getTurnSnapshot("turn_1")).toEqual({ status: "completed", summary: "done" });
    expect(store.getTurnDelivery("turn_1")).toMatchObject({
      progressMessageId: "om_progress",
      finalMessageIds: ["om_final"],
      finalDelivered: true,
    });
  });

  test("claims an inbound event only once across store restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bot-state-"));
    tempDirectories.push(directory);
    const dbPath = path.join(directory, "state.sqlite");
    const first = new StateStore(dbPath);
    stores.push(first);
    expect(first.claimInboundEvent("event_1", "message")).toBe(true);
    expect(first.claimInboundEvent("event_1", "message")).toBe(false);
    first.close();
    stores.pop();

    const second = new StateStore(dbPath);
    stores.push(second);
    expect(second.claimInboundEvent("event_1", "message")).toBe(false);
  });
});
