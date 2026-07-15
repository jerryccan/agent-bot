export type RuntimeKind = "acp" | "codex";
export type PermissionMode = "auto" | "confirm";
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type ToolStatus = "running" | "completed" | "failed";

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolState {
  id: string;
  title: string;
  kind: string;
  status: ToolStatus;
  command?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
  files?: Array<{ path: string; additions?: number; deletions?: number }>;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  command?: string;
  reason?: string;
  options: Array<{ id: ApprovalDecision; label: string }>;
}

export type AgentEvent =
  | { type: "turn_started"; sessionId: string; turnId: string; startedAt: number }
  | { type: "agent_text_delta"; sessionId: string; turnId: string; text: string }
  | {
      type: "progress";
      sessionId: string;
      turnId: string;
      text: string;
      activityId?: string;
      append?: boolean;
    }
  | { type: "plan_updated"; sessionId: string; turnId: string; steps: PlanStep[] }
  | { type: "tool_started"; sessionId: string; turnId: string; tool: ToolState }
  | { type: "tool_updated"; sessionId: string; turnId: string; tool: ToolState }
  | { type: "approval_requested"; sessionId: string; turnId: string; request: ApprovalRequest }
  | { type: "approval_resolved"; sessionId: string; turnId: string; requestId: string; decision: ApprovalDecision }
  | { type: "turn_completed"; sessionId: string; turnId: string; finalResponse: string; durationMs?: number }
  | { type: "turn_cancelled"; sessionId: string; turnId: string }
  | { type: "turn_failed"; sessionId: string; turnId: string; message: string };

export interface SessionMetadataUpdatedEvent {
  type: "session_metadata_updated";
  sessionId: string;
  title: string;
}

export type RuntimeEvent = AgentEvent | SessionMetadataUpdatedEvent;

export interface RuntimeSessionMetadata {
  title?: string;
}

export interface RuntimeSession {
  localSessionId: string;
  remoteSessionId: string;
  runtimeKind: RuntimeKind;
  agentName: string;
  cwd: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  activeTurnId?: string;
}

export interface CreateRuntimeSessionInput {
  localSessionId: string;
  agentName: string;
  cwd: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
}

export interface ResumeRuntimeSessionInput extends CreateRuntimeSessionInput {
  remoteSessionId: string;
}

export interface ModelOption {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort?: string;
}

export interface ReasoningEffortOption {
  value: string;
  description?: string;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession>;
  getSession(localSessionId: string): RuntimeSession | undefined;
  readSessionMetadata(remoteSessionId: string): Promise<RuntimeSessionMetadata>;
  startTurn(sessionId: string, text: string): Promise<string>;
  steerTurn(sessionId: string, turnId: string, text: string): Promise<void>;
  cancelTurn(sessionId: string, turnId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  setReasoningEffort(sessionId: string, effort: string): Promise<void>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>;
  respondToApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  close(): void;
}
