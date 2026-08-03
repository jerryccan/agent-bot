import { createHash } from "node:crypto";
import path from "node:path";
import type { TurnViewState } from "../presentation/turnViewTypes.js";
import type { RemoteSessionSummary } from "../runtime/types.js";
import type { SessionRecord } from "../state/StateStore.js";

export type ControlRequest =
  | { action: "health" }
  | { action: "server_restart"; mode: "safe" | "immediate"; reason: string }
  | { action: "server_stop" }
  | { action: "task_status"; localSessionId: string }
  | { action: "task_stop"; localSessionId: string }
  | { action: "task_title"; localSessionId: string; title: string }
  | { action: "task_prompt"; localSessionId: string; text: string }
  | {
      action: "task_new_group";
      localSessionId: string;
      title?: string;
      cwd?: string;
      agentName?: string;
      projectless?: boolean;
    }
  | { action: "task_fork_group"; localSessionId: string; title?: string };

export interface ControlResponse {
  ok: boolean;
  message?: string;
  data?: unknown;
}

export interface TaskStatusControlData {
  session: SessionRecord;
  snapshot?: TurnViewState;
  remote?: RemoteSessionSummary;
}

export interface TaskGroupControlData {
  sourceLocalSessionId: string;
  sourceTurnId?: string;
  group: {
    chatId: string;
    contextKey: string;
    name: string;
  };
  task: SessionRecord;
}

export function controlEndpoint(sqlitePath: string): string {
  const resolvedPath = path.resolve(sqlitePath);
  const key = createHash("sha256").update(resolvedPath.toLowerCase()).digest("hex").slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\agent-bot-${key}`
    : path.join(path.dirname(resolvedPath), `.agent-bot-${key}.sock`);
}
