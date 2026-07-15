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
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
