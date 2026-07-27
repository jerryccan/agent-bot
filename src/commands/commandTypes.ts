import type { PermissionMode } from "../runtime/types.js";

export type Command =
  | { type: "shell"; command: string }
  | { type: "new"; title?: string; cwd?: string; projectless?: boolean }
  | { type: "newgroup"; title?: string }
  | { type: "forkgroup"; title?: string }
  | { type: "fork"; sessionId?: string }
  | { type: "title"; title: string }
  | { type: "ask"; text: string }
  | { type: "nosteer"; text: string }
  | { type: "sessions"; searchTerm?: string }
  | { type: "switch"; sessionId?: string }
  | { type: "agent"; agent?: string }
  | { type: "use"; agent: string; cwd?: string }
  | { type: "stop" }
  | { type: "status"; sessionId?: string }
  | { type: "goal"; action: "show" }
  | { type: "goal"; action: "set" | "edit"; objective: string }
  | { type: "goal"; action: "pause" | "resume" | "clear" }
  | { type: "restart" }
  | { type: "modes" }
  | { type: "mode"; value: string }
  | { type: "model"; model?: string }
  | { type: "thinking"; effort?: string }
  | { type: "permissions"; mode?: PermissionMode }
  | { type: "help" }
  | { type: "prompt"; text: string };
