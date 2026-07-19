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
});
