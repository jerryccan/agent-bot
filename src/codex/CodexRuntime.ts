import type { Logger } from "pino";
import type {
  AgentRuntime,
  ApprovalDecision,
  CreateRuntimeSessionInput,
  ForkRuntimeSessionInput,
  ModelOption,
  PermissionMode,
  RemoteSessionActivity,
  RemoteSessionPage,
  RemoteSessionSummary,
  ResumeRuntimeSessionInput,
  RuntimeGoal,
  RuntimeGoalUpdate,
  RuntimeEvent,
  RuntimePrompt,
  RuntimeSession,
  RuntimeSessionMetadata,
} from "../runtime/types.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";
import { mapCodexNotification } from "./CodexEventMapper.js";
import { CodexLocalActivityDetector } from "./CodexLocalActivityDetector.js";
import { detectProjectlessWorkspace } from "./ProjectlessWorkspace.js";

const WINDOWS_SCREENSHOT_DEVELOPER_INSTRUCTIONS = [
  "When capturing any screenshot on Windows, use one fresh process and make it Per-Monitor DPI Aware V2 before loading System.Windows.Forms, System.Drawing, or UI Automation, and before calling any screen, window, or bounds API.",
  "Call user32!SetProcessDpiAwarenessContext((IntPtr)-4) in that same process and verify that it succeeded or that the process is already PMv2 before continuing.",
  "For a full monitor or desktop, query the physical monitor or virtual-desktop bounds only after PMv2 is active.",
  "For a specific window, obtain its HWND after PMv2 is active and use DwmGetWindowAttribute with DWMWA_EXTENDED_FRAME_BOUNDS (9) for the physical visible window bounds; use GetWindowRect only as a fallback after PMv2 is active.",
  "Never crop a window with DPI-virtualized coordinates from an unaware process or with UI Automation BoundingRectangle coordinates.",
  "Call Graphics.CopyFromScreen with those physical coordinates and validate that the saved bitmap dimensions exactly equal the selected physical capture bounds.",
].join(" ");

const SESSION_REQUEST_TIMEOUT_MS = 30_000;
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const SYNC_REQUEST_TIMEOUT_MS = 5_000;
// A timed-out fork keeps running in App Server and can create an orphan thread.
// Wait for its response; connection closure still rejects the request.
const FORK_REQUEST_TIMEOUT_MS = 0;

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
  getCodexHome?(): string;
  onDisconnect?(listener: (error: Error) => void): () => void;
  close(): void;
}

interface CodexSession extends RuntimeSession {
  activeTurnStartedAt?: number;
  terminalTurnIds: Set<string>;
  finalText: string;
  messagePhases: Map<string, "commentary" | "final_answer">;
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
  private readonly sessionSyncs = new Map<string, Promise<RuntimeSession>>();
  private readonly localActivityDetector?: CodexLocalActivityDetector;

  constructor(
    private readonly provider: AppServerClientProvider,
    private readonly logger: Logger,
  ) {
    const codexHome = provider.getCodexHome?.();
    if (codexHome) this.localActivityDetector = new CodexLocalActivityDetector(codexHome);
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
    }, SESSION_REQUEST_TIMEOUT_MS);
    const requestedTitle = normalizeTaskTitle(input.title);
    if (requestedTitle) {
      await client.request("thread/name/set", {
        threadId: response.thread.id,
        name: requestedTitle,
      }, SESSION_REQUEST_TIMEOUT_MS);
    }
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    if (requestedTitle) session.title = requestedTitle;
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
    }, SESSION_REQUEST_TIMEOUT_MS);
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<RuntimeSession> {
    const client = await this.client();
    const response = await client.request<ThreadResponse>("thread/fork", {
      threadId: input.remoteSessionId,
      lastTurnId: input.lastTurnId,
      cwd: input.cwd,
      model: input.model,
      threadSource: "user",
      ...threadLifecycleParams(input.cwd),
      ...permissionParams(input.permissionMode),
    }, FORK_REQUEST_TIMEOUT_MS);
    const requestedTitle = normalizeTaskTitle(input.title);
    if (requestedTitle) {
      await client.request("thread/name/set", {
        threadId: response.thread.id,
        name: requestedTitle,
      }, SESSION_REQUEST_TIMEOUT_MS);
    }
    const reasoningEffort = await this.resolveReasoningEffort(input, response);
    const session = this.makeSession(input, response, reasoningEffort);
    if (requestedTitle) session.title = requestedTitle;
    this.sessions.set(input.localSessionId, session);
    return session;
  }

  async startTurn(sessionId: string, prompt: RuntimePrompt): Promise<string> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    const response = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId: session.remoteSessionId,
      input: codexUserInput(prompt),
      cwd: session.cwd,
      model: session.model,
      effort: session.reasoningEffort,
      summary: "auto",
      approvalPolicy: session.permissionMode === "auto" ? "never" : "on-request",
    }, SESSION_REQUEST_TIMEOUT_MS);
    if (session.activeTurnId !== response.turn.id) {
      this.adoptTurn(session, response.turn.id, Date.now());
    }
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

  async listRemoteSessions(input: {
    searchTerm?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<RemoteSessionPage> {
    const client = await this.client();
    const response = await client.request<ThreadListResponse>(
      "thread/list",
      {
        cursor: input.cursor,
        limit: input.limit ?? 20,
        sortKey: "recency_at",
        sortDirection: "desc",
        archived: false,
        searchTerm: input.searchTerm,
      },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    const sessions = await Promise.all(response.data.map(async (thread) => {
      const listed = remoteSessionSummary(thread);
      if (listed.status === "active" || listed.lastTurnStatus === "inProgress") return listed;
      try {
        const detail = await client.request<ThreadReadResponse>(
          "thread/read",
          { threadId: thread.id, includeTurns: true },
          SYNC_REQUEST_TIMEOUT_MS,
        );
        return mergeRemoteSessionSummary(listed, remoteSessionSummary(detail.thread));
      } catch {
        return listed;
      }
    }));
    const activeThreads = await this.localActivityDetector?.activeThreads(sessions.map((session) => session.id));
    return {
      sessions: activeThreads
        ? sessions.map((session) => markLocallyDetectedActive(session, activeThreads))
        : sessions,
      nextCursor: response.nextCursor ?? undefined,
    };
  }

  async readRemoteSession(remoteSessionId: string): Promise<RemoteSessionSummary> {
    const response = await (await this.client()).request<ThreadReadResponse>(
      "thread/read",
      { threadId: remoteSessionId, includeTurns: true },
      SYNC_REQUEST_TIMEOUT_MS,
    );
    const summary = remoteSessionSummary(response.thread);
    const activeThreads = await this.localActivityDetector?.activeThreads([remoteSessionId]);
    const activeSummary = activeThreads ? markLocallyDetectedActive(summary, activeThreads) : summary;
    const settings = await this.localActivityDetector?.threadSettings([remoteSessionId]);
    return {
      ...activeSummary,
      ...settings?.get(remoteSessionId),
    };
  }

  async inspectRemoteSessionActivity(remoteSessionId: string): Promise<RemoteSessionActivity> {
    const [response, activeThreads] = await Promise.all([
      (await this.client()).request<ThreadReadResponse>(
        "thread/read",
        { threadId: remoteSessionId, includeTurns: false },
        SYNC_REQUEST_TIMEOUT_MS,
      ),
      this.localActivityDetector?.activeThreads([remoteSessionId]),
    ]);
    const runtimeSession = [...this.sessions.values()]
      .find((session) => session.remoteSessionId === remoteSessionId);
    const detectedTurnId = activeThreads?.get(remoteSessionId);
    const active = remoteThreadStatus(response.thread.status?.type) === "active"
      || Boolean(runtimeSession?.activeTurnId)
      || Boolean(activeThreads?.has(remoteSessionId));
    const activeTurnId = detectedTurnId ?? runtimeSession?.activeTurnId;
    return {
      active,
      ...(activeTurnId ? { activeTurnId } : {}),
    };
  }

  async synchronizeSession(sessionId: string): Promise<RuntimeSession> {
    const existing = this.sessionSyncs.get(sessionId);
    if (existing) return existing;
    const synchronization = this.synchronizeSessionNow(sessionId);
    this.sessionSyncs.set(sessionId, synchronization);
    try {
      return await synchronization;
    } finally {
      if (this.sessionSyncs.get(sessionId) === synchronization) this.sessionSyncs.delete(sessionId);
    }
  }

  async steerTurn(sessionId: string, turnId: string, prompt: RuntimePrompt): Promise<void> {
    const session = this.requireActiveTurn(sessionId, turnId);
    await (await this.client()).request("turn/steer", {
      threadId: session.remoteSessionId,
      expectedTurnId: turnId,
      input: codexUserInput(prompt),
    }, CONTROL_REQUEST_TIMEOUT_MS);
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    const session = this.requireActiveTurn(sessionId, turnId);
    await this.interruptRemoteTurn(session.remoteSessionId, turnId, sessionId);
  }

  async interruptRemoteTurn(remoteSessionId: string, turnId: string, sessionId?: string): Promise<void> {
    await (await this.client()).request(
      "turn/interrupt",
      { threadId: remoteSessionId, turnId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    this.logger.info(
      { ...(sessionId ? { sessionId } : {}), threadId: remoteSessionId, turnId },
      "Codex accepted the turn interrupt request.",
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await (await this.client()).request(
      "thread/archive",
      { threadId: session.remoteSessionId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    this.sessions.delete(sessionId);
  }

  async setTitle(sessionId: string, title: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) throw new Error("任务标题不能为空。");
    await (await this.client()).request(
      "thread/name/set",
      { threadId: session.remoteSessionId, name: normalizedTitle },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    session.title = normalizedTitle;
  }

  async getGoal(sessionId: string): Promise<RuntimeGoal | undefined> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    const response = await client.request<{ goal?: RuntimeGoal | null }>(
      "thread/goal/get",
      { threadId: session.remoteSessionId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return response.goal ?? undefined;
  }

  async setGoal(sessionId: string, update: RuntimeGoalUpdate): Promise<RuntimeGoal> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    const response = await client.request<{ goal: RuntimeGoal }>(
      "thread/goal/set",
      { threadId: session.remoteSessionId, ...update },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return response.goal;
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    const client = await this.client();
    await this.ensureSessionResumed(session, client);
    const response = await client.request<{ cleared: boolean }>(
      "thread/goal/clear",
      { threadId: session.remoteSessionId },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    return response.cleared;
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
    this.sessionSyncs.clear();
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
    if (method === "thread/status/changed" && isRecord(params)) {
      const threadId = stringValue(params.threadId);
      const status = isRecord(params.status) ? stringValue(params.status.type) : undefined;
      const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === threadId);
      if (session?.activeTurnId && status && status !== "active") {
        void this.synchronizeSession(session.localSessionId).catch((error: unknown) => {
          this.logger.warn({ error, sessionId: session.localSessionId, status }, "Failed to reconcile Codex thread status.");
        });
      }
      return;
    }
    const mapped = mapCodexNotification(method, params);
    if (!mapped) return;
    const session = [...this.sessions.values()].find((candidate) => candidate.remoteSessionId === mapped.threadId);
    if (!session) return;
    if (session.terminalTurnIds.has(mapped.turnId)) {
      this.logger.debug(
        { sessionId: session.localSessionId, turnId: mapped.turnId, method },
        "Ignoring a replayed terminal Codex turn event.",
      );
      return;
    }
    if (mapped.kind === "turn_started") {
      if (session.activeTurnId === mapped.turnId) return;
      if (
        session.activeTurnId
        && session.activeTurnStartedAt !== undefined
        && mapped.startedAt !== undefined
        && mapped.startedAt < session.activeTurnStartedAt
      ) {
        this.logger.debug(
          {
            sessionId: session.localSessionId,
            activeTurnId: session.activeTurnId,
            activeTurnStartedAt: session.activeTurnStartedAt,
            notificationTurnId: mapped.turnId,
            notificationStartedAt: mapped.startedAt,
          },
          "Ignoring a replayed historical Codex turn start.",
        );
        return;
      }
      if (session.activeTurnId) this.supersedeTurn(session, session.activeTurnId);
      this.adoptTurn(session, mapped.turnId, mapped.startedAt ?? Date.now());
      return;
    }
    if (!session.activeTurnId || session.activeTurnId !== mapped.turnId) {
      this.logger.debug(
        { sessionId: session.localSessionId, activeTurnId: session.activeTurnId, notificationTurnId: mapped.turnId, method },
        "Ignoring out-of-order Codex notification and scheduling reconciliation.",
      );
      void this.synchronizeSession(session.localSessionId).catch((error: unknown) => {
        this.logger.warn({ error, sessionId: session.localSessionId }, "Failed to reconcile out-of-order Codex notification.");
      });
      return;
    }
    const sessionId = session.localSessionId;
    if (mapped.kind === "token_usage") {
      this.emit({
        type: "token_usage_updated",
        sessionId,
        turnId: mapped.turnId,
        lastTokens: mapped.lastTokens,
        cumulativeTokens: mapped.cumulativeTokens,
      });
    } else if (mapped.kind === "agent_message_phase") {
      session.messagePhases.set(mapped.itemId, mapped.phase);
    } else if (mapped.kind === "agent_delta") {
      if (session.messagePhases.get(mapped.itemId) === "commentary") {
        this.emit({
          type: "progress",
          sessionId,
          turnId: mapped.turnId,
          activityId: `commentary:${mapped.itemId}`,
          text: mapped.text,
          append: true,
        });
      } else {
        session.finalText += mapped.text;
        this.emit({ type: "agent_text_delta", sessionId, turnId: mapped.turnId, text: mapped.text });
      }
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
    } else if (mapped.kind === "tool_output_delta") {
      this.emit({
        type: "tool_output_delta",
        sessionId,
        turnId: mapped.turnId,
        toolId: mapped.toolId,
        delta: mapped.delta,
      });
    } else if (mapped.kind === "terminal") {
      session.activeTurnId = undefined;
      session.activeTurnStartedAt = undefined;
      session.terminalTurnIds.add(mapped.turnId);
      session.messagePhases.clear();
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

  private async ensureSessionResumed(session: CodexSession, client: AppServerClient): Promise<void> {
    if (!session.needsResume) return;
    await client.request("thread/resume", {
      threadId: session.remoteSessionId,
      cwd: session.cwd,
      model: session.model,
      ...threadLifecycleParams(session.cwd),
      ...permissionParams(session.permissionMode),
    }, SESSION_REQUEST_TIMEOUT_MS);
    session.needsResume = false;
  }

  private async synchronizeSessionNow(sessionId: string): Promise<RuntimeSession> {
    const session = this.requireSession(sessionId);
    const response = await (await this.client()).request<ThreadReadResponse>(
      "thread/read",
      { threadId: session.remoteSessionId, includeTurns: true },
      SYNC_REQUEST_TIMEOUT_MS,
    );
    this.reconcileThreadSnapshot(session, response.thread);
    return session;
  }

  private reconcileThreadSnapshot(session: CodexSession, thread: ThreadReadResponse["thread"]): void {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const latest = turns.at(-1);
    const latestInProgress = [...turns].reverse().find((turn) => turn.status === "inProgress");
    const activeTurnId = session.activeTurnId;

    if (!activeTurnId) {
      if (latestInProgress) this.adoptTurn(session, latestInProgress.id, turnStartedAt(latestInProgress));
      return;
    }

    if (latestInProgress?.id === activeTurnId) return;
    if (latestInProgress) {
      this.supersedeTurn(session, activeTurnId);
      this.adoptTurn(session, latestInProgress.id, turnStartedAt(latestInProgress));
      return;
    }

    if (!latest) {
      if (thread.status?.type !== "active") {
        session.activeTurnId = undefined;
        session.activeTurnStartedAt = undefined;
        session.messagePhases.clear();
        this.emit({
          type: "turn_failed",
          sessionId: session.localSessionId,
          turnId: activeTurnId,
          message: "Codex no longer reports this execution in the thread history.",
        });
      }
      return;
    }

    if (latest.id !== activeTurnId) {
      this.supersedeTurn(session, activeTurnId);
      this.adoptTurn(session, latest.id, turnStartedAt(latest));
    }
    this.finishSnapshotTurn(session, latest);
  }

  private adoptTurn(session: CodexSession, turnId: string, startedAt: number): void {
    session.activeTurnId = turnId;
    session.activeTurnStartedAt = startedAt;
    session.finalText = "";
    session.messagePhases.clear();
    this.emit({ type: "turn_started", sessionId: session.localSessionId, turnId, startedAt });
  }

  private supersedeTurn(session: CodexSession, turnId: string): void {
    if (session.activeTurnId === turnId) {
      session.activeTurnId = undefined;
      session.activeTurnStartedAt = undefined;
    }
    session.terminalTurnIds.add(turnId);
    session.messagePhases.clear();
    this.emit({ type: "turn_cancelled", sessionId: session.localSessionId, turnId });
  }

  private finishSnapshotTurn(session: CodexSession, turn: CodexTurnSnapshot): void {
    if (session.activeTurnId !== turn.id) return;
    session.activeTurnId = undefined;
    session.activeTurnStartedAt = undefined;
    session.terminalTurnIds.add(turn.id);
    session.messagePhases.clear();
    if (turn.status === "interrupted") {
      this.emit({ type: "turn_cancelled", sessionId: session.localSessionId, turnId: turn.id });
      return;
    }
    if (turn.status === "failed") {
      this.emit({
        type: "turn_failed",
        sessionId: session.localSessionId,
        turnId: turn.id,
        message: turn.error?.message ?? "Codex turn failed.",
      });
      return;
    }
    const finalResponse = extractFinalResponse(turn) || session.finalText;
    session.finalText = finalResponse;
    this.emit({
      type: "turn_completed",
      sessionId: session.localSessionId,
      turnId: turn.id,
      finalResponse,
      durationMs: turn.durationMs ?? undefined,
    });
  }

  private makeSession(
    input: CreateRuntimeSessionInput | ResumeRuntimeSessionInput | ForkRuntimeSessionInput,
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
      activeTurnId: "activeTurnId" in input ? input.activeTurnId : undefined,
      activeTurnStartedAt: undefined,
      terminalTurnIds: new Set(
        "lastTurnStatus" in input
        && input.lastTurnId
        && input.lastTurnStatus
        && input.lastTurnStatus !== "running"
          ? [input.lastTurnId]
          : [],
      ),
      finalText: "",
      messagePhases: new Map(),
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
      session.activeTurnStartedAt = undefined;
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
  thread: CodexThreadSnapshot;
}

interface ThreadListResponse {
  data: CodexThreadSnapshot[];
  nextCursor?: string | null;
}

interface CodexThreadSnapshot {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  source?: unknown;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  status?: { type?: string };
  turns?: CodexTurnSnapshot[];
}

interface CodexTurnSnapshot {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items?: Array<{ type?: string; text?: string; phase?: string | null; status?: string }>;
  error?: { message?: string } | null;
  startedAt?: number | null;
  durationMs?: number | null;
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

function turnStartedAt(turn: CodexTurnSnapshot): number {
  return typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : Date.now();
}

function extractFinalResponse(turn: CodexTurnSnapshot): string {
  const messages = (turn.items ?? []).filter(
    (item) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim(),
  );
  const finalMessages = messages.filter((item) => item.phase === "final_answer");
  return (finalMessages.length ? finalMessages : messages.slice(-1))
    .map((item) => item.text!.trim())
    .join("\n\n");
}

function remoteSessionSummary(thread: CodexThreadSnapshot): RemoteSessionSummary {
  const lastTurn = thread.turns?.at(-1);
  const lastCompletedTurn = [...(thread.turns ?? [])]
    .reverse()
    .find((turn) => turn.status === "completed");
  const toolCounts = lastTurn ? summarizeTurnTools(lastTurn) : undefined;
  const status = remoteThreadStatus(thread.status?.type);
  // A persisted inProgress turn can outlive the CLI/Desktop app-server process
  // that owned it. Only the owning app-server's active thread status (or the
  // rollout activity detector applied below) is evidence that it is still live.
  const lastTurnStatus = lastTurn?.status === "inProgress" && status !== "active"
    ? undefined
    : lastTurn?.status;
  const lastText = [...(lastTurn?.items ?? [])]
    .reverse()
    .find((item) => typeof item.text === "string" && item.text.trim())?.text?.trim();
  return {
    id: thread.id,
    title: normalizeTaskTitle(thread.name) ?? normalizeTaskTitle(thread.preview),
    preview: normalizeTaskTitle(thread.preview),
    cwd: thread.cwd ?? "",
    source: codexSourceLabel(thread.source),
    status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt ?? undefined,
    lastTurnId: lastTurn?.id,
    lastCompletedTurnId: lastCompletedTurn?.id,
    lastTurnStatus,
    lastActivity: lastText,
    finalResponse: lastTurn && lastTurn.status !== "inProgress" ? extractFinalResponse(lastTurn) || undefined : undefined,
    lastError: lastTurn?.error?.message,
    lastTurnToolCount: toolCounts?.total,
    lastTurnCompletedToolCount: toolCounts?.completed,
    lastTurnFailedToolCount: toolCounts?.failed,
    lastTurnRunningToolCount: toolCounts?.running,
  };
}

function summarizeTurnTools(turn: CodexTurnSnapshot): {
  total: number;
  completed: number;
  failed: number;
  running: number;
} {
  const tools = (turn.items ?? []).filter((item) => isToolItemType(item.type));
  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const tool of tools) {
    if (tool.status === "failed" || tool.status === "declined") failed += 1;
    else if (tool.status === "inProgress" || tool.status === "running") running += 1;
    else completed += 1;
  }
  return { total: tools.length, completed, failed, running };
}

function isToolItemType(type: string | undefined): boolean {
  return type === "commandExecution"
    || type === "fileChange"
    || type === "mcpToolCall"
    || type === "dynamicToolCall"
    || type === "webSearch"
    || type === "imageView";
}

function mergeRemoteSessionSummary(
  listed: RemoteSessionSummary,
  inspected: RemoteSessionSummary,
): RemoteSessionSummary {
  return {
    ...listed,
    ...inspected,
    title: inspected.title ?? listed.title,
    preview: inspected.preview ?? listed.preview,
    cwd: inspected.cwd || listed.cwd,
    source: inspected.source === "unknown" ? listed.source : inspected.source,
    createdAt: inspected.createdAt ?? listed.createdAt,
    updatedAt: inspected.updatedAt ?? listed.updatedAt,
    recencyAt: inspected.recencyAt ?? listed.recencyAt,
    lastActivity: inspected.lastActivity ?? listed.lastActivity,
    finalResponse: inspected.finalResponse ?? listed.finalResponse,
    lastError: inspected.lastError ?? listed.lastError,
  };
}

function markLocallyDetectedActive(
  summary: RemoteSessionSummary,
  activeThreads: Map<string, string | undefined>,
): RemoteSessionSummary {
  if (!activeThreads.has(summary.id)) return summary;
  const detectedTurnId = activeThreads.get(summary.id);
  if ((summary.status === "active" || summary.lastTurnStatus === "inProgress")
    && (!detectedTurnId || summary.lastTurnId === detectedTurnId)) return summary;
  return {
    ...summary,
    status: "active",
    lastTurnId: detectedTurnId ?? summary.lastTurnId,
    lastTurnStatus: "inProgress",
    lastActivity: undefined,
    finalResponse: undefined,
  };
}

function codexUserInput(prompt: RuntimePrompt): Array<Record<string, unknown>> {
  const normalized = typeof prompt === "string" ? { text: prompt, localImagePaths: [] } : {
    text: prompt.text,
    localImagePaths: prompt.localImagePaths ?? [],
  };
  return [
    ...(normalized.text.trim() ? [{ type: "text", text: normalized.text, text_elements: [] }] : []),
    ...normalized.localImagePaths.map((imagePath) => ({ type: "localImage", path: imagePath })),
  ];
}

function remoteThreadStatus(value: string | undefined): RemoteSessionSummary["status"] {
  if (value === "active") return "active";
  if (value === "idle") return "idle";
  if (value === "systemError") return "error";
  return "not_loaded";
}

function codexSourceLabel(source: unknown): string {
  if (typeof source === "string") return source;
  if (isRecord(source)) {
    if (typeof source.custom === "string") return source.custom;
    if (source.subAgent !== undefined) return "subAgent";
  }
  return "unknown";
}
