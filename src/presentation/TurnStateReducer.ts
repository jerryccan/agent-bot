import type { AgentEvent, ToolState } from "../runtime/types.js";
import { appendGeneratedImageMarkdown } from "../utils/generatedImageMarkdown.js";
import type { MessageReplyTarget } from "../feishu/types.js";
import type { FileSummary, TurnActivity, TurnViewState } from "./turnViewTypes.js";

const MAX_TEXT = 6_000;
const MAX_COMPLETED_TOOLS = 20;
const MAX_FAILED_TOOLS = 5;
const MAX_FILES = 30;

export function createTurnViewState(
  sessionId: string,
  turnId: string,
  startedAt: number,
  taskTitle?: string,
  replyTarget?: MessageReplyTarget,
  projectCwd?: string,
  prompt?: string,
  agentLabel?: string,
): TurnViewState {
  return {
    sessionId,
    turnId,
    agentLabel,
    taskTitle,
    prompt,
    projectCwd,
    replyTarget,
    status: "starting",
    startedAt,
    assistantText: "",
    plan: [],
    activities: [],
    totalToolCount: 0,
    completedToolCount: 0,
    failedToolCount: 0,
    toolStatuses: {},
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
    case "token_usage_updated": {
      const lastTokens = normalizeTokenCount(event.lastTokens);
      const cumulativeTokens = normalizeTokenCount(event.cumulativeTokens);
      const previousCumulative = state.tokenUsageCumulative;
      const delta = previousCumulative === undefined
        ? lastTokens
        : Math.max(0, cumulativeTokens - previousCumulative);
      return {
        ...state,
        totalTokens: (state.totalTokens ?? 0) + delta,
        tokenUsageCumulative: Math.max(previousCumulative ?? 0, cumulativeTokens),
      };
    }
    case "progress": {
      const activityUpdate = upsertReasoningActivity(
        state.activities ?? [],
        event.activityId ?? "progress",
        event.text,
        event.append === true,
        event.activityId?.startsWith("commentary:") ? "assistant" : "reasoning",
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
      const tracking = trackToolStatus(state, tool);
      return {
        ...state,
        ...tracking,
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
    case "turn_completed": {
      const durationMs = Math.max(0, event.durationMs ?? Date.now() - state.startedAt);
      return {
        ...state,
        status: "completed",
        activeTool: undefined,
        approval: undefined,
        completedAt: state.startedAt + durationMs,
        durationMs,
        finalResponse: appendGeneratedImageMarkdown(
          event.finalResponse,
          state.completedTools.flatMap((tool) =>
            tool.kind === "image_generation" && tool.imagePath ? [tool.imagePath] : []),
        ),
      };
    }
    case "turn_cancelled": {
      const completedAt = Date.now();
      return {
        ...state,
        status: "cancelled",
        activeTool: undefined,
        approval: undefined,
        completedAt,
        durationMs: Math.max(0, completedAt - state.startedAt),
      };
    }
    case "turn_failed": {
      const completedAt = Date.now();
      return {
        ...state,
        status: "failed",
        activeTool: undefined,
        approval: undefined,
        completedAt,
        durationMs: Math.max(0, completedAt - state.startedAt),
        error: bound(event.message),
      };
    }
  }
}

export function appendSteerMessage(state: TurnViewState, id: string, text: string): TurnViewState {
  const normalized = text.trim();
  if (!normalized) return state;
  const activities = state.activities ?? [];
  const index = activities.findIndex((activity) => activity.id === id);
  const activityUpdate = upsertActivity(activities, index, {
    kind: "user",
    id,
    text: bound(normalized),
  });
  return {
    ...state,
    activities: activityUpdate.activities,
    activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
  };
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
  const tracking = trackToolStatus(state, tool);
  const bounded = boundTool(tool);
  const activityUpdate = upsertToolActivity(state.activities ?? [], bounded);
  const withoutCompleted = state.completedTools.filter((item) => item.id !== tool.id);
  const withoutFailed = state.failedTools.filter((item) => item.id !== tool.id);
  const activeTool = state.activeTool?.id === tool.id ? undefined : state.activeTool;

  if (tool.status === "running") {
    return {
      ...state,
      ...tracking,
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
      ...tracking,
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
    ...tracking,
    status: activeTool ? "tool_running" : "running",
    activeTool,
    activities: activityUpdate.activities,
    activitiesTruncated: state.activitiesTruncated || activityUpdate.truncated,
    failedTools: withoutFailed,
    completedTools: [...withoutCompleted, bounded].slice(-MAX_COMPLETED_TOOLS),
    fileSummary: mergeFiles(state.fileSummary, tool.files),
  };
}

function trackToolStatus(
  state: TurnViewState,
  tool: ToolState,
): Pick<TurnViewState, "totalToolCount" | "completedToolCount" | "failedToolCount" | "toolStatuses"> {
  const toolStatuses = state.toolStatuses
    ? { ...state.toolStatuses }
    : legacyToolStatuses(state);
  const previous = toolStatuses[tool.id];
  let totalToolCount = state.totalToolCount ?? Object.keys(toolStatuses).length;
  let completedToolCount = state.completedToolCount
    ?? Object.values(toolStatuses).filter((status) => status === "completed").length;
  let failedToolCount = state.failedToolCount
    ?? Object.values(toolStatuses).filter((status) => status === "failed").length;

  if (previous === undefined) totalToolCount += 1;
  if (previous !== tool.status) {
    if (previous === "completed") completedToolCount = Math.max(0, completedToolCount - 1);
    if (previous === "failed") failedToolCount = Math.max(0, failedToolCount - 1);
    if (tool.status === "completed") completedToolCount += 1;
    if (tool.status === "failed") failedToolCount += 1;
  }
  toolStatuses[tool.id] = tool.status;
  return { totalToolCount, completedToolCount, failedToolCount, toolStatuses };
}

function legacyToolStatuses(state: TurnViewState): Record<string, ToolState["status"]> {
  const statuses: Record<string, ToolState["status"]> = {};
  for (const tool of state.completedTools ?? []) statuses[tool.id] = tool.status;
  for (const tool of state.failedTools ?? []) statuses[tool.id] = tool.status;
  for (const activity of state.activities ?? []) {
    if (activity.kind === "tool") statuses[activity.tool.id] = activity.tool.status;
  }
  if (state.activeTool) statuses[state.activeTool.id] = state.activeTool.status;
  return statuses;
}

function upsertReasoningActivity(
  activities: TurnActivity[],
  id: string,
  text: string,
  append: boolean,
  kind: "assistant" | "reasoning",
): ActivityUpdate {
  const index = activities.findIndex((activity) => activity.id === id);
  const existing = index >= 0 ? activities[index] : undefined;
  const previousText = existing?.kind === "reasoning" || existing?.kind === "assistant" ? existing.text : "";
  const combined = append ? `${previousText}${text}` : text;
  const next: TurnActivity = {
    kind,
    id,
    text: kind === "assistant" ? combined : bound(combined),
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
    activities: updated,
    truncated: false,
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

function normalizeTokenCount(value: number): number {
  return Math.max(0, Math.round(value));
}
