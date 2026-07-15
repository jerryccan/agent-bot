import type { JsonValue } from "../acp/acpTypes.js";
import { AcpSessionManager } from "../acp/AcpSessionManager.js";
import { createId } from "../utils/id.js";
import type {
  AgentEvent,
  AgentRuntime,
  ApprovalDecision,
  CreateRuntimeSessionInput,
  ModelOption,
  PermissionMode,
  ResumeRuntimeSessionInput,
  RuntimeSession,
  ToolState,
} from "./types.js";

interface ActiveAcpTurn {
  turnId: string;
  finalText: string;
}

export class AcpRuntimeAdapter implements AgentRuntime {
  readonly kind = "acp" as const;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly activeTurns = new Map<string, ActiveAcpTurn>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly approvals = new Map<
    string,
    { sessionId: string; resolve: (value: JsonValue) => void; optionIds: Map<ApprovalDecision, string> }
  >();

  constructor(private readonly acp: AcpSessionManager) {}

  getSession(localSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(localSessionId);
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    const created = await this.acp.create({
      localSessionId: input.localSessionId,
      agentName: input.agentName,
      cwd: input.cwd,
      onUpdate: (_session, update) => this.handleUpdate(input.localSessionId, update),
      onPermissionRequest: (_session, params) =>
        new Promise<JsonValue>((resolve) => {
          const requestId = createId("approval");
          const active = this.activeTurns.get(input.localSessionId);
          const optionIds = new Map<ApprovalDecision, string>();
          for (const option of params.options) {
            if (option.kind.startsWith("allow")) optionIds.set("accept", option.optionId);
            if (option.kind.startsWith("reject") || option.kind.startsWith("deny")) {
              optionIds.set("decline", option.optionId);
            }
          }
          this.approvals.set(requestId, { sessionId: input.localSessionId, resolve, optionIds });
          this.emit({
            type: "approval_requested",
            sessionId: input.localSessionId,
            turnId: active?.turnId ?? "unknown",
            request: {
              id: requestId,
              title: typeof params.toolCall.title === "string" ? params.toolCall.title : "ACP permission request",
              options: [
                { id: "accept", label: "允许" },
                { id: "decline", label: "拒绝" },
              ],
            },
          });
        }),
    });
    const session: RuntimeSession = {
      localSessionId: input.localSessionId,
      remoteSessionId: created.acpSessionId,
      runtimeKind: "acp",
      agentName: input.agentName,
      cwd: input.cwd,
      model: input.model,
      permissionMode: input.permissionMode,
    };
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession> {
    return this.createSession(input);
  }

  async startTurn(sessionId: string, text: string): Promise<string> {
    const session = this.requireSession(sessionId);
    const turnId = createId("turn");
    session.activeTurnId = turnId;
    this.activeTurns.set(sessionId, { turnId, finalText: "" });
    this.emit({ type: "turn_started", sessionId, turnId, startedAt: Date.now() });
    void this.acp.prompt(sessionId, text).then(
      () => {
        const active = this.activeTurns.get(sessionId);
        if (!active || active.turnId !== turnId) return;
        session.activeTurnId = undefined;
        this.activeTurns.delete(sessionId);
        this.emit({ type: "turn_completed", sessionId, turnId, finalResponse: active.finalText });
      },
      (error: unknown) => {
        session.activeTurnId = undefined;
        this.activeTurns.delete(sessionId);
        this.emit({
          type: "turn_failed",
          sessionId,
          turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return turnId;
  }

  async steerTurn(_sessionId: string, _turnId: string, _text: string): Promise<void> {
    throw new Error("ACP runtime does not support steering an active turn.");
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    this.acp.cancel(sessionId);
    const session = this.requireSession(sessionId);
    session.activeTurnId = undefined;
    this.activeTurns.delete(sessionId);
    this.emit({ type: "turn_cancelled", sessionId, turnId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.acp.close(sessionId);
    this.sessions.delete(sessionId);
    this.activeTurns.delete(sessionId);
  }

  async setModel(): Promise<void> {
    throw new Error("ACP runtime does not expose model selection through the gateway.");
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    this.requireSession(sessionId).permissionMode = mode;
  }

  async respondToApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error("Approval request is no longer pending.");
    }
    this.approvals.delete(requestId);
    const optionId = pending.optionIds.get(decision) ?? pending.optionIds.get(decision === "cancel" ? "decline" : "accept");
    pending.resolve({ outcome: { outcome: "selected", optionId: optionId ?? decision } });
  }

  async listModels(): Promise<ModelOption[]> {
    return [];
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.sessions.clear();
    this.activeTurns.clear();
    this.approvals.clear();
  }

  private handleUpdate(sessionId: string, update: Record<string, JsonValue>): void {
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    const updateType = update.sessionUpdate;
    if (updateType === "agent_message_chunk" && isRecord(update.content) && typeof update.content.text === "string") {
      active.finalText += update.content.text;
      this.emit({ type: "agent_text_delta", sessionId, turnId: active.turnId, text: update.content.text });
      return;
    }
    if (updateType === "tool_call" || updateType === "tool_call_update") {
      const tool: ToolState = {
        id: typeof update.toolCallId === "string" ? update.toolCallId : createId("tool"),
        title: typeof update.title === "string" ? update.title : "ACP tool",
        kind: typeof update.kind === "string" ? update.kind : "tool",
        status: update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running",
      };
      this.emit({
        type: updateType === "tool_call" ? "tool_started" : "tool_updated",
        sessionId,
        turnId: active.turnId,
        tool,
      });
    }
  }

  private requireSession(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown runtime session: ${sessionId}`);
    return session;
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
