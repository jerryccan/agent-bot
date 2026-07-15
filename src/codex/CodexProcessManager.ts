import { spawn } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "pino";
import { AppServerConnection } from "./AppServerConnection.js";
import type { AppServerClient, AppServerClientProvider } from "./CodexRuntime.js";

export class CodexProcessManager implements AppServerClientProvider {
  private client?: AppServerConnection;
  private child?: ReturnType<typeof spawn>;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly logger: Logger,
  ) {}

  async getClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    const child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const client = new AppServerConnection(child, this.logger.child({ component: "codex-app-server" }));
    this.client = client;
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
      this.logger.debug({ line }, "Codex App Server stderr.");
    });
    child.once("error", (error) => this.logger.error({ error }, "Codex App Server process error."));
    child.once("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "Codex App Server process exited.");
      client.close();
      if (this.client === client) this.client = undefined;
      if (this.child === child) this.child = undefined;
    });
    await client.request("initialize", {
      clientInfo: { name: "feishu_acp_gateway", title: "Feishu ACP Gateway", version: "0.1.0" },
    });
    client.notify("initialized", {});
    return client;
  }

  close(): void {
    this.client?.close();
    if (this.child && !this.child.killed) this.child.kill();
    this.client = undefined;
    this.child = undefined;
  }
}
