import type { PermissionMode } from "../runtime/types.js";

export type Command =
  | { type: "agents" }
  | { type: "new"; agent?: string; cwd?: string }
  | { type: "ask"; text: string }
  | { type: "sessions" }
  | { type: "switch"; sessionId: string }
  | { type: "agent"; agent: string }
  | { type: "use"; agent: string; cwd?: string }
  | { type: "cancel" }
  | { type: "close"; sessionId?: string }
  | { type: "status" }
  | { type: "modes" }
  | { type: "mode"; value: string }
  | { type: "model"; model?: string }
  | { type: "thinking"; effort?: string }
  | { type: "permissions"; mode?: PermissionMode }
  | { type: "help" }
  | { type: "prompt"; text: string };
