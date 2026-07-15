import type { AgentRuntimeRegistry } from "../runtime/AgentRuntimeRegistry.js";
import { StateStore, type SessionRecord } from "../state/StateStore.js";
import { normalizeTaskTitle } from "../utils/taskTitle.js";

export class SessionMetadataHydrator {
  constructor(
    private readonly store: StateStore,
    private readonly runtimes: AgentRuntimeRegistry,
  ) {}

  async hydrate(session: SessionRecord): Promise<SessionRecord> {
    if (session.title || !session.runtimeKind || !session.remoteSessionId) return session;
    const metadata = await this.runtimes.get(session.runtimeKind).readSessionMetadata(session.remoteSessionId);
    const title = normalizeTaskTitle(metadata.title);
    if (title) this.store.updateRuntimeSession(session.localSessionId, { title });
    return this.store.getSession(session.localSessionId) ?? session;
  }
}
