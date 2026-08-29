import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "pino";
import { AppServerConnection } from "./AppServerConnection.js";
import type { AppServerClient, AppServerClientProvider } from "./CodexRuntime.js";
import {
  agentBotEnvironment,
  type AgentEnvironmentContext,
} from "../runtime/agentEnvironment.js";
import type { AgentProcessInfo } from "../runtime/types.js";
import { spawnStdioCommand } from "../utils/spawnCommand.js";

export class CodexProcessManager implements AppServerClientProvider {
  private client?: AppServerConnection;
  private child?: ChildProcessWithoutNullStreams;
  private version?: string;
  private readonly disconnectListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly logger: Logger,
    private readonly environmentContext: () => AgentEnvironmentContext = () => ({}),
  ) {}

  async getClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    this.version = undefined;
    const environmentContext = this.environmentContext();
    const child = spawnStdioCommand(
      this.command,
      this.args,
      agentBotEnvironment(process.env, this.env, environmentContext),
      environmentContext.profilePath ?? os.homedir(),
    );
    this.child = child;
    const client = new AppServerConnection(child, this.logger.child({ component: "codex-app-server" }));
    this.client = client;
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
      this.logger.debug({ line }, "App Server stderr.");
    });
    child.once("error", (error) => this.logger.error({ error }, "App Server process error."));
    child.once("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "App Server process exited.");
      client.close();
      if (this.client === client) this.client = undefined;
      if (this.child === child) this.child = undefined;
      const error = new Error(`App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      for (const listener of this.disconnectListeners) listener(error);
    });
    const initializeResult = await client.request("initialize", {
      clientInfo: { name: "agent-bot", title: "Agent Bot", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.version = initializedAgentVersion(initializeResult);
    client.notify("initialized", {});
    return client;
  }

  getProcessInfo(): AgentProcessInfo {
    const pid = this.child?.pid;
    if (!pid) return {};
    return {
      pid,
      ...(this.version ? { version: this.version } : {}),
    };
  }

  getCodexHome(): string {
    return this.env.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  }

  close(): void {
    this.client?.close();
    if (this.child && !this.child.killed) this.child.kill();
    this.client = undefined;
    this.child = undefined;
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
}

function initializedAgentVersion(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  const serverInfo = result.serverInfo && typeof result.serverInfo === "object"
    ? result.serverInfo as Record<string, unknown>
    : undefined;
  for (const candidate of [serverInfo?.version, result.version, result.userAgent]) {
    if (typeof candidate !== "string") continue;
    const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/u.exec(candidate);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
