import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalControlServer } from "../../src/cli/LocalControlServer.js";
import { isServerRunning, sendControlRequest } from "../../src/cli/LocalControlClient.js";
import { controlEndpoint } from "../../src/cli/controlProtocol.js";

const servers: LocalControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("local CLI control", () => {
  test("uses a stable endpoint for one state database", () => {
    const sqlitePath = path.join(os.tmpdir(), "acp-control", "state.sqlite");
    expect(controlEndpoint(sqlitePath)).toBe(controlEndpoint(sqlitePath));
    expect(controlEndpoint(`${sqlitePath}.other`)).not.toBe(controlEndpoint(sqlitePath));
  });

  test("round-trips requests and reports handler failures", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `acp-control-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => {
      if (request.action === "health") return { ok: true, data: { pid: 42 } };
      throw new Error("rejected");
    });
    servers.push(server);
    await server.start();

    await expect(isServerRunning(endpoint)).resolves.toBe(true);
    await expect(sendControlRequest(endpoint, { action: "health" })).resolves.toEqual({
      ok: true,
      data: { pid: 42 },
    });
    await expect(sendControlRequest(endpoint, { action: "server_stop" })).resolves.toEqual({
      ok: false,
      message: "rejected",
    });
  });

  test("round-trips a targeted task prompt request", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `acp-control-prompt-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_prompt",
      localSessionId: "session_1",
      text: "continue from CLI",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_prompt",
        localSessionId: "session_1",
        text: "continue from CLI",
      },
    });
  });

  test("round-trips a live task status request", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `acp-control-status-${process.pid}-${Date.now()}.sqlite`));
    const server = new LocalControlServer(endpoint, async (request) => ({ ok: true, data: request }));
    servers.push(server);
    await server.start();

    await expect(sendControlRequest(endpoint, {
      action: "task_status",
      localSessionId: "session_status",
    })).resolves.toEqual({
      ok: true,
      data: {
        action: "task_status",
        localSessionId: "session_status",
      },
    });
  });

  test.skipIf(process.platform !== "win32")("rejects a second server for the same Windows control pipe", async () => {
    const endpoint = controlEndpoint(path.join(os.tmpdir(), `acp-control-exclusive-${process.pid}-${Date.now()}.sqlite`));
    const first = new LocalControlServer(endpoint, async () => ({ ok: true }));
    const duplicate = new LocalControlServer(endpoint, async () => ({ ok: true }));
    servers.push(first, duplicate);
    await first.start();

    await expect(duplicate.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(isServerRunning(endpoint)).resolves.toBe(true);
  });
});
