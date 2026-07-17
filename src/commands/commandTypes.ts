import type { PermissionMode } from "../runtime/types.js";

export type Command =
  | { type: "new"; cwd?: string }
  | { type: "ask"; text: string }
  | { type: "sessions"; searchTerm?: string }
  | { type: "switch"; sessionId?: string }
  | { type: "agent"; agent?: string }
  | { type: "use"; agent: string; cwd?: string }
  | { type: "stop" }
  | { type: "status"; sessionId?: string }
  | { type: "restart" }
  | { type: "modes" }
  | { type: "mode"; value: string }
  | { type: "model"; model?: string }
  | { type: "thinking"; effort?: string }
  | { type: "permissions"; mode?: PermissionMode }
  | { type: "help" }
  | { type: "prompt"; text: string };
