import { createHash } from "node:crypto";
import path from "node:path";

export type ControlRequest =
  | { action: "health" }
  | { action: "server_restart"; mode: "safe" | "immediate"; reason: string }
  | { action: "server_stop" }
  | { action: "task_stop"; localSessionId: string }
  | { action: "task_title"; localSessionId: string; title: string };

export interface ControlResponse {
  ok: boolean;
  message?: string;
  data?: unknown;
}

export function controlEndpoint(sqlitePath: string): string {
  const key = createHash("sha256").update(path.resolve(sqlitePath).toLowerCase()).digest("hex").slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\acp-bot-${key}`
    : path.join(path.dirname(path.resolve(sqlitePath)), `.acp-bot-${key}.sock`);
}
