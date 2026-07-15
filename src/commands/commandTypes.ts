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
  | { type: "help" }
  | { type: "prompt"; text: string };
