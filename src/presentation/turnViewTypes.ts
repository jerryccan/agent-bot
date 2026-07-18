import type { MessageReplyTarget } from "../feishu/types.js";
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
  taskTitle?: string;
  projectCwd?: string;
  replyTarget?: MessageReplyTarget;
  status: TurnViewStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  progressText?: string;
  assistantText: string;
  plan: PlanStep[];
  activities: TurnActivity[];
  activitiesTruncated?: boolean;
  activeTool?: ToolState;
  completedTools: ToolState[];
  failedTools: ToolState[];
  fileSummary: FileSummary[];
  approval?: ApprovalRequest;
  finalResponse?: string;
  error?: string;
}
