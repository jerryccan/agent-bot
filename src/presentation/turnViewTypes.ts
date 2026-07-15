import type { ApprovalRequest, PlanStep, ToolState } from "../runtime/types.js";

export type TurnViewStatus =
  | "starting"
  | "running"
  | "tool_running"
  | "waiting_for_approval"
  | "completed"
  | "cancelled"
  | "failed";

export interface FileSummary {
  path: string;
  additions?: number;
  deletions?: number;
}

export type TurnActivity =
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolState };

export interface TurnViewState {
  sessionId: string;
  turnId: string;
  status: TurnViewStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  progressText?: string;
  assistantText: string;
  plan: PlanStep[];
  activities: TurnActivity[];
  activeTool?: ToolState;
  completedTools: ToolState[];
  failedTools: ToolState[];
  fileSummary: FileSummary[];
  approval?: ApprovalRequest;
  finalResponse?: string;
  error?: string;
}
