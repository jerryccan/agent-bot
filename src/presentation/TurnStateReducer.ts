import type { AgentEvent, ToolState } from "../runtime/types.js";
import type { FileSummary, TurnViewState } from "./turnViewTypes.js";

const MAX_TEXT = 6_000;
const MAX_COMPLETED_TOOLS = 20;
const MAX_FAILED_TOOLS = 5;
const MAX_FILES = 30;

export function createTurnViewState(sessionId: string, turnId: string, startedAt: number): TurnViewState {
  return {
    sessionId,
    turnId,
    status: "starting",
    startedAt,
    assistantText: "",
    plan: [],
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
    case "progress":
      return { ...state, progressText: bound(event.text) };
    case "plan_updated":
      return { ...state, plan: event.steps.slice(0, 30).map((step) => ({ ...step, text: bound(step.text) })) };
    case "tool_started":
      return {
        ...state,
        status: "tool_running",
        activeTool: boundTool(event.tool),
        fileSummary: mergeFiles(state.fileSummary, event.tool.files),
      };
    case "tool_updated":
      return reduceToolUpdate(state, event.tool);
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

function reduceToolUpdate(state: TurnViewState, tool: ToolState): TurnViewState {
  const bounded = boundTool(tool);
  const withoutCompleted = state.completedTools.filter((item) => item.id !== tool.id);
  const withoutFailed = state.failedTools.filter((item) => item.id !== tool.id);
  const activeTool = state.activeTool?.id === tool.id ? undefined : state.activeTool;

  if (tool.status === "running") {
    return {
      ...state,
      status: "tool_running",
      activeTool: bounded,
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
      completedTools: withoutCompleted,
      failedTools: [...withoutFailed, bounded].slice(-MAX_FAILED_TOOLS),
      fileSummary: mergeFiles(state.fileSummary, tool.files),
    };
  }

  return {
    ...state,
    status: activeTool ? "tool_running" : "running",
    activeTool,
    failedTools: withoutFailed,
    completedTools: [...withoutCompleted, bounded].slice(-MAX_COMPLETED_TOOLS),
    fileSummary: mergeFiles(state.fileSummary, tool.files),
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
