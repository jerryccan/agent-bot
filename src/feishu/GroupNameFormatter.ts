import os from "node:os";
import path from "node:path";
import {
  DEFAULT_GROUP_NAME_FORMAT,
  type GroupNameFormatConfig,
} from "../config/schema.js";

export const FEISHU_GROUP_NAME_MAX_LENGTH = 60;
const GROUP_PROJECT_NAME_MAX_LENGTH = 15;
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/gu;
const TASK_NAME_PLACEHOLDER = "{taskname}";

export interface GroupNameFormatInput {
  agentName: string;
  projectCwd?: string;
  taskName: string;
  date?: Date;
  platform?: NodeJS.Platform;
  format?: GroupNameFormatConfig;
}

export interface GroupNameParseInput {
  agentName: string;
  groupName: string;
  projectCwd?: string;
  platform?: NodeJS.Platform;
  format?: GroupNameFormatConfig;
}

export function formatNewGroupName(input: GroupNameFormatInput): string {
  const format = input.format ?? DEFAULT_GROUP_NAME_FORMAT;
  const template = input.projectCwd ? format.project : format.projectless;
  const taskNameIndex = template.indexOf(TASK_NAME_PLACEHOLDER);
  const values = templateValues(input, format);
  const prefix = renderTemplate(template.slice(0, taskNameIndex), values);
  const suffix = renderTemplate(template.slice(taskNameIndex + TASK_NAME_PLACEHOLDER.length), values);
  const availableTaskNameLength = FEISHU_GROUP_NAME_MAX_LENGTH
    - Array.from(prefix).length
    - Array.from(suffix).length;
  const taskName = truncateTail(input.taskName, availableTaskNameLength);
  return truncateTail(`${prefix}${taskName}${suffix}`.trim(), FEISHU_GROUP_NAME_MAX_LENGTH);
}

export function parseTaskNameFromGroupName(input: GroupNameParseInput): string | undefined {
  const format = input.format ?? DEFAULT_GROUP_NAME_FORMAT;
  const template = input.projectCwd ? format.project : format.projectless;
  const values = templateValues(input, format);
  let pattern = "^";
  let cursor = 0;
  let match: RegExpExecArray | null;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  while ((match = PLACEHOLDER_PATTERN.exec(template)) !== null) {
    pattern += escapeRegExp(template.slice(cursor, match.index));
    const token = match[1]!;
    if (token === "taskname") pattern += "(?<taskname>.+?)";
    else if (token === "date" || token.startsWith("date:")) {
      const dateFormat = token === "date" ? format.dateFormat : token.slice("date:".length);
      pattern += dateFormatPattern(dateFormat);
    } else {
      pattern += escapeRegExp(placeholderValue(token, values));
    }
    cursor = match.index + match[0].length;
  }
  pattern += `${escapeRegExp(template.slice(cursor))}$`;
  const parsed = new RegExp(pattern, "iu").exec(input.groupName.trim())?.groups?.taskname?.trim();
  return parsed || undefined;
}

export function formatGroupNameDate(date: Date, format: string): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();
  const values = new Map<string, string>([
    ["yyyy", String(year).padStart(4, "0")],
    ["YYYY", String(year).padStart(4, "0")],
    ["yy", String(year % 100).padStart(2, "0")],
    ["YY", String(year % 100).padStart(2, "0")],
    ["MM", String(month).padStart(2, "0")],
    ["M", String(month)],
    ["dd", String(day).padStart(2, "0")],
    ["DD", String(day).padStart(2, "0")],
    ["d", String(day)],
    ["D", String(day)],
    ["HH", String(hour).padStart(2, "0")],
    ["H", String(hour)],
    ["mm", String(minute).padStart(2, "0")],
    ["m", String(minute)],
    ["ss", String(second).padStart(2, "0")],
    ["s", String(second)],
  ]);
  return replaceDateTokens(format, (token) => values.get(token)!);
}

export function groupNameOs(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  return platform;
}

export function formatGroupProjectName(projectCwd: string): string {
  const value = abbreviateHomeDirectory(projectCwd);
  const levels = value
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-2);
  const separator = value.includes("\\") ? path.win32.sep : path.posix.sep;
  return fitTrailingPathLevels(levels, GROUP_PROJECT_NAME_MAX_LENGTH, separator);
}

interface TemplateValues {
  agent: string;
  project: string;
  os: string;
  date: Date;
  dateFormat: string;
}

function templateValues(
  input: Pick<GroupNameFormatInput, "agentName" | "projectCwd" | "date" | "platform">,
  format: GroupNameFormatConfig,
): TemplateValues {
  return {
    agent: input.agentName,
    project: input.projectCwd ? formatGroupProjectName(input.projectCwd) : "",
    os: groupNameOs(input.platform),
    date: input.date ?? new Date(),
    dateFormat: format.dateFormat,
  };
}

function renderTemplate(template: string, values: TemplateValues): string {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return template.replace(PLACEHOLDER_PATTERN, (_placeholder, token: string) => {
    if (token === "date") return formatGroupNameDate(values.date, values.dateFormat);
    if (token.startsWith("date:")) {
      return formatGroupNameDate(values.date, token.slice("date:".length));
    }
    return placeholderValue(token, values);
  });
}

function placeholderValue(token: string, values: TemplateValues): string {
  if (token === "agent") return values.agent;
  if (token === "project") return values.project;
  if (token === "os") return values.os;
  return "";
}

function dateFormatPattern(format: string): string {
  return replaceDateTokens(format, (token) => {
    if (["yyyy", "YYYY"].includes(token)) return "\\d{4}";
    if (["yy", "YY", "MM", "dd", "DD", "HH", "mm", "ss"].includes(token)) return "\\d{2}";
    return "\\d{1,2}";
  }, escapeRegExp);
}

const DATE_TOKENS = [
  "yyyy", "YYYY", "yy", "YY", "MM", "dd", "DD", "HH", "mm", "ss", "M", "d", "D", "H", "m", "s",
];

function replaceDateTokens(
  format: string,
  replaceToken: (token: string) => string,
  replaceLiteral: (literal: string) => string = (literal) => literal,
): string {
  let result = "";
  for (let index = 0; index < format.length;) {
    const token = DATE_TOKENS.find((candidate) => format.startsWith(candidate, index));
    if (token) {
      result += replaceToken(token);
      index += token.length;
    } else {
      result += replaceLiteral(format[index]!);
      index += 1;
    }
  }
  return result;
}

function abbreviateHomeDirectory(value: string): string {
  const homeDirectory = os.homedir();
  const valueIsWindows = isWindowsAbsolutePath(value);
  const homeIsWindows = isWindowsAbsolutePath(homeDirectory);
  if (valueIsWindows !== homeIsWindows && (valueIsWindows || path.posix.isAbsolute(value))) return value;
  const pathApi = valueIsWindows ? path.win32 : path;
  const relative = pathApi.relative(homeDirectory, value);
  if (relative === "") return "~";
  if (pathApi.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${pathApi.sep}`)) return value;
  return `~${pathApi.sep}${relative}`;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]|^\\\\/iu.test(value);
}

function fitTrailingPathLevels(levels: string[], maxLength: number, separator: string): string {
  if (levels.length === 0) return "";
  if (levels.length === 1) return truncateTail(levels[0]!, maxLength);
  const parent = levels[0]!;
  const leaf = levels[1]!;
  const joined = `${parent}${separator}${leaf}`;
  if (Array.from(joined).length <= maxLength) return joined;
  if (Array.from(leaf).length <= maxLength) return leaf;
  return truncateTail(leaf, maxLength);
}

function truncateTail(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${characters.slice(0, maxLength - 3).join("")}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
