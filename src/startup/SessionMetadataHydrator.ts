import type { AgentRuntimeRegistry } from "../runtime/AgentRuntimeRegistry.js";
import { StateStore, type SessionRecord } from "../state/StateStore.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";

export class SessionMetadataHydrator {
  constructor(
    private readonly store: StateStore,
    private readonly runtimes: AgentRuntimeRegistry,
  ) {}

  async hydrate(session: SessionRecord): Promise<SessionRecord> {
    if (
      session.runtimeKind === "codex"
      && session.remoteSessionId
      && session.lastTurnId
      && session.status === "running"
      && session.lastTurnStatus === "running"
    ) {
      const runtime = this.runtimes.get("codex");
      const loaded = runtime.getSession(session.localSessionId) ?? await runtime.resumeSession({
        localSessionId: session.localSessionId,
        remoteSessionId: session.remoteSessionId,
        activeTurnId: session.lastTurnId,
        lastTurnId: session.lastTurnId,
        lastTurnStatus: session.lastTurnStatus,
        agentName: session.agentName,
        cwd: session.cwd,
        title: session.title,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        permissionMode: session.permissionMode ?? "auto",
      });
      const synchronized = await runtime.synchronizeSession(loaded.localSessionId);
      if (synchronized.title) {
        this.store.updateRuntimeSession(session.localSessionId, { title: synchronized.title });
      }
      return this.store.getSession(session.localSessionId) ?? session;
    }
    if (session.title || !session.runtimeKind || !session.remoteSessionId) return session;
    if (session.runtimeKind === "codex" && !session.lastTurnId) return session;
    const metadata = await this.runtimes.get(session.runtimeKind).readSessionMetadata(session.remoteSessionId);
    const title = normalizeTaskTitle(metadata.title);
    if (title) this.store.updateRuntimeSession(session.localSessionId, { title });
    return this.store.getSession(session.localSessionId) ?? session;
  }
}
