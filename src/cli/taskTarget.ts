import type { SessionRecord } from "../state/StateStore.js";
import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";
import {
  currentAppServerThreadIds,
  resolveCurrentTask,
  taskCurrentExternalInvocationMessage,
} from "./taskListOutput.js";

export interface TaskCommandTarget {
  session: SessionRecord;
  args: string[];
  source: "current" | "explicit";
}

export function resolveTaskCommandTarget(
  sessions: SessionRecord[],
  args: string[],
  action: string,
  options: {
    env?: NodeJS.ProcessEnv;
    language?: CliLanguage;
    preferCurrent?: boolean;
  } = {},
): TaskCommandTarget {
  const env = options.env ?? process.env;
  const language = options.language ?? cliLanguage;
  const extracted = extractTaskOption(args, action, language);
  if (extracted.reference) {
    return {
      session: resolveTask(sessions, extracted.reference, language),
      args: extracted.args,
      source: "explicit",
    };
  }

  const first = extracted.args[0];
  if (env.AGENT_BOT === "1") {
    if (!options.preferCurrent && first && !first.startsWith("--")) {
      const explicit = tryResolveTask(sessions, first, language);
      if (explicit) {
        return { session: explicit, args: extracted.args.slice(1), source: "explicit" };
      }
    }
    return {
      session: resolveCurrentTaskFromEnvironment(sessions, env, language),
      args: extracted.args,
      source: "current",
    };
  }

  requireTaskCommandReference(action, first, language);
  return {
    session: resolveTask(sessions, first, language),
    args: extracted.args.slice(1),
    source: "explicit",
  };
}

export function resolveCurrentTaskFromEnvironment(
  sessions: SessionRecord[],
  env: NodeJS.ProcessEnv = process.env,
  language: CliLanguage = cliLanguage,
): SessionRecord {
  if (env.AGENT_BOT !== "1") throw new Error(taskCurrentExternalInvocationMessage(language));
  const resolution = resolveCurrentTask(sessions, currentAppServerThreadIds(env));
  if (resolution.status === "found") return resolution.session;
  if (resolution.status === "missing-thread-id") throw new Error(cliText(
    "Agent Bot detected an Agent process, but no current task ID is available. Use agentbot task list and pass --task <task>.",
    "已检测到 Agent Bot 中的 Agent 进程，但当前任务 ID 不可用。请使用 agentbot task list，并传入 --task <任务>。",
    language,
  ));
  if (resolution.status === "not-found") throw new Error(cliText(
    `No AgentBot task matches the current App Server Thread ID (${resolution.threadIds.join(", ")}). Check that the correct Profile is selected.`,
    `没有 AgentBot 任务匹配当前 App Server Thread ID（${resolution.threadIds.join("，")}）。请检查是否选择了正确的 Profile。`,
    language,
  ));
  throw new Error(cliText(
    "The current task is ambiguous because multiple injected Thread IDs match AgentBot tasks. Pass --task <task> with an explicit AgentBot task ID.",
    "当前任务存在歧义：多个注入的 Thread ID 匹配到了 AgentBot 任务。请通过 --task <任务> 传入明确的 AgentBot 任务 ID。",
    language,
  ));
}

export function resolveRestartNotificationTask(
  sessions: SessionRecord[],
  explicitReference: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  language: CliLanguage = cliLanguage,
): SessionRecord | undefined {
  if (explicitReference) return resolveTask(sessions, explicitReference, language);
  if (env.AGENT_BOT === "1") return resolveCurrentTaskFromEnvironment(sessions, env, language);
  return undefined;
}

export function resolveTask(
  sessions: SessionRecord[],
  reference: string,
  language: CliLanguage = cliLanguage,
): SessionRecord {
  if (/^\d+$/.test(reference)) {
    const index = Number(reference) - 1;
    const session = sessions[index];
    if (!session) throw new Error(cliText(
      `Task number is out of range: ${reference}`,
      `任务序号超出范围：${reference}`,
      language,
    ));
    return session;
  }
  const exact = sessions.find((session) =>
    session.localSessionId === reference || session.remoteSessionId === reference || session.acpSessionId === reference);
  if (exact) return exact;
  const matches = sessions.filter((session) =>
    session.localSessionId.startsWith(reference)
    || session.remoteSessionId?.startsWith(reference)
    || session.acpSessionId?.startsWith(reference));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(cliText(
    `Task ID prefix is ambiguous: ${reference}`,
    `任务 ID 前缀不唯一：${reference}`,
    language,
  ));
  throw new Error(cliText(`Task not found: ${reference}`, `未找到任务：${reference}`, language));
}

function extractTaskOption(
  args: string[],
  action: string,
  language: CliLanguage,
): { reference?: string; args: string[] } {
  const remaining: string[] = [];
  let reference: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value !== "--task") {
      remaining.push(value);
      continue;
    }
    if (reference) throw new Error(cliText(
      `task ${action} accepts --task only once.`,
      `task ${action} 只能指定一次 --task。`,
      language,
    ));
    const candidate = args[index + 1]?.trim();
    if (!candidate || candidate.startsWith("--")) throw new Error(cliText(
      `task ${action} requires a task number or task ID after --task.`,
      `task ${action} 需要在 --task 后指定任务序号或任务 ID。`,
      language,
    ));
    reference = candidate;
    index += 1;
  }
  return { ...(reference ? { reference } : {}), args: remaining };
}

function tryResolveTask(
  sessions: SessionRecord[],
  reference: string,
  language: CliLanguage,
): SessionRecord | undefined {
  try {
    return resolveTask(sessions, reference, language);
  } catch {
    return undefined;
  }
}

function requireTaskCommandReference(
  action: string,
  reference: string | undefined,
  language: CliLanguage,
): asserts reference is string {
  if (reference && !reference.startsWith("--")) return;
  throw new Error(cliText(
    `task ${action} requires a task number or task ID outside Agent Bot, or --task <task>.`,
    `在 Agent Bot 外执行 task ${action} 时，需要任务序号或任务 ID，或传入 --task <任务>。`,
    language,
  ));
}
