import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";

export interface TaskNewGroupOptions {
  reference: string;
  title?: string;
  cwd?: string;
  agentName?: string;
  projectless: boolean;
  json: boolean;
}

export interface TaskForkGroupOptions {
  reference: string;
  title?: string;
  json: boolean;
}

export function parseTaskNewGroupOptions(
  input: string[],
  language: CliLanguage = cliLanguage,
): TaskNewGroupOptions {
  const positionals: string[] = [];
  let cwd: string | undefined;
  let agentName: string | undefined;
  let projectless = false;
  let json = false;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--nodir") {
      if (projectless) throw optionError("newgroup", "--nodir", language);
      if (cwd !== undefined) throw conflictingProjectOptions(language);
      projectless = true;
      continue;
    }
    if (argument === "--dir") {
      if (projectless) throw conflictingProjectOptions(language);
      if (cwd !== undefined) throw optionError("newgroup", "--dir", language);
      const directory = input[index + 1];
      if (!directory || directory.startsWith("--")) {
        throw new Error(cliText(
          "task newgroup requires a project directory after --dir.",
          "task newgroup 需要在 --dir 后指定项目目录。",
          language,
        ));
      }
      cwd = directory;
      index += 1;
      continue;
    }
    if (argument === "--agent") {
      if (agentName !== undefined) throw optionError("newgroup", "--agent", language);
      const name = input[index + 1];
      if (!name?.trim() || name.startsWith("--")) {
        throw new Error(cliText(
          "task newgroup requires an Agent standard name after --agent.",
          "task newgroup 需要在 --agent 后指定 Agent 标准名。",
          language,
        ));
      }
      agentName = name.trim();
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw unsupportedOption("newgroup", argument, language);
    positionals.push(argument);
  }
  const [reference, ...titleParts] = positionals;
  requireTaskReference("newgroup", reference, language);
  return {
    reference,
    title: titleParts.join(" ").trim() || undefined,
    cwd,
    ...(agentName ? { agentName } : {}),
    projectless,
    json,
  };
}

export function parseTaskForkGroupOptions(
  input: string[],
  language: CliLanguage = cliLanguage,
): TaskForkGroupOptions {
  const positionals: string[] = [];
  let json = false;
  for (const argument of input) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument.startsWith("--")) throw unsupportedOption("forkgroup", argument, language);
    positionals.push(argument);
  }
  const [reference, ...titleParts] = positionals;
  requireTaskReference("forkgroup", reference, language);
  return {
    reference,
    title: titleParts.join(" ").trim() || undefined,
    json,
  };
}

function requireTaskReference(
  action: "newgroup" | "forkgroup",
  reference: string | undefined,
  language: CliLanguage,
): asserts reference is string {
  if (reference && !reference.startsWith("--")) return;
  throw new Error(cliText(
    `task ${action} requires a source task number or task ID.`,
    `task ${action} 需要源任务序号或任务 ID。`,
    language,
  ));
}

function optionError(
  action: "newgroup",
  option: "--agent" | "--dir" | "--nodir",
  language: CliLanguage,
): Error {
  return new Error(cliText(
    `task ${action} accepts ${option} only once.`,
    `task ${action} 只能指定一次 ${option}。`,
    language,
  ));
}

function conflictingProjectOptions(language: CliLanguage): Error {
  return new Error(cliText(
    "task newgroup cannot combine --dir and --nodir.",
    "task newgroup 的 --dir 和 --nodir 不能同时使用。",
    language,
  ));
}

function unsupportedOption(
  action: "newgroup" | "forkgroup",
  option: string,
  language: CliLanguage,
): Error {
  return new Error(cliText(
    `task ${action} does not support option: ${option}.`,
    `task ${action} 不支持参数：${option}。`,
    language,
  ));
}
