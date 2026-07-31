import fs from "node:fs";
import net from "node:net";
import type { ControlRequest, ControlResponse } from "./controlProtocol.js";

export type ControlRequestHandler = (request: ControlRequest) => Promise<ControlResponse>;

export class LocalControlServer {
  private server?: net.Server;

  constructor(
    private readonly endpoint: string,
    private readonly handleRequest: ControlRequestHandler,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (process.platform !== "win32") fs.rmSync(this.endpoint, { force: true });
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk: string) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const line = input.slice(0, newline);
        input = "";
        void this.respond(socket, line);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.endpoint, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== "win32") fs.rmSync(this.endpoint, { force: true });
  }

  private async respond(socket: net.Socket, line: string): Promise<void> {
    let response: ControlResponse;
    try {
      response = await this.handleRequest(parseRequest(line));
    } catch (error) {
      response = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

function parseRequest(line: string): ControlRequest {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || !("action" in value) || typeof value.action !== "string") {
    throw new Error("Invalid local control request.");
  }
  return value as ControlRequest;
}
