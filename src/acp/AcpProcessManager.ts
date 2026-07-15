import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "pino";
import type { AgentConfig } from "../config/schema.js";
import { AcpJsonRpcConnection } from "./AcpJsonRpcConnection.js";

export interface ManagedAcpProcess {
  processKey: string;
  child: ChildProcessWithoutNullStreams;
  connection: AcpJsonRpcConnection;
  stop: () => void;
}

export class AcpProcessManager {
  private readonly processes = new Map<string, ManagedAcpProcess>();

  constructor(private readonly logger: Logger) {}

  start(processKey: string, agentName: string, agent: AgentConfig): ManagedAcpProcess {
    if (this.processes.has(processKey)) {
      throw new Error(`ACP process already exists: ${processKey}`);
    }

    const child = spawn(agent.command, agent.args, {
      env: {
        ...process.env,
        ...agent.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const childLogger = this.logger.child({ processKey, agentName });
    const connection = new AcpJsonRpcConnection(child, childLogger);
    const managed: ManagedAcpProcess = {
      processKey,
      child,
      connection,
      stop: () => this.stop(processKey),
    };

    this.processes.set(processKey, managed);
    this.bindLifecycle(managed, childLogger);

    childLogger.info({ command: agent.command, args: agent.args }, "Started ACP agent process.");
    return managed;
  }

  get(processKey: string): ManagedAcpProcess | undefined {
    return this.processes.get(processKey);
  }

  stop(processKey: string): void {
    const managed = this.processes.get(processKey);
    if (!managed) {
      return;
    }

    this.processes.delete(processKey);
    managed.connection.close();

    if (!managed.child.killed) {
      managed.child.kill();
    }
  }

  stopAll(): void {
    for (const processKey of this.processes.keys()) {
      this.stop(processKey);
    }
  }

  private bindLifecycle(managed: ManagedAcpProcess, logger: Logger): void {
    const stderr = readline.createInterface({
      input: managed.child.stderr,
      crlfDelay: Infinity,
    });

    stderr.on("line", (line) => {
      logger.debug({ stderr: line }, "ACP agent stderr.");
    });

    managed.child.once("error", (error) => {
      logger.error({ error }, "ACP agent process error.");
    });

    managed.child.once("exit", (code, signal) => {
      this.processes.delete(managed.processKey);
      logger.info({ code, signal }, "ACP agent process exited.");
    });
  }
}
