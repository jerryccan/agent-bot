import type { Logger } from "pino";
import type {
  AgentRuntime,
  ApprovalDecision,
  CreateRuntimeSessionInput,
  ModelOption,
  PermissionMode,
  ResumeRuntimeSessionInput,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionMetadata,
} from "../runtime/types.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";
import { mapCodexNotification } from "./CodexEventMapper.js";
import { detectProjectlessWorkspace } from "./ProjectlessWorkspace.js";

const WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS = [
  "When capturing any screenshot on Windows, use one fresh process and make it Per-Monitor DPI Aware V2 before loading System.Windows.Forms, System.Drawing, or UI Automation, and before calling any screen, window, or bounds API.",
  "Call user32!SetProcessDpiAwarenessContext((IntPtr)-4) in that same process and verify that it succeeded or that the process is already PMv2 before continuing.",
  "For a full monitor or desktop, query the physical monitor or virtual-desktop bounds only after PMv2 is active.",
  "For a specific window, obtain its HWND after PMv2 is active and use DwmGetWindowAttribute with DWMWA_EXTENDED_FRAME_BOUNDS (9) for the physical visible window bounds; use GetWindowRect only as a fallback after PMv2 is active.",
  "Never crop a window with DPI-virtualized coordinates from an unaware process or with UI Automation BoundingRectangle coordinates.",
  "Call Graphics.CopyFromScreen with those physical coordinates and validate that the saved bitmap dimensions exactly equal the selected physical capture bounds.",
].join(" ");

export interface AppServerClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  registerRequestHandler(
    method: string,
    handler: (params: unknown, id: string | number, method: string) => Promise<unknown>,
  ): void;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
}

export interface AppServerClientProvider {
  getClient(): Promise<AppServerClient>;
  onDisconnect?(listener: (error: Error) => void): () => void;
  close(): void;
}

interface CodexSession extends RuntimeSession {
  finalText: string;
  needsResume: boolean;
}

interface PendingApproval {
  sessionId: string;
  turnId: string;
  resolve: (value: { decision: ApprovalDecision }) => void;
}

export class CodexRuntime implements AgentRuntime {
  readonly kind = "codex" as const;
  private readonly sessions = new Map<string, CodexSession>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly approvals = new Map<string, PendingApproval>();
  private attachedClient?: AppServerClient;
  private unsubscribe?: () => void;
  private readonly unsubscribeDisconnect?: () => void;

  constructor(
    private readonly provider: AppServerClientProvider,
    private readonly logger: Logger,
  ) {
    this.unsubscribeDisconnect = provider.onDisconnect?.((error) => this.handleDisconnect(error));
  }

  getSession(localSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(localSessionId);
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    const client = await this.client();
    const response = await client.request<ThreadResponse>("thread/start", {
      cwd: input.cwd,
      model: input.model,
      threadSource: "user",
      ...threadLifecycleParams(input.cwd),
      ...permissionParams(input.permissionMode),
    });
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession> {
    const client = await this.client();
    const response = await client.request<ThreadResponse>("thread/resume", {
      threadId: input.remoteSessionId,
      cwd: input.cwd,
      model: input.model,
      ...threadLifecycleParams(input.cwd),
      ...permissionParams(input.permissionMode),
    });
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async startTurn(sessionId: string, text: string): Promise<string> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    if (session.needsResume) {
      await client.request("thread/resume", {
        threadId: session.remoteSessionId,
        cwd: session.cwd,
        model: session.model,
        ...threadLifecycleParams(session.cwd),
        ...permissionParams(session.permissionMode),
      });
      session.needsResume = false;
    }
    const response = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId: session.remoteSessionId,
      input: [{ type: "text", text }],
      cwd: session.cwd,
      model: session.model,
      effort: session.reasoningEffort,
      summary: "auto",
      approvalPolicy: session.permissionMode === "auto" ? "never" : "on-request",
    });
    session.activeTurnId = response.turn.id;
    session.finalText = "";
    this.emit({ type: "turn_started", sessionId, turnId: response.turn.id, startedAt: Date.now() });
    return response.turn.id;
  }

  async readSessionMetadata(remoteSessionId: string): Promise<RuntimeSessionMetadata> {
    const response = await (await this.client()).request<ThreadReadResponse>(
      "thread/read",
      { threadId: remoteSessionId, includeTurns: false },
      5_000,
    );
    return {
      title: normalizeTaskTitle(response.thread.name) ?? normalizeTaskTitle(response.thread.preview),
    };
  }

  async steerTurn(sessionId: string, turnId: string, text: string): Promise<void> {
    const session = this.requireActiveTurn(sessionId, turnId);
    await (await this.client()).request("turn/steer", {
      threadId: session.remoteSessionId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
    });
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    const session = this.requireActiveTurn(sessionId, turnId);
    await (await this.client()).request("turn/interrupt", { threadId: session.remoteSessionId, turnId });
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await (await this.client()).request("thread/archive", { threadId: session.remoteSessionId });
    this.sessions.delete(sessionId);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    this.requireSession(sessionId).model = model;
  }

  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    this.requireSession(sessionId).reasoningEffort = effort;
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
    if (!pending || pending.sessionId !== sessionId) throw new Error("Approval request is no longer pending.");
    this.approvals.delete(requestId);
    pending.resolve({ decision });
    this.emit({ type: "approval_resolved", sessionId, turnId: pending.turnId, requestId, decision });
  }

  async listModels(): Promise<ModelOption[]> {
    const response = await (await this.client()).request<{
      data: Array<{
        id: string;
        displayName?: string;
        isDefault?: boolean;
        supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
        defaultReasoningEffort?: string;
      }>;
    }>(
      "model/list",
      {},
    );
    return response.data.filter((model) => model.id).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      isDefault: model.isDefault,
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({
        value: option.reasoningEffort,
        description: option.description,
      })),
      defaultReasoningEffort: model.defaultReasoningEffort,
    }));
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribeDisconnect?.();
    for (const pending of this.approvals.values()) pending.resolve({ decision: "cancel" });
    this.approvals.clear();
    this.sessions.clear();
    this.provider.close();
  }

  private async client(): Promise<AppServerClient> {
    const client = await this.provider.getClient();
    if (client !== this.attachedClient) this.attachClient(client);
    return client;
  }

  private attachClient(client: AppServerClient): void {
    this.unsubscribe?.();
    this.attachedClient = client;
    this.unsubscribe = client.onNotification((method, params) => this.handleNotification(method, params));
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]) {
      client.registerRequestHandler(method, (params, id) => this.handleApproval(params, id));
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "thread/name/updated" && isRecord(params)) {
      const threadId = stringValue(params.threadId);
      const title = normalizeTaskTitle(stringValue(params.threadName));
      if (!threadId || !title) return;
      const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === threadId);
      if (!session) return;
      session.title = title;
      this.emit({ type: "session_metadata_updated", sessionId: session.localSessionId, title });
      return;
    }
    const mapped = mapCodexNotification(method, params);
    if (!mapped) return;
    const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === mapped.threadId);
    if (!session || !session.activeTurnId || session.activeTurnId !== mapped.turnId) return;
    const sessionId = session.localSessionId;
    if (mapped.kind === "agent_delta") {
      session.finalText += mapped.text;
      this.emit({ type: "agent_text_delta", sessionId, turnId: mapped.turnId, text: mapped.text });
    } else if (mapped.kind === "progress") {
      this.emit({
        type: "progress",
        sessionId,
        turnId: mapped.turnId,
        activityId: mapped.activityId,
        text: mapped.text,
        append: mapped.append,
      });
    } else if (mapped.kind === "plan") {
      this.emit({ type: "plan_updated", sessionId, turnId: mapped.turnId, steps: mapped.steps });
    } else if (mapped.kind === "tool") {
      this.emit({
        type: mapped.phase === "started" ? "tool_started" : "tool_updated",
        sessionId,
        turnId: mapped.turnId,
        tool: mapped.tool,
      });
    } else if (mapped.kind === "terminal") {
      session.activeTurnId = undefined;
      if (mapped.status === "cancelled") {
        this.emit({ type: "turn_cancelled", sessionId, turnId: mapped.turnId });
      } else if (mapped.status === "failed") {
        this.emit({ type: "turn_failed", sessionId, turnId: mapped.turnId, message: mapped.error ?? "Codex turn failed." });
      } else {
        this.emit({
          type: "turn_completed",
          sessionId,
          turnId: mapped.turnId,
          finalResponse: session.finalText,
          durationMs: mapped.durationMs,
        });
      }
    }
  }

  private handleApproval(params: unknown, id: string | number): Promise<{ decision: ApprovalDecision }> {
    if (!isRecord(params)) return Promise.resolve({ decision: "decline" });
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === threadId);
    if (!session || !turnId) return Promise.resolve({ decision: "decline" });
    if (session.permissionMode === "auto") return Promise.resolve({ decision: "accept" });
    const requestId = String(id);
    const response = new Promise<{ decision: ApprovalDecision }>((resolve) => {
      this.approvals.set(requestId, { sessionId: session.localSessionId, turnId, resolve });
    });
    this.emit({
      type: "approval_requested",
      sessionId: session.localSessionId,
      turnId,
      request: {
        id: requestId,
        title: stringValue(params.command) ?? "Codex approval request",
        command: stringValue(params.command),
        reason: stringValue(params.reason),
        options: [
          { id: "accept", label: "允许一次" },
          { id: "acceptForSession", label: "本会话允许" },
          { id: "decline", label: "拒绝" },
          { id: "cancel", label: "取消任务" },
        ],
      },
    });
    return response;
  }

  private async resolveReasoningEffort(
    input: CreateRuntimeSessionInput,
    response: ThreadResponse,
  ): Promise<string | undefined> {
    if (input.reasoningEffort) return input.reasoningEffort;
    if (response.reasoningEffort) return response.reasoningEffort;
    const model = input.model ?? response.model;
    const models = await this.listModels();
    return models.find((item) => item.id === model)?.defaultReasoningEffort
      ?? models.find((item) => item.isDefault)?.defaultReasoningEffort;
  }

  private makeSession(
    input: CreateRuntimeSessionInput,
    response: ThreadResponse,
    reasoningEffort?: string,
  ): CodexSession {
    return {
      localSessionId: input.localSessionId,
      remoteSessionId: response.thread.id,
      runtimeKind: "codex",
      agentName: input.agentName,
      cwd: input.cwd,
      title: normalizeTaskTitle(response.thread.name)
        ?? normalizeTaskTitle(response.thread.preview)
        ?? input.title,
      model: input.model ?? response.model,
      reasoningEffort,
      permissionMode: input.permissionMode,
      finalText: "",
      needsResume: false,
    };
  }

  private requireSession(sessionId: string): CodexSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Codex session: ${sessionId}`);
    return session;
  }

  private requireActiveTurn(sessionId: string, turnId: string): CodexSession {
    const session = this.requireSession(sessionId);
    if (session.activeTurnId !== turnId) throw new Error(`Codex turn is no longer active: ${turnId}`);
    return session;
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private handleDisconnect(error: Error): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.attachedClient = undefined;
    for (const session of this.sessions.values()) {
      session.needsResume = true;
      const turnId = session.activeTurnId;
      if (!turnId) continue;
      session.activeTurnId = undefined;
      this.emit({
        type: "turn_failed",
        sessionId: session.localSessionId,
        turnId,
        message: `Codex App Server disconnected: ${error.message}`,
      });
    }
    for (const [requestId, pending] of this.approvals) {
      this.approvals.delete(requestId);
      pending.resolve({ decision: "cancel" });
    }
  }
}

interface ThreadResponse {
  thread: { id: string; name?: string | null; preview?: string };
  model?: string;
  reasoningEffort?: string | null;
}

interface ThreadReadResponse {
  thread: { id: string; name?: string | null; preview?: string };
}

function permissionParams(mode: PermissionMode): { approvalPolicy: "never" | "on-request"; sandbox: string } {
  return mode === "auto"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

function threadLifecycleParams(cwd: string): {
  developerInstructions: string;
} {
  const projectless = detectProjectlessWorkspace(cwd);
  if (!projectless) return { developerInstructions: WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS };
  const projectlessInstructions = [
    "### Projectless Chat",
    "This projectless thread starts in a generated directory under the user's Documents/Codex folder.",
    "Prefer answering inline in chat unless using local files would make the result more useful.",
    `Use work/ for intermediate files, scratch analysis, scripts, drafts, and temporary assets. Use ${projectless.outputDirectory} only for user-facing deliverables that should appear as outputs.`,
    `When referring to saved deliverables in the final response, link only files from ${projectless.outputDirectory}.`,
    "Do not write directly in the home directory unless the user explicitly asks.",
  ].join("\n");
  return {
    developerInstructions: `${WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS}\n\n${projectlessInstructions}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
