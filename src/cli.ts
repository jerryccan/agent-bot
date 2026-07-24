#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/loadConfig.js";
import { sendControlRequest, isServerRunning } from "./cli/LocalControlClient.js";
import {
  controlEndpoint,
  type ControlResponse,
  type TaskStatusControlData,
} from "./cli/controlProtocol.js";
import { resolveSystemSkillsRoot, SkillRegistry, type SkillRegistrationStatus } from "./cli/SkillRegistry.js";
import { StateStore, type SessionRecord } from "./state/StateStore.js";

const args = process.argv.slice(2);

void main(args).catch((error: unknown) => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(input: string[]): Promise<void> {
  const parsed = parseGlobalOptions(input);
  if (parsed.configPath) process.env.ACP_BOT_CONFIG = parsed.configPath;
  const [command, ...rest] = parsed.args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "console") {
    await consoleCommand(rest);
    return;
  }
  if (command === "server") {
    await serverCommand(rest);
    return;
  }
  if (command === "task" || command === "tasks") {
    await taskCommand(rest);
    return;
  }
  if (command === "skill" || command === "skills") {
    skillsCommand(rest);
    return;
  }
  throw new Error(`未知命令：${command}。使用 acp-bot --help 查看帮助。`);
}

function skillsCommand(input: string[]): void {
  const [action = "status", ...rest] = input;
  const sourcePath = fileURLToPath(new URL("../skills/acp-bot/", import.meta.url));
  const targetRoot = optionValue(rest, "--target") ?? resolveSystemSkillsRoot();
  const registry = new SkillRegistry(sourcePath, targetRoot);
  const json = rest.includes("--json");

  if (action === "install" || action === "register") {
    const result = registry.install();
    if (json) printJson(result);
    else process.stdout.write(result.updated
      ? `已注册 acp-bot Skill：${result.status.targetPath}\n`
      : `acp-bot Skill 已是最新版本：${result.status.targetPath}\n`);
    return;
  }
  if (action === "uninstall" || action === "unregister") {
    const removed = registry.uninstall();
    if (json) printJson({ removed, targetPath: registry.targetPath });
    else process.stdout.write(removed
      ? `已反注册 acp-bot Skill：${registry.targetPath}\n`
      : `acp-bot Skill 尚未注册：${registry.targetPath}\n`);
    return;
  }
  if (action === "status") {
    const status = registry.status();
    if (json) printJson(status);
    else printSkillStatus(status);
    return;
  }
  if (action === "path") {
    const paths = { sourcePath: registry.sourcePath, skillsRoot: registry.skillsRoot, targetPath: registry.targetPath };
    if (json) printJson(paths);
    else {
      process.stdout.write(`内置 Skill：${paths.sourcePath}\n`);
      process.stdout.write(`系统 Skills：${paths.skillsRoot}\n`);
      process.stdout.write(`注册位置：${paths.targetPath}\n`);
    }
    return;
  }
  throw new Error(`未知 skills 命令：${action}`);
}

async function consoleCommand(input: string[]): Promise<void> {
  const config = loadConfig();
  const endpoint = controlEndpoint(config.storage.sqlitePath);
  const force = input.includes("--force");
  if (!force && await isServerRunning(endpoint)) {
    throw new Error("acp-bot server 正在运行。为避免争用同一任务状态，请先停止 server，或明确使用 --force。");
  }
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, ACP_BOT_CONSOLE_ONLY: "1" },
  });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) process.exitCode = result.status;
}

async function serverCommand(input: string[]): Promise<void> {
  const [action = "status", ...rest] = input;
  const config = loadConfig();
  const endpoint = controlEndpoint(config.storage.sqlitePath);
  if (action === "status") {
    try {
      const response = await sendControlRequest(endpoint, { action: "health" }, 1_500);
      ensureOk(response);
      if (rest.includes("--json")) printJson(response.data);
      else printServerStatus(response.data);
    } catch {
      if (rest.includes("--json")) printJson({ running: false });
      else process.stdout.write("acp-bot server：未运行\n");
      process.exitCode = 3;
    }
    return;
  }
  if (action === "start") {
    if (await isServerRunning(endpoint)) {
      process.stdout.write("acp-bot server 已在运行。\n");
      return;
    }
    const entry = fileURLToPath(new URL("./supervisor.js", import.meta.url));
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ACP_BOT_RESTART_REASON: "通过 acp-bot CLI 启动" },
    });
    child.unref();
    const running = await waitForServer(endpoint, 30_000);
    if (!running) throw new Error("已启动 Supervisor，但 server 未在 30 秒内就绪。请检查日志。");
    process.stdout.write("acp-bot server 已启动。\n");
    return;
  }
  if (action === "stop") {
    printResponse(await sendControlRequest(endpoint, { action: "server_stop" }));
    return;
  }
  if (action === "restart") {
    const immediate = rest.includes("--immediate") || rest.includes("--force");
    const reason = optionValue(rest, "--reason")
      ?? (immediate ? "通过 acp-bot CLI 立即重启" : "通过 acp-bot CLI 安全重启");
    printResponse(await sendControlRequest(endpoint, {
      action: "server_restart",
      mode: immediate ? "immediate" : "safe",
      reason,
    }));
    return;
  }
  throw new Error(`未知 server 命令：${action}`);
}

async function taskCommand(input: string[]): Promise<void> {
  const [action = "list", ...rest] = input;
  const config = loadConfig();
  const store = new StateStore(config.storage.sqlitePath);
  try {
    const allSessions = store.listAllSessions();
    if (action === "prompt" || action === "send") {
      const [reference, ...promptParts] = rest;
      if (!reference) throw new Error(`task ${action} 需要任务序号或任务 ID。`);
      const text = promptParts.join(" ").trim();
      if (!text) throw new Error(`task ${action} 需要要发送的 Prompt。`);
      const session = resolveTask(allSessions, reference);
      const endpoint = controlEndpoint(config.storage.sqlitePath);
      printResponse(await sendControlRequest(endpoint, {
        action: "task_prompt",
        localSessionId: session.localSessionId,
        text,
      }, 60_000));
      return;
    }
    const sessions = filterSessions(allSessions, rest);
    if (action === "list") {
      if (rest.includes("--json")) printJson(sessions);
      else printTaskList(sessions);
      return;
    }
    const reference = rest.find((value) => !value.startsWith("--"));
    if (!reference) throw new Error(`task ${action} 需要任务序号或任务 ID。`);
    const session = resolveTask(sessions, reference);
    if (action === "status") {
      const endpoint = controlEndpoint(config.storage.sqlitePath);
      let live: TaskStatusControlData | undefined;
      let response: ControlResponse | undefined;
      try {
        response = await sendControlRequest(endpoint, {
          action: "task_status",
          localSessionId: session.localSessionId,
        });
      } catch {
        // The server can be stopped or still run an older control protocol
        // while a safe restart is pending. Preserve the local read-only fallback.
      }
      if (response) {
        ensureOk(response);
        live = response.data as TaskStatusControlData;
      }
      const statusSession = live?.session ?? session;
      const snapshot = live?.snapshot
        ?? (statusSession.lastTurnId ? store.getTurnSnapshot(statusSession.lastTurnId) : undefined);
      const result = { ...statusSession, snapshot, ...(live?.remote ? { remote: live.remote } : {}) };
      if (rest.includes("--json")) printJson(result);
      else printTaskStatus(statusSession, snapshot, live?.remote);
      return;
    }
    const endpoint = controlEndpoint(config.storage.sqlitePath);
    if (action === "stop") {
      printResponse(await sendControlRequest(endpoint, { action: "task_stop", localSessionId: session.localSessionId }));
      return;
    }
    if (action === "title") {
      const referenceIndex = rest.indexOf(reference);
      const titleArgs = rest.slice(referenceIndex + 1);
      const optionIndex = titleArgs.findIndex((value) => value.startsWith("--"));
      const title = titleArgs.slice(0, optionIndex < 0 ? undefined : optionIndex).join(" ").trim();
      if (!title) throw new Error("task title 需要新标题。");
      printResponse(await sendControlRequest(endpoint, {
        action: "task_title",
        localSessionId: session.localSessionId,
        title,
      }));
      return;
    }
    throw new Error(`未知 task 命令：${action}`);
  } finally {
    store.close();
  }
}

function parseGlobalOptions(input: string[]): { configPath?: string; args: string[] } {
  const args = [...input];
  const configIndex = args.indexOf("--config");
  if (configIndex < 0) return { args };
  const configPath = args[configIndex + 1];
  if (!configPath) throw new Error("--config 需要配置文件路径。");
  args.splice(configIndex, 2);
  return { configPath, args };
}

function filterSessions(sessions: SessionRecord[], args: string[]): SessionRecord[] {
  const context = optionValue(args, "--context");
  const status = optionValue(args, "--status");
  return sessions.filter((session) =>
    (!context || session.contextKey === context)
    && (!status || session.status === status || session.lastTurnStatus === status));
}

function resolveTask(sessions: SessionRecord[], reference: string): SessionRecord {
  if (/^\d+$/.test(reference)) {
    const index = Number(reference) - 1;
    const session = sessions[index];
    if (!session) throw new Error(`任务序号超出范围：${reference}`);
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
  if (matches.length > 1) throw new Error(`任务 ID 前缀不唯一：${reference}`);
  throw new Error(`找不到任务：${reference}`);
}

function printTaskList(sessions: SessionRecord[]): void {
  if (sessions.length === 0) {
    process.stdout.write("没有任务。\n");
    return;
  }
  for (const [index, session] of sessions.entries()) {
    const id = session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId;
    process.stdout.write(`${index + 1}. [${session.status}/${session.lastTurnStatus ?? "-"}] ${session.title ?? "未命名任务"}\n`);
    process.stdout.write(`   ${id} · ${session.contextKey} · ${session.updatedAt}\n`);
  }
}

function printTaskStatus(session: SessionRecord, snapshot: unknown, remote?: TaskStatusControlData["remote"]): void {
  process.stdout.write(`标题：${session.title ?? "未命名任务"}\n`);
  process.stdout.write(`任务 ID：${session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId}\n`);
  process.stdout.write(`本地 ID：${session.localSessionId}\n`);
  process.stdout.write(`上下文：${session.contextKey}\n`);
  process.stdout.write(`状态：${session.status} / ${session.lastTurnStatus ?? "-"}\n`);
  process.stdout.write(`目录：${session.cwd}\n`);
  process.stdout.write(`最后轮次：${session.lastTurnId ?? "-"}\n`);
  let displayedFinalResponse: string | undefined;
  if (snapshot && typeof snapshot === "object") {
    const state = snapshot as Record<string, unknown>;
    if (typeof state.durationMs === "number") process.stdout.write(`耗时：${Math.round(state.durationMs / 1_000)}s\n`);
    if (typeof state.totalTokens === "number") process.stdout.write(`Tokens：${state.totalTokens}\n`);
    if (typeof state.totalToolCount === "number") process.stdout.write(`工具调用：${state.totalToolCount}\n`);
    if (typeof state.finalResponse === "string" && state.finalResponse.trim()) displayedFinalResponse = state.finalResponse.trim();
  }
  if (!snapshot && remote?.lastTurnToolCount !== undefined) process.stdout.write(`工具调用：${remote.lastTurnToolCount}\n`);
  displayedFinalResponse = remote?.finalResponse?.trim() || displayedFinalResponse;
  if (displayedFinalResponse) process.stdout.write(`最终结果：\n${displayedFinalResponse}\n`);
}

function printServerStatus(data: unknown): void {
  const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const activity = value.activity && typeof value.activity === "object"
    ? value.activity as Record<string, unknown>
    : {};
  process.stdout.write("acp-bot server：运行中\n");
  process.stdout.write(`PID：${value.pid ?? "-"}\n`);
  process.stdout.write(`启动时间：${value.startedAt ?? "-"}\n`);
  process.stdout.write(`Supervisor：${value.supervised ? "已启用" : "未启用"}\n`);
  process.stdout.write(`运行任务：${activity.runningSessions ?? 0}\n`);
  process.stdout.write(`待投递结果：${activity.pendingFinalDeliveries ?? 0}\n`);
  process.stdout.write(`安全重启：${value.safeRestartScheduled ? `等待中（${value.safeRestartReason ?? "未注明原因"}）` : "未安排"}\n`);
}

function printSkillStatus(status: SkillRegistrationStatus): void {
  process.stdout.write(`acp-bot Skill：${status.registered ? "已注册" : "未注册"}\n`);
  process.stdout.write(`系统目录：${status.skillsRoot}\n`);
  process.stdout.write(`注册位置：${status.targetPath}\n`);
  if (status.registered) {
    process.stdout.write(`归属：${status.managed ? "由 acp-bot 管理" : "外部目录（不会覆盖或删除）"}\n`);
    process.stdout.write(`版本：${status.upToDate ? "最新" : "需要更新"}\n`);
  }
}

function printResponse(response: ControlResponse): void {
  ensureOk(response);
  process.stdout.write(`${response.message ?? "操作成功。"}\n`);
}

function ensureOk(response: ControlResponse): void {
  if (!response.ok) throw new Error(response.message ?? "acp-bot 控制操作失败。");
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function waitForServer(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerRunning(endpoint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`acp-bot 命令行工具

用法：
  acp-bot [--config <path>] console [--force]
  acp-bot [--config <path>] server status [--json]
  acp-bot [--config <path>] server start
  acp-bot [--config <path>] server stop
  acp-bot [--config <path>] server restart [--safe | --immediate] [--reason <text>]
  acp-bot [--config <path>] task list [--context <key>] [--status <status>] [--json]
  acp-bot [--config <path>] task status <序号|任务ID> [--json]
  acp-bot [--config <path>] task stop <序号|任务ID>
  acp-bot [--config <path>] task title <序号|任务ID> <新标题>
  acp-bot [--config <path>] task prompt <序号|任务ID> <prompt>
  acp-bot skills status [--json] [--target <skills目录>]
  acp-bot skills install|register [--json] [--target <skills目录>]
  acp-bot skills uninstall|unregister [--json] [--target <skills目录>]
  acp-bot skills path [--json] [--target <skills目录>]

说明：
  server restart 默认执行安全重启；等待全部任务完成、结果投递完成且连续 15 秒无新消息。
  --immediate（或 --force）跳过空闲等待并立即重启 worker。
  task 序号来自 task list 当前排序；任务管理操作通过运行中 server 执行。
  task prompt 不切换任务；机器人先在原会话显示 Prompt，再提交任务，响应继续发送到该会话。
  skills 默认注册到系统通用 ~/.agents/skills 目录；ACP_BOT_SKILLS_DIR 可修改默认目录。
`);
}
