import path from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type {
  AcpInitializeResult,
  AcpPermissionRequestParams,
  AcpPromptResult,
  AcpSessionNewResult,
  AcpSessionUpdateParams,
  JsonValue,
} from "./acpTypes.js";
import { AcpProcessManager, type ManagedAcpProcess } from "./AcpProcessManager.js";

export interface RuntimeSession {
  localSessionId: string;
  processKey: string;
  agentName: string;
  cwd: string;
  acpSessionId: string;
  managed: ManagedAcpProcess;
  running: boolean;
  modes?: JsonValue;
  configOptions?: JsonValue;
  availableCommands?: JsonValue;
}

export interface CreateRuntimeSessionInput {
  localSessionId: string;
  agentName: string;
  cwd: string;
  onUpdate: (session: RuntimeSession, update: Record<string, JsonValue>) => void;
  onPermissionRequest: (
    session: RuntimeSession,
    params: AcpPermissionRequestParams,
  ) => Promise<JsonValue>;
}

export class AcpSessionManager {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly sessionsByAcpId = new Map<string, RuntimeSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly processManager: AcpProcessManager,
    private readonly logger: Logger,
  ) {}

  get(localSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(localSessionId);
  }

  async create(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    const agent = this.config.agents[input.agentName];
    if (!agent) {
      throw new Error(`Unknown agent: ${input.agentName}`);
    }

    const cwd = path.resolve(input.cwd);
    const processKey = input.localSessionId;
    const managed = this.processManager.start(processKey, input.agentName, agent);
    const connection = managed.connection;

    let runtime: RuntimeSession | undefined;

    connection.registerHandler("session/request_permission", async (params) => {
      if (!runtime) {
        throw new Error("Received permission request before session was ready.");
      }

      return input.onPermissionRequest(runtime, params as unknown as AcpPermissionRequestParams);
    });

    connection.on("notification", (_method, params) => {
      if (_method !== "session/update") {
        return;
      }

      const updateParams = params as unknown as AcpSessionUpdateParams;
      const target = this.sessionsByAcpId.get(updateParams.sessionId);
      if (!target) {
        this.logger.debug({ updateParams }, "Ignoring update for unknown ACP session.");
        return;
      }

      this.applySessionUpdate(target, updateParams.update);
      input.onUpdate(target, updateParams.update);
    });

    const initializeResult = await connection.request<AcpInitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "agent-bot",
        title: "Agent Bot",
        version: "0.1.0",
      },
    });

    if (initializeResult.authMethods?.length) {
      const method = initializeResult.authMethods[0];
      this.logger.info({ methodId: method.id }, "Authenticating ACP agent with first advertised method.");
      await connection.request("authenticate", { methodId: method.id });
    }

    const newSessionResult = await connection.request<AcpSessionNewResult>("session/new", {
      cwd,
      mcpServers: [],
    });

    runtime = {
      localSessionId: input.localSessionId,
      processKey,
      agentName: input.agentName,
      cwd,
      acpSessionId: newSessionResult.sessionId,
      managed,
      running: false,
      modes: newSessionResult.modes,
      configOptions: newSessionResult.configOptions,
    };

    this.sessions.set(input.localSessionId, runtime);
    this.sessionsByAcpId.set(runtime.acpSessionId, runtime);
    return runtime;
  }

  async prompt(localSessionId: string, text: string): Promise<AcpPromptResult> {
    const session = this.requireSession(localSessionId);
    if (session.running) {
      throw new Error(`Session is already running: ${localSessionId}`);
    }

    session.running = true;
    try {
      return await session.managed.connection.request<AcpPromptResult>("session/prompt", {
        sessionId: session.acpSessionId,
        prompt: [
          {
            type: "text",
            text,
          },
        ],
      });
    } finally {
      session.running = false;
    }
  }

  cancel(localSessionId: string): void {
    const session = this.requireSession(localSessionId);
    session.managed.connection.notify("session/cancel", {
      sessionId: session.acpSessionId,
    });
  }

  async close(localSessionId: string): Promise<void> {
    const session = this.requireSession(localSessionId);
    try {
      await session.managed.connection.request(
        "session/close",
        {
          sessionId: session.acpSessionId,
        },
        1500,
      );
    } catch (error) {
      this.logger.debug({ error, localSessionId }, "Ignoring session/close failure.");
    }

    this.sessions.delete(localSessionId);
    this.sessionsByAcpId.delete(session.acpSessionId);
    this.processManager.stop(session.processKey);
  }

  async setMode(localSessionId: string, modeId: string): Promise<void> {
    const session = this.requireSession(localSessionId);
    await session.managed.connection.request("session/set_mode", {
      sessionId: session.acpSessionId,
      modeId,
    });
  }

  async setConfigOption(localSessionId: string, configId: string, value: string): Promise<JsonValue> {
    const session = this.requireSession(localSessionId);
    const result = await session.managed.connection.request<JsonValue>("session/set_config_option", {
      sessionId: session.acpSessionId,
      configId,
      value,
    });

    if (isObject(result) && "configOptions" in result) {
      session.configOptions = result.configOptions;
    }

    return result;
  }

  private requireSession(localSessionId: string): RuntimeSession {
    const session = this.sessions.get(localSessionId);
    if (!session) {
      throw new Error(`Unknown runtime session: ${localSessionId}`);
    }
    return session;
  }

  private applySessionUpdate(session: RuntimeSession, update: Record<string, JsonValue>): void {
    const updateType = update.sessionUpdate;
    if (updateType === "config_option_update" && "configOptions" in update) {
      session.configOptions = update.configOptions;
    }

    if (updateType === "current_mode_update" && session.modes && isObject(session.modes)) {
      session.modes = {
        ...session.modes,
        currentModeId: update.modeId,
      };
    }

    if (updateType === "available_commands_update" && "availableCommands" in update) {
      session.availableCommands = update.availableCommands;
    }
  }
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
