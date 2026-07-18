import type { AgentEvent, ToolState } from "../runtime/types.js";
import type { MessageReplyTarget } from "../feishu/types.js";
import type { FileSummary, TurnActivity, TurnViewState } from "./turnViewTypes.js";

const MAX_TEXT = 6_000;
const MAX_COMPLETED_TOOLS = 20;
const MAX_FAILED_TOOLS = 5;
const MAX_FILES = 30;
const MAX_ACTIVITIES = 40;

export function createTurnViewState(
  sessionId: string,
  turnId: string,
  startedAt: number,
  taskTitle?: string,
  replyTarget?: MessageReplyTarget,
  projectCwd?: string,
): TurnViewState {
  return {
    sessionId,
    turnId,
    taskTitle,
    projectCwd,
    replyTarget,
    status: "starting",
    startedAt,
    assistantText: "",
    plan: [],
    activities: [],
    completedTools: [],
    failedTools: [],
    fileSummary: [],
  };
}

export function reduceTurnEvent(state: TurnViewState, event: AgentEvent): TurnViewState {
  if (event.sessionId !== state.sessionId || event.turnId !== state.turnId) return state;

  switch (event.type) {
    case "turn_started":
      return { ...state, status: "running", startedAt: event.startedAt };
    case "agent_text_delta":
      return { ...state, assistantText: bound(`${state.assistantText}${event.text}`) };
    case "token_usage_updated":
      return { ...state, totalTokens: Math.max(0, Math.round(event.totalTokens)) };
    case "progress": {
      const activityUpdate = upsertReasoningActivity(
        state.activities ?? [],
        event.activityId ?? "progress",
        event.text,
        event.append === true,
      );
      return {
        ...state,
        progressText: bound(event.text),
        activities: activityUpdate.activities,
        activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
      };
    }
    case "plan_updated":
      return { ...state, plan: event.steps.slice(0, 30).map((step) => ({ ...step, text: bound(step.text) })) };
    case "tool_started": {
      const tool = withToolTiming(state, event.tool);
      const bounded = boundTool(tool);
      const activityUpdate = upsertToolActivity(state.activities ?? [], bounded);
      return {
        ...state,
        status: "tool_running",
        activeTool: bounded,
        activities: activityUpdate.activities,
        activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
        fileSummary: mergeFiles(state.fileSummary, tool.files),
      };
    }
    case "tool_updated":
      return reduceToolUpdate(state, event.tool);
    case "tool_output_delta":
      return reduceToolOutputDelta(state, event.toolId, event.delta);
    case "approval_requested":
      return { ...state, status: "waiting_for_approval", approval: event.request };
    case "approval_resolved":
      return { ...state, status: state.activeTool ? "tool_running" : "running", approval: undefined };
    case "turn_completed":
      return {
        ...state,
        status: "completed",
        activeTool: undefined,
        approval: undefined,
        completedAt: state.startedAt + (event.durationMs ?? Date.now() - state.startedAt),
        durationMs: event.durationMs ?? Date.now() - state.startedAt,
        finalResponse: event.finalResponse,
      };
    case "turn_cancelled":
      return { ...state, status: "cancelled", activeTool: undefined, approval: undefined, completedAt: Date.now() };
    case "turn_failed":
      return {
        ...state,
        status: "failed",
        activeTool: undefined,
        approval: undefined,
        completedAt: Date.now(),
        error: bound(event.message),
      };
  }
}

function reduceToolOutputDelta(state: TurnViewState, toolId: string, delta: string): TurnViewState {
  if (!delta) return state;
  const tool = findTool(state, toolId);
  if (!tool || tool.status !== "running" || tool.kind !== "command") return state;
  return reduceToolUpdate(state, {
    ...tool,
    output: appendBoundedOutput(tool.output, delta),
  });
}

function findTool(state: TurnViewState, toolId: string): ToolState | undefined {
  if (state.activeTool?.id === toolId) return state.activeTool;
  const activity = [...(state.activities ?? [])].reverse().find((candidate) =>
    candidate.kind === "tool" && candidate.tool.id === toolId);
  if (activity?.kind === "tool") return activity.tool;
  return state.failedTools.find((tool) => tool.id === toolId)
    ?? state.completedTools.find((tool) => tool.id === toolId);
}

function withToolTiming(state: TurnViewState, tool: ToolState): ToolState {
  const previous = findTool(state, tool.id);
  const now = Date.now();
  const startedAt = tool.startedAt ?? previous?.startedAt ?? tool.completedAt ?? now;
  return {
    ...tool,
    startedAt,
    completedAt: tool.status === "running" ? tool.completedAt : tool.completedAt ?? now,
  };
}

function appendBoundedOutput(previous: string | undefined, delta: string): string {
  const combined = `${previous ?? ""}${delta}`;
  if (combined.length <= MAX_TEXT) return combined;
  return `…${combined.slice(-(MAX_TEXT - 1))}`;
}

function reduceToolUpdate(state: TurnViewState, tool: ToolState): TurnViewState {
  tool = withToolTiming(state, tool);
  const bounded = boundTool(tool);
  const activityUpdate = upsertToolActivity(state.activities ?? [], bounded);
  const withoutCompleted = state.completedTools.filter((item) => item.id !== tool.id);
  const withoutFailed = state.failedTools.filter((item) => item.id !== tool.id);
  const activeTool = state.activeTool?.id === tool.id ? undefined : state.activeTool;

  if (tool.status === "running") {
    return {
      ...state,
      status: "tool_running",
      activeTool: bounded,
      activities: activityUpdate.activities,
      activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
      completedTools: withoutCompleted,
      failedTools: withoutFailed,
      fileSummary: mergeFiles(state.fileSummary, tool.files),
    };
  }

  if (tool.status === "failed") {
    return {
      ...state,
      status: activeTool ? "tool_running" : "running",
      activeTool,
      activities: activityUpdate.activities,
      activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
      completedTools: withoutCompleted,
      failedTools: [...withoutFailed, bounded].slice(-MAX_FAILED_TOOLS),
      fileSummary: mergeFiles(state.fileSummary, tool.files),
    };
  }

  return {
    ...state,
    status: activeTool ? "tool_running" : "running",
    activeTool,
    activities: activityUpdate.activities,
    activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
    failedTools: withoutFailed,
    completedTools: [...withoutCompleted, bounded].slice(-MAX_COMPLETED_TOOLS),
    fileSummary: mergeFiles(state.fileSummary, tool.files),
  };
}

function upsertReasoningActivity(
  activities: TurnActivity[],
  id: string,
  text: string,
  append: boolean,
): ActivityUpdate {
  const index = activities.findIndex((activity) => activity.id === id);
  const existing = index >= 0 ? activities[index] : undefined;
  const previousText = existing?.kind === "reasoning" ? existing.text : "";
  const next: TurnActivity = {
    kind: "reasoning",
    id,
    text: bound(append ? `${previousText}${text}` : text),
  };
  return upsertActivity(activities, index, next);
}

function upsertToolActivity(activities: TurnActivity[], tool: ToolState): ActivityUpdate {
  const index = activities.findIndex((activity) => activity.id === tool.id);
  return upsertActivity(activities, index, { kind: "tool", id: tool.id, tool });
}

interface ActivityUpdate {
  activities: TurnActivity[];
  truncated: boolean;
}

function upsertActivity(activities: TurnActivity[], index: number, activity: TurnActivity): ActivityUpdate {
  const updated = [...activities];
  if (index >= 0) updated[index] = activity;
  else updated.push(activity);
  return {
    activities: updated.slice(-MAX_ACTIVITIES),
    truncated: updated.length > MAX_ACTIVITIES,
  };
}

function boundTool(tool: ToolState): ToolState {
  return {
    ...tool,
    title: bound(tool.title),
    command: tool.command === undefined ? undefined : bound(tool.command),
    output: tool.output === undefined ? undefined : bound(tool.output),
    error: tool.error === undefined ? undefined : bound(tool.error),
    files: tool.files?.slice(0, MAX_FILES),
  };
}

function mergeFiles(existing: FileSummary[], incoming: ToolState["files"]): FileSummary[] {
  if (!incoming?.length) return existing;
  const merged = new Map(existing.map((file) => [file.path, { ...file }]));
  for (const file of incoming) {
    const previous = merged.get(file.path);
    merged.set(file.path, {
      path: file.path,
      additions: addOptional(previous?.additions, file.additions),
      deletions: addOptional(previous?.deletions, file.deletions),
    });
  }
  return [...merged.values()].slice(-MAX_FILES);
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function bound(value: string): string {
  if (value.length <= MAX_TEXT) return value;
  return `${value.slice(0, MAX_TEXT - 1)}…`;
}
