#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { loadConfig } from "./config/loadConfig.js";
import { sendControlRequest, isServerReachable, isServerRunning } from "./cli/LocalControlClient.js";
import {
  controlEndpoint,
  type ControlResponse,
  type TaskStatusControlData,
} from "./cli/controlProtocol.js";
import {
  acquireInitializationLock,
  cleanupFeishuCredentialTemporaryFiles,
  initializeAgentBot,
  readFeishuCredentials,
  shouldCreateFeishuApp,
  writeFeishuCredentials,
  type InitializationResult,
  type InitializationStatus,
} from "./cli/Initializer.js";
import {
  registerFeishuApp,
  type FeishuAppCredentials,
  type FeishuAppRegistrationChallenge,
} from "./cli/FeishuAppRegistration.js";
import {
  ensureFeishuAppConfiguration,
  type EnsureFeishuAppConfigurationResult,
  type FeishuConfigurationChallenge,
} from "./cli/FeishuAppConfiguration.js";
import { renderCliHelp } from "./cli/help.js";
import { requireServerFeishuTransport } from "./feishu/transport.js";
import { resolveSystemSkillsRoot, SkillRegistry, type SkillRegistrationStatus } from "./cli/SkillRegistry.js";
import { readPackageVersion } from "./cli/packageVersion.js";
import { applyExplicitProfile, parseGlobalOptions } from "./cli/profile.js";
import { taskChatRoute } from "./cli/taskChatRoute.js";
import { StateStore, type SessionRecord } from "./state/StateStore.js";

const args = process.argv.slice(2);

void main(args).catch((error: unknown) => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(input: string[]): Promise<void> {
  const parsed = parseGlobalOptions(input);
  if (parsed.profilePath) applyExplicitProfile(parsed.profilePath);
  else if (parsed.configPath) process.env.AGENT_BOT_CONFIG = parsed.configPath;
  const [command, ...rest] = parsed.args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (command === "init") {
    await initCommand(rest, parsed.configPath);
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
  throw new Error(`未知命令：${command}。使用 agent-bot --help 查看帮助。`);
}

type FeishuInitializationStatus = "created" | "existing" | "skipped";

interface InitCommandResult extends InitializationResult {
  feishu: {
    status: FeishuInitializationStatus;
    appId?: string;
    configuration?: EnsureFeishuAppConfigurationResult;
  };
}

async function initCommand(input: string[], configPath?: string): Promise<void> {
  const supported = new Set(["--json", "--skip-feishu", "--reconfigure-feishu"]);
  const unsupported = input.filter((value) => !supported.has(value));
  if (unsupported.length > 0) throw new Error(`init 不支持参数：${unsupported.join(" ")}`);
  const json = input.includes("--json");
  const skipFeishu = input.includes("--skip-feishu");
  const reconfigureFeishu = input.includes("--reconfigure-feishu");
  if (skipFeishu && reconfigureFeishu) {
    throw new Error("--skip-feishu 和 --reconfigure-feishu 不能同时使用。");
  }

  const paths = initializeAgentBot({ configPath });
  if (!json) printInitializationPaths(paths);
  const initializationLock = acquireInitializationLock(paths.home.path);

  try {
    cleanupFeishuCredentialTemporaryFiles(paths.env.path);
    const feishu = await initializeFeishu(
      paths,
      { json, skipFeishu, reconfigureFeishu },
    );
    const result: InitCommandResult = { ...paths, feishu };
    if (json) printJson(result);
    else printInitializationResult(result);
  } finally {
    initializationLock.release();
  }
}

async function initializeFeishu(
  paths: InitializationResult,
  options: { json: boolean; skipFeishu: boolean; reconfigureFeishu: boolean },
): Promise<InitCommandResult["feishu"]> {
  const existing = readFeishuCredentials(paths.env.path);
  if (options.skipFeishu) {
    return {
      status: "skipped",
      ...(existing.appId ? { appId: existing.appId } : {}),
    };
  }

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort(new Error("已取消初始化。"));
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    let credentials: FeishuAppCredentials;
    let status: Exclude<FeishuInitializationStatus, "skipped">;
    if (!shouldCreateFeishuApp(existing, options.reconfigureFeishu)) {
      credentials = {
        appId: existing.appId!,
        appSecret: existing.appSecret!,
        userOpenId: existing.userOpenId,
      };
      status = "existing";
    } else {
      if (existing.status === "incomplete" && !options.json) {
        process.stdout.write("\n检测到未完整保存的飞书凭据，将重新创建机器人。\n");
      }
      credentials = await registerFeishuApp({
        signal: controller.signal,
        onVerification: (challenge) => printFeishuVerification(challenge, options.json),
      });
      writeFeishuCredentials(paths.env.path, credentials);
      status = "created";
    }

    if (!options.json) process.stdout.write("\n正在检查飞书应用权限、事件和回调配置...\n");
    const configuration = await ensureFeishuAppConfiguration(credentials, {
      signal: controller.signal,
      onVerification: (challenge) => printFeishuConfigurationVerification(challenge, options.json),
    });
    return {
      status,
      appId: credentials.appId,
      configuration,
    };
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

function skillsCommand(input: string[]): void {
  const [action = "status", ...rest] = input;
  const sourcePath = fileURLToPath(new URL("../skills/agent-bot/", import.meta.url));
  const targetRoot = optionValue(rest, "--target") ?? resolveSystemSkillsRoot();
  const registry = new SkillRegistry(sourcePath, targetRoot);
  const json = rest.includes("--json");

  if (action === "install" || action === "register") {
    const result = registry.install();
    if (json) printJson(result);
    else process.stdout.write(result.updated
      ? `已注册 Agent Bot Skill：${result.status.targetPath}\n`
      : `Agent Bot Skill 已是最新版本：${result.status.targetPath}\n`);
    return;
  }
  if (action === "uninstall" || action === "unregister") {
    const removed = registry.uninstall();
    if (json) printJson({ removed, targetPath: registry.targetPath });
    else process.stdout.write(removed
      ? `已反注册 Agent Bot Skill：${registry.targetPath}\n`
      : `Agent Bot Skill 尚未注册：${registry.targetPath}\n`);
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
  if (!force && await isServerReachable(endpoint)) {
    throw new Error("agent-bot server 正在运行。为避免争用同一任务状态，请先停止 server，或明确使用 --force。");
  }
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, AGENT_BOT_CONSOLE_ONLY: "1" },
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
      else process.stdout.write("agent-bot server：未运行\n");
      process.exitCode = 3;
    }
    return;
  }
  if (action === "start") {
    requireServerFeishuTransport(config.feishu);
    if (await isServerRunning(endpoint)) {
      process.stdout.write("agent-bot server 已在运行。\n");
      return;
    }
    if (await isServerReachable(endpoint)) {
      const running = await waitForServer(endpoint, 45_000);
      if (!running) throw new Error("agent-bot server 已启动，但未能连接飞书机器人。请检查日志。");
      process.stdout.write("agent-bot server 已启动。\n");
      return;
    }
    const entry = fileURLToPath(new URL("./supervisor.js", import.meta.url));
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, AGENT_BOT_RESTART_REASON: "通过 agent-bot CLI 启动" },
    });
    child.unref();
    const running = await waitForServer(endpoint, 45_000);
    if (!running) throw new Error("已启动 Supervisor，但 server 未在 45 秒内连接飞书机器人。请检查日志。");
    process.stdout.write("agent-bot server 已启动。\n");
    return;
  }
  if (action === "stop") {
    printResponse(await sendControlRequest(endpoint, { action: "server_stop" }));
    return;
  }
  if (action === "restart") {
    const immediate = rest.includes("--immediate") || rest.includes("--force");
    const reason = optionValue(rest, "--reason")
      ?? (immediate ? "通过 agent-bot CLI 立即重启" : "通过 agent-bot CLI 安全重启");
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
    if (action === "chat") {
      const route = taskChatRoute(session);
      if (rest.includes("--json")) printJson(route);
      else process.stdout.write(`${route.chatId}\n`);
      return;
    }
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
  process.stdout.write(
    value.ready === false
      ? "agent-bot server：启动中（正在连接飞书机器人）\n"
      : "agent-bot server：运行中\n",
  );
  process.stdout.write(`PID：${value.pid ?? "-"}\n`);
  process.stdout.write(`启动时间：${value.startedAt ?? "-"}\n`);
  process.stdout.write(`Supervisor：${value.supervised ? "已启用" : "未启用"}\n`);
  process.stdout.write(`运行任务：${activity.runningSessions ?? 0}\n`);
  process.stdout.write(`待投递结果：${activity.pendingFinalDeliveries ?? 0}\n`);
  process.stdout.write(`安全重启：${value.safeRestartScheduled ? `等待中（${value.safeRestartReason ?? "未注明原因"}）` : "未安排"}\n`);
}

function printSkillStatus(status: SkillRegistrationStatus): void {
  process.stdout.write(`Agent Bot Skill：${status.registered ? "已注册" : "未注册"}\n`);
  process.stdout.write(`系统目录：${status.skillsRoot}\n`);
  process.stdout.write(`注册位置：${status.targetPath}\n`);
  if (status.registered) {
    process.stdout.write(`归属：${status.managed ? "由 Agent Bot 管理" : "外部目录（不会覆盖或删除）"}\n`);
    process.stdout.write(`版本：${status.upToDate ? "最新" : "需要更新"}\n`);
  }
}

function printInitializationPaths(result: InitializationResult): void {
  process.stdout.write("正在准备 Agent Bot 用户环境...\n");
  process.stdout.write(`用户目录：${result.home.path}（${initializationStatusLabel(result.home.status)}）\n`);
  process.stdout.write(`配置文件：${result.config.path}（${initializationStatusLabel(result.config.status)}）\n`);
  process.stdout.write(`环境文件：${result.env.path}（${initializationStatusLabel(result.env.status)}）\n`);
  process.stdout.write(`数据目录：${result.data.path}（${initializationStatusLabel(result.data.status)}）\n`);
  process.stdout.write(`日志目录：${result.logs.path}（${initializationStatusLabel(result.logs.status)}）\n`);
}

function printInitializationResult(result: InitCommandResult): void {
  process.stdout.write("\nAgent Bot 初始化完成。\n");
  if (result.feishu.status === "created") {
    process.stdout.write(`飞书应用：已创建并保存凭证（${result.feishu.appId}）\n`);
  } else if (result.feishu.status === "existing") {
    process.stdout.write(`飞书应用：已配置，未修改（${result.feishu.appId}）\n`);
  } else {
    process.stdout.write("飞书应用：已跳过，可使用 Console 模式或稍后重新运行 init。\n");
  }
  if (result.feishu.configuration?.status === "updated") {
    const added = result.feishu.configuration.added;
    process.stdout.write(
      `飞书配置：已补齐 ${added.scopes.length} 项权限、${added.events.length} 项事件、${added.callbacks.length} 项回调\n`,
    );
  } else if (result.feishu.configuration?.status === "partial") {
    const configuration = result.feishu.configuration;
    const addedCount =
      configuration.added.scopes.length + configuration.added.events.length + configuration.added.callbacks.length;
    if (addedCount > 0) {
      process.stdout.write(
        `飞书配置：核心能力已就绪，已补齐 ${configuration.added.scopes.length} 项权限、${configuration.added.events.length} 项事件、${configuration.added.callbacks.length} 项回调\n`,
      );
    } else {
      process.stdout.write("飞书配置：核心能力已就绪\n");
    }
    printOptionalFeishuConfigurationWarnings(configuration.remaining);
  } else if (result.feishu.configuration?.status === "ready") {
    process.stdout.write("飞书配置：权限、事件和回调均已就绪\n");
  }
  process.stdout.write(`配置文件：${result.config.path}\n`);
  process.stdout.write("下一步：运行 agent-bot server start。\n");
}

function printFeishuVerification(challenge: FeishuAppRegistrationChallenge, json: boolean): void {
  process.stderr.write("\n请使用飞书扫码，或在浏览器中打开下面的链接创建机器人应用：\n\n");
  process.stderr.write(`${challenge.verificationUrl}\n\n`);
  if (!json) {
    qrcode.generate(challenge.verificationUrl, { small: true }, (output) => {
      process.stderr.write(`${output}\n`);
    });
  }
  process.stderr.write(`链接约在 ${Math.ceil(challenge.expiresIn / 60)} 分钟后过期，正在等待确认...\n`);
}

function printFeishuConfigurationVerification(
  challenge: FeishuConfigurationChallenge,
  json: boolean,
): void {
  process.stderr.write("\n飞书应用还缺少以下配置：\n");
  if (challenge.missing.scopes.length > 0) {
    process.stderr.write(`权限：${challenge.missing.scopes.join(", ")}\n`);
  }
  if (challenge.missing.events.length > 0) {
    process.stderr.write(`事件：${challenge.missing.events.join(", ")}\n`);
  }
  if (challenge.missing.callbacks.length > 0) {
    process.stderr.write(`回调：${challenge.missing.callbacks.join(", ")}\n`);
  }
  process.stderr.write("\n请使用飞书扫码，或在浏览器中打开下面的链接补齐配置：\n\n");
  process.stderr.write(`${challenge.verificationUrl}\n\n`);
  if (!json) {
    qrcode.generate(challenge.verificationUrl, { small: true }, (output) => {
      process.stderr.write(`${output}\n`);
    });
  }
  if (challenge.blocking) {
    process.stderr.write("正在等待核心权限和消息事件发布生效...\n");
  } else {
    process.stderr.write("以上配置不影响基础消息收发；初始化将继续，可稍后打开链接授权。\n");
  }
}

function printOptionalFeishuConfigurationWarnings(missing: FeishuConfigurationChallenge["missing"]): void {
  process.stdout.write("提醒：以下非核心配置尚未生效，部分功能可能不可用。\n");
  if (missing.scopes.length > 0) {
    process.stdout.write(`未生效权限：${missing.scopes.join(", ")}\n`);
  }
  if (missing.events.length > 0) {
    process.stdout.write(`未生效事件：${missing.events.join(", ")}\n`);
  }
  if (missing.callbacks.length > 0) {
    process.stdout.write(`未生效回调：${missing.callbacks.join(", ")}\n`);
  }
  for (const feature of optionalFeishuFeatureWarnings(missing)) {
    process.stdout.write(`可能缺失功能：${feature}\n`);
  }
}

function optionalFeishuFeatureWarnings(missing: FeishuConfigurationChallenge["missing"]): string[] {
  const scopes = new Set(missing.scopes);
  const events = new Set(missing.events);
  const callbacks = new Set(missing.callbacks);
  const warnings: string[] = [];
  if (scopes.has("im:chat:create")) {
    warnings.push("无法使用 /newgroup 和 /forkgroup 创建飞书群");
  }
  if (scopes.has("im:chat:read") || events.has("im.chat.updated_v1")) {
    warnings.push("修改飞书群名称时无法同步 Agent Bot 任务标题");
  }
  if (scopes.has("im:message.reactions:write_only")) {
    warnings.push("无法用表情显示消息处理状态");
  }
  if (scopes.has("im:message:readonly")) {
    warnings.push("可能无法读取用户消息中的图片");
  }
  if (scopes.has("im:resource")) {
    warnings.push("可能无法上传图片、发送本地图片或设置群头像");
  }
  if (scopes.has("im:message:update")) {
    warnings.push("可能无法更新已发送的进度卡片");
  }
  if (callbacks.has("card.action.trigger")) {
    warnings.push("卡片按钮和交互操作不可用");
  }
  return warnings;
}

function initializationStatusLabel(status: InitializationStatus): string {
  if (status === "created") return "已创建";
  return "已存在，未修改";
}

function printResponse(response: ControlResponse): void {
  ensureOk(response);
  process.stdout.write(`${response.message ?? "操作成功。"}\n`);
}

function ensureOk(response: ControlResponse): void {
  if (!response.ok) throw new Error(response.message ?? "Agent Bot 控制操作失败。");
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
  process.stdout.write(renderCliHelp(readPackageVersion()));
}
