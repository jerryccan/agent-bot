import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";

export type SessionStatus = "starting" | "ready" | "running" | "closed" | "failed";

export interface UserContextRecord {
  contextKey: string;
  defaultAgent: string;
  currentSessionId?: string;
  previousSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  localSessionId: string;
  contextKey: string;
  agentName: string;
  cwd: string;
  acpSessionId?: string;
  runtimeKind?: "acp" | "codex";
  remoteSessionId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: "auto" | "confirm";
  lastTurnId?: string;
  lastTurnStatus?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export type MessageReactionStatus = "pending" | "updating" | "completed" | "failed" | "cancelled";

export interface MessageReactionRecord {
  messageId: string;
  contextKey: string;
  reactionId: string;
  emojiType: string;
  localSessionId?: string;
  turnId?: string;
  status: MessageReactionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TurnAnchorRecord {
  turnId: string;
  localSessionId: string;
}

interface UserContextRow {
  context_key: string;
  default_agent: string;
  current_session_id: string | null;
  previous_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  local_session_id: string;
  context_key: string;
  agent_name: string;
  cwd: string;
  acp_session_id: string | null;
  runtime_kind: "acp" | "codex" | null;
  remote_session_id: string | null;
  title: string | null;
  model: string | null;
  reasoning_effort: string | null;
  permission_mode: "auto" | "confirm" | null;
  last_turn_id: string | null;
  last_turn_status: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

interface MessageReactionRow {
  message_id: string;
  context_key: string;
  reaction_id: string;
  emoji_type: string;
  local_session_id: string | null;
  turn_id: string | null;
  status: MessageReactionStatus;
  created_at: string;
  updated_at: string;
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(sqlitePath: string) {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new Database(sqlitePath);
    this.db.pragma("journal_mode = WAL");
    for (const migration of migrations) {
      this.db.exec(migration);
    }
    this.db.exec("UPDATE message_reactions SET status = 'pending' WHERE status = 'updating'");
    this.ensureUserContextColumns();
    this.ensureSessionColumns();
  }

  close(): void {
    this.db.close();
  }

  getOrCreateUserContext(contextKey: string, defaultAgent: string): UserContextRecord {
    const existing = this.db
      .prepare("SELECT * FROM user_contexts WHERE context_key = ?")
      .get(contextKey) as UserContextRow | undefined;

    if (existing) {
      return mapUserContext(existing);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO user_contexts (context_key, default_agent, current_session_id, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?)
        `,
      )
      .run(contextKey, defaultAgent, now, now);

    return {
      contextKey,
      defaultAgent,
      createdAt: now,
      updatedAt: now,
    };
  }

  getUserContext(contextKey: string): UserContextRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM user_contexts WHERE context_key = ?")
      .get(contextKey) as UserContextRow | undefined;
    return row ? mapUserContext(row) : undefined;
  }

  listUserContexts(): UserContextRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM user_contexts ORDER BY created_at ASC")
      .all() as UserContextRow[];
    return rows.map(mapUserContext);
  }

  nextForkTitle(sourceTitle?: string): string {
    const baseTitle = forkBaseTitle(sourceTitle);
    const allocate = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT last_sequence FROM fork_title_sequences WHERE base_title = ?")
        .get(baseTitle) as { last_sequence: number } | undefined;
      const nextSequence = (existing?.last_sequence ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO fork_title_sequences (base_title, last_sequence)
        VALUES (?, ?)
        ON CONFLICT(base_title) DO UPDATE SET last_sequence = excluded.last_sequence
      `).run(baseTitle, nextSequence);
      return nextSequence;
    });
    return formatForkTitle(baseTitle, allocate());
  }

  reconcileInterruptedAcpSessions(acpAgentNames: string[]): SessionRecord[] {
    const agentClause = acpAgentNames.length
      ? ` OR (runtime_kind IS NULL AND agent_name IN (${acpAgentNames.map(() => "?").join(", ")}))`
      : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status = 'running' AND (runtime_kind = 'acp'${agentClause})`)
      .all(...acpAgentNames) as SessionRow[];
    if (rows.length === 0) return [];

    const now = new Date().toISOString();
    const completedAt = Date.now();
    const reconcile = this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare(`
          UPDATE sessions
          SET status = 'failed',
              last_turn_status = CASE WHEN last_turn_id IS NULL THEN last_turn_status ELSE 'failed' END,
              updated_at = ?
          WHERE local_session_id = ?
        `).run(now, row.local_session_id);

        if (!row.last_turn_id) continue;
        const snapshotRow = this.db
          .prepare("SELECT snapshot_json FROM turn_snapshots WHERE turn_id = ?")
          .get(row.last_turn_id) as { snapshot_json: string } | undefined;
        if (!snapshotRow) continue;
        try {
          const snapshot = JSON.parse(snapshotRow.snapshot_json) as Record<string, unknown>;
          if (!["starting", "running", "tool_running", "waiting_for_approval"].includes(String(snapshot.status))) continue;
          const startedAt = typeof snapshot.startedAt === "number" ? snapshot.startedAt : undefined;
          const failedSnapshot: Record<string, unknown> = {
            ...snapshot,
            status: "failed",
            completedAt,
            ...(startedAt === undefined ? {} : { durationMs: Math.max(0, completedAt - startedAt) }),
            error: "acp-bot 已重启，原 ACP 进程中的执行无法继续。",
          };
          delete failedSnapshot.activeTool;
          delete failedSnapshot.approval;
          this.db.prepare(`
            UPDATE turn_snapshots SET snapshot_json = ?, updated_at = ? WHERE turn_id = ?
          `).run(JSON.stringify(failedSnapshot), now, row.last_turn_id);
        } catch {
          // Keep an unreadable historical snapshot intact while still correcting the session state.
        }
      }
    });
    reconcile();
    return rows.map(mapSession);
  }

  setDefaultAgent(contextKey: string, agentName: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE user_contexts SET default_agent = ?, updated_at = ? WHERE context_key = ?")
      .run(agentName, now, contextKey);
  }

  setCurrentSession(contextKey: string, localSessionId?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE user_contexts
        SET previous_session_id = CASE
              WHEN current_session_id IS NOT ? THEN current_session_id
              ELSE previous_session_id
            END,
            current_session_id = ?,
            updated_at = ?
        WHERE context_key = ?
      `)
      .run(localSessionId ?? null, localSessionId ?? null, now, contextKey);
  }

  createSession(input: {
    localSessionId: string;
    contextKey: string;
    agentName: string;
    cwd: string;
    status: SessionStatus;
  }): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO sessions (
          local_session_id,
          context_key,
          agent_name,
          cwd,
          acp_session_id,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
        `,
      )
      .run(
        input.localSessionId,
        input.contextKey,
        input.agentName,
        input.cwd,
        input.status,
        now,
        now,
      );

    return {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateSession(
    localSessionId: string,
    patch: Partial<Pick<SessionRecord, "acpSessionId" | "status">>,
  ): void {
    const existing = this.getSession(localSessionId);
    if (!existing) {
      return;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        UPDATE sessions
        SET acp_session_id = ?, status = ?, updated_at = ?
        WHERE local_session_id = ?
        `,
      )
      .run(
        patch.acpSessionId ?? existing.acpSessionId ?? null,
        patch.status ?? existing.status,
        now,
        localSessionId,
      );
  }

  updateRuntimeSession(
    localSessionId: string,
    patch: Partial<
      Pick<
        SessionRecord,
        "runtimeKind" | "remoteSessionId" | "title" | "model" | "reasoningEffort" | "permissionMode" | "lastTurnId" | "lastTurnStatus"
      >
    >,
  ): void {
    const existing = this.getSession(localSessionId);
    if (!existing) {
      return;
    }

    this.db
      .prepare(
        `
        UPDATE sessions
        SET runtime_kind = ?, remote_session_id = ?, title = ?, model = ?, reasoning_effort = ?, permission_mode = ?,
            last_turn_id = ?, last_turn_status = ?, updated_at = ?
        WHERE local_session_id = ?
        `,
      )
      .run(
        patch.runtimeKind ?? existing.runtimeKind ?? null,
        patch.remoteSessionId ?? existing.remoteSessionId ?? existing.acpSessionId ?? null,
        patch.title ?? existing.title ?? null,
        patch.model ?? existing.model ?? null,
        patch.reasoningEffort ?? existing.reasoningEffort ?? null,
        patch.permissionMode ?? existing.permissionMode ?? null,
        patch.lastTurnId ?? existing.lastTurnId ?? null,
        patch.lastTurnStatus ?? existing.lastTurnStatus ?? null,
        new Date().toISOString(),
        localSessionId,
      );
  }

  saveTurnSnapshot(turnId: string, localSessionId: string, snapshot: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO turn_snapshots (turn_id, local_session_id, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          local_session_id = excluded.local_session_id,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(turnId, localSessionId, JSON.stringify(snapshot), now);
  }

  getTurnSnapshot(turnId: string): unknown {
    const row = this.db
      .prepare("SELECT snapshot_json FROM turn_snapshots WHERE turn_id = ?")
      .get(turnId) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) : undefined;
  }

  saveTurnDelivery(
    turnId: string,
    patch: { progressMessageId?: string; lastCardHash?: string },
  ): void {
    const existing = this.getTurnDelivery(turnId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO turn_deliveries (
          turn_id, progress_message_id, final_message_ids_json, final_delivered_at, last_card_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          progress_message_id = excluded.progress_message_id,
          last_card_hash = excluded.last_card_hash,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        turnId,
        patch.progressMessageId ?? existing?.progressMessageId ?? null,
        JSON.stringify(existing?.finalMessageIds ?? []),
        existing?.finalDeliveredAt ?? null,
        patch.lastCardHash ?? existing?.lastCardHash ?? null,
        now,
      );
  }

  markFinalDelivered(turnId: string, messageIds: string[]): void {
    const now = new Date().toISOString();
    const existing = this.getTurnDelivery(turnId);
    this.db
      .prepare(
        `
        INSERT INTO turn_deliveries (
          turn_id, progress_message_id, final_message_ids_json, final_delivered_at, last_card_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          final_message_ids_json = excluded.final_message_ids_json,
          final_delivered_at = excluded.final_delivered_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        turnId,
        existing?.progressMessageId ?? null,
        JSON.stringify(messageIds),
        now,
        existing?.lastCardHash ?? null,
        now,
      );
  }

  saveFinalDeliveryProgress(turnId: string, messageIds: string[]): void {
    const now = new Date().toISOString();
    const existing = this.getTurnDelivery(turnId);
    this.db
      .prepare(
        `
        INSERT INTO turn_deliveries (
          turn_id, progress_message_id, final_message_ids_json, final_delivered_at, last_card_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          final_message_ids_json = excluded.final_message_ids_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        turnId,
        existing?.progressMessageId ?? null,
        JSON.stringify(messageIds),
        existing?.finalDeliveredAt ?? null,
        existing?.lastCardHash ?? null,
        now,
      );
  }

  getTurnDelivery(turnId: string):
    | {
        progressMessageId?: string;
        finalMessageIds: string[];
        finalDelivered: boolean;
        finalDeliveredAt?: string;
        lastCardHash?: string;
      }
    | undefined {
    const row = this.db
      .prepare("SELECT * FROM turn_deliveries WHERE turn_id = ?")
      .get(turnId) as
      | {
          progress_message_id: string | null;
          final_message_ids_json: string;
          final_delivered_at: string | null;
          last_card_hash: string | null;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      progressMessageId: row.progress_message_id ?? undefined,
      finalMessageIds: JSON.parse(row.final_message_ids_json) as string[],
      finalDelivered: Boolean(row.final_delivered_at),
      finalDeliveredAt: row.final_delivered_at ?? undefined,
      lastCardHash: row.last_card_hash ?? undefined,
    };
  }

  getSession(localSessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE local_session_id = ?")
      .get(localSessionId) as SessionRow | undefined;

    return row ? mapSession(row) : undefined;
  }

  listSessions(contextKey: string): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE context_key = ? ORDER BY created_at DESC")
      .all(contextKey) as SessionRow[];

    return rows.map(mapSession);
  }

  findSessionByRemoteSessionId(remoteSessionId: string, contextKey?: string): SessionRecord | undefined {
    const row = contextKey
      ? this.db
          .prepare(`
            SELECT * FROM sessions
            WHERE remote_session_id = ? AND context_key = ? AND status != 'closed'
            ORDER BY created_at ASC LIMIT 1
          `)
          .get(remoteSessionId, contextKey) as SessionRow | undefined
      : this.db
          .prepare(`
            SELECT * FROM sessions
            WHERE remote_session_id = ? AND status != 'closed'
            ORDER BY created_at ASC LIMIT 1
          `)
          .get(remoteSessionId) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  audit(contextKey: string, eventType: string, payload: unknown): void {
    this.db
      .prepare(
        `
        INSERT INTO audit_events (context_key, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
        `,
      )
      .run(contextKey, eventType, JSON.stringify(payload), new Date().toISOString());
  }

  claimInboundEvent(eventId: string, eventKind: "message" | "card_action"): boolean {
    const result = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO inbound_event_receipts (event_id, event_kind, created_at)
        VALUES (?, ?, ?)
        `,
      )
      .run(eventId, eventKind, new Date().toISOString());
    return result.changes === 1;
  }

  saveMessageReaction(messageId: string, contextKey: string, reactionId: string, emojiType: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO message_reactions (
        message_id, context_key, reaction_id, emoji_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        context_key = excluded.context_key,
        reaction_id = excluded.reaction_id,
        emoji_type = excluded.emoji_type,
        status = 'pending',
        updated_at = excluded.updated_at
    `).run(messageId, contextKey, reactionId, emojiType, now, now);
  }

  bindMessageReaction(messageId: string, localSessionId: string, turnId: string): void {
    this.db.prepare(`
      UPDATE message_reactions
      SET local_session_id = ?, turn_id = ?, updated_at = ?
      WHERE message_id = ? AND status = 'pending'
    `).run(localSessionId, turnId, new Date().toISOString(), messageId);
  }

  bindMessageToTurn(messageId: string, localSessionId: string, turnId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO message_turn_bindings (message_id, local_session_id, turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        local_session_id = excluded.local_session_id,
        turn_id = excluded.turn_id,
        updated_at = excluded.updated_at
    `).run(messageId, localSessionId, turnId, now, now);
  }

  claimMessageReactionsForTurn(turnId: string): MessageReactionRecord[] {
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM message_reactions WHERE turn_id = ? AND status = 'pending' ORDER BY created_at ASC
      `).all(turnId) as MessageReactionRow[];
      if (rows.length > 0) {
        this.db.prepare(`
          UPDATE message_reactions SET status = 'updating', updated_at = ?
          WHERE turn_id = ? AND status = 'pending'
        `).run(new Date().toISOString(), turnId);
      }
      return rows.map((row) => ({ ...mapMessageReaction(row), status: "updating" as const }));
    });
    return claim();
  }

  claimMessageReaction(messageId: string): MessageReactionRecord | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM message_reactions WHERE message_id = ? AND status = 'pending'
      `).get(messageId) as MessageReactionRow | undefined;
      if (!row) return undefined;
      this.db.prepare(`
        UPDATE message_reactions SET status = 'updating', updated_at = ? WHERE message_id = ? AND status = 'pending'
      `).run(new Date().toISOString(), messageId);
      return { ...mapMessageReaction(row), status: "updating" as const };
    });
    return claim();
  }

  listPendingMessageReactions(): MessageReactionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM message_reactions WHERE status = 'pending' AND turn_id IS NOT NULL ORDER BY created_at ASC
    `).all() as MessageReactionRow[];
    return rows.map(mapMessageReaction);
  }

  finishMessageReaction(
    messageId: string,
    reactionId: string,
    emojiType: string,
    status: Exclude<MessageReactionStatus, "pending" | "updating">,
  ): void {
    this.db.prepare(`
      UPDATE message_reactions
      SET reaction_id = ?, emoji_type = ?, status = ?, updated_at = ?
      WHERE message_id = ?
    `).run(reactionId, emojiType, status, new Date().toISOString(), messageId);
  }

  releaseMessageReaction(messageId: string): void {
    this.db.prepare(`
      UPDATE message_reactions SET status = 'pending', updated_at = ?
      WHERE message_id = ? AND status = 'updating'
    `).run(new Date().toISOString(), messageId);
  }

  getMessageReaction(messageId: string): MessageReactionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM message_reactions WHERE message_id = ?")
      .get(messageId) as MessageReactionRow | undefined;
    return row ? mapMessageReaction(row) : undefined;
  }

  findTurnAnchorByMessageId(messageId: string): TurnAnchorRecord | undefined {
    const binding = this.db.prepare(`
      SELECT turn_id, local_session_id
      FROM message_turn_bindings
      WHERE message_id = ?
      LIMIT 1
    `).get(messageId) as { turn_id: string; local_session_id: string } | undefined;
    if (binding) {
      return { turnId: binding.turn_id, localSessionId: binding.local_session_id };
    }

    const reaction = this.db.prepare(`
      SELECT turn_id, local_session_id
      FROM message_reactions
      WHERE message_id = ? AND turn_id IS NOT NULL AND local_session_id IS NOT NULL
      LIMIT 1
    `).get(messageId) as { turn_id: string; local_session_id: string } | undefined;
    if (reaction) {
      return { turnId: reaction.turn_id, localSessionId: reaction.local_session_id };
    }

    const delivery = this.db.prepare(`
      SELECT deliveries.turn_id, snapshots.local_session_id
      FROM turn_deliveries AS deliveries
      JOIN turn_snapshots AS snapshots ON snapshots.turn_id = deliveries.turn_id
      WHERE deliveries.progress_message_id = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(deliveries.final_message_ids_json)
           WHERE json_each.value = ?
         )
      ORDER BY deliveries.updated_at DESC
      LIMIT 1
    `).get(messageId, messageId) as { turn_id: string; local_session_id: string } | undefined;
    return delivery
      ? { turnId: delivery.turn_id, localSessionId: delivery.local_session_id }
      : undefined;
  }

  private ensureSessionColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(sessions)") as Array<{ name: string }>).map((column) => column.name),
    );
    const columns: Array<[string, string]> = [
      ["runtime_kind", "TEXT"],
      ["remote_session_id", "TEXT"],
      ["title", "TEXT"],
      ["model", "TEXT"],
      ["reasoning_effort", "TEXT"],
      ["permission_mode", "TEXT"],
      ["last_turn_id", "TEXT"],
      ["last_turn_status", "TEXT"],
    ];
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private ensureUserContextColumns(): void {
    const existing = new Set(
      (this.db.pragma("table_info(user_contexts)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!existing.has("previous_session_id")) {
      this.db.exec("ALTER TABLE user_contexts ADD COLUMN previous_session_id TEXT");
    }
  }
}

const MAX_TASK_TITLE_LENGTH = 120;
const FORK_TITLE_SUFFIX = /\s*（分支\s+(\d+)）$/u;

function forkBaseTitle(sourceTitle?: string): string {
  let title = sourceTitle?.replace(/\s+/g, " ").trim() || "未命名任务";
  while (FORK_TITLE_SUFFIX.test(title)) title = title.replace(FORK_TITLE_SUFFIX, "").trim();
  return title || "未命名任务";
}

function formatForkTitle(baseTitle: string, sequence: number): string {
  const suffix = `（分支 ${sequence}）`;
  const available = Math.max(1, MAX_TASK_TITLE_LENGTH - suffix.length);
  const truncatedBase = baseTitle.length <= available ? baseTitle : baseTitle.slice(0, available).trimEnd();
  return `${truncatedBase}${suffix}`;
}

function mapUserContext(row: UserContextRow): UserContextRecord {
  return {
    contextKey: row.context_key,
    defaultAgent: row.default_agent,
    currentSessionId: row.current_session_id ?? undefined,
    previousSessionId: row.previous_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    localSessionId: row.local_session_id,
    contextKey: row.context_key,
    agentName: row.agent_name,
    cwd: row.cwd,
    acpSessionId: row.acp_session_id ?? undefined,
    runtimeKind: row.runtime_kind ?? (row.acp_session_id ? "acp" : undefined),
    remoteSessionId: row.remote_session_id ?? row.acp_session_id ?? undefined,
    title: row.title ?? undefined,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    permissionMode: row.permission_mode ?? undefined,
    lastTurnId: row.last_turn_id ?? undefined,
    lastTurnStatus: row.last_turn_status ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessageReaction(row: MessageReactionRow): MessageReactionRecord {
  return {
    messageId: row.message_id,
    contextKey: row.context_key,
    reactionId: row.reaction_id,
    emojiType: row.emoji_type,
    localSessionId: row.local_session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
