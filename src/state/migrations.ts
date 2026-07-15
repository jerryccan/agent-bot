export const migrations = [
  `
  CREATE TABLE IF NOT EXISTS user_contexts (
    context_key TEXT PRIMARY KEY,
    default_agent TEXT NOT NULL,
    current_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS sessions (
    local_session_id TEXT PRIMARY KEY,
    context_key TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    acp_session_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
] as const;
