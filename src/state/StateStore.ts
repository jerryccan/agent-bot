import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations.js";

export type SessionStatus = "starting" | "ready" | "running" | "closed" | "failed";

export interface UserContextRecord {
  contextKey: string;
  defaultAgent: string;
  currentSessionId?: string;
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

interface UserContextRow {
  context_key: string;
  default_agent: string;
  current_session_id: string | null;
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

export class StateStore {
  private readonly db: Database.Database;

  constructor(sqlitePath: string) {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new Database(sqlitePath);
    this.db.pragma("journal_mode = WAL");
    for (const migration of migrations) {
      this.db.exec(migration);
    }
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

  listUserContexts(): UserContextRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM user_contexts ORDER BY created_at ASC")
      .all() as UserContextRow[];
    return rows.map(mapUserContext);
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
      .prepare("UPDATE user_contexts SET current_session_id = ?, updated_at = ? WHERE context_key = ?")
      .run(localSessionId ?? null, now, contextKey);
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
      .run(input.localSessionId, input.contextKey, input.agentName, input.cwd, input.status, now, now);

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
}

function mapUserContext(row: UserContextRow): UserContextRecord {
  return {
    contextKey: row.context_key,
    defaultAgent: row.default_agent,
    currentSessionId: row.current_session_id ?? undefined,
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
