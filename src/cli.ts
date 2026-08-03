#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { loadConfig, loadConfigWithoutEnvironmentMutation } from "./config/loadConfig.js";
import { sendControlRequest, isServerReachable } from "./cli/LocalControlClient.js";
import {
  controlEndpoint,
  type ControlResponse,
  type TaskGroupControlData,
  type TaskStatusControlData,
} from "./cli/controlProtocol.js";
import {
  acquireInitializationLock,
  cleanupFeishuCredentialTemporaryFiles,
  initializeAgentBot,
  readConfiguredAgentSelection,
  readFeishuCredentials,
  shouldCreateFeishuApp,
  writeDefaultAgent,
  writeFeishuCredentials,
  type InitializationResult,
  type InitializationStatus,
} from "./cli/Initializer.js";
import { parseInitCommandOptions, type InitCommandOptions } from "./cli/initOptions.js";
import {
  listenForManualPermissionSkip,
  listenForOptionalAuthorizationSkip,
  type OptionalAuthorizationSkipListener,
} from "./cli/OptionalAuthorizationSkip.js";
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
import { cliLanguage, cliText, localizeCliErrorMessage } from "./cli/i18n.js";
import {
  inspectSupportedAgent,
  inspectSupportedAgents,
  runSupportedAgentMaintenance,
  type SupportedAgentInspection,
} from "./cli/AgentPrerequisites.js";
import {
  parseMaintenanceSelection,
  resolveDefaultAgentChoice,
  selectableDefaultAgents,
  type SelectableDefaultAgent,
} from "./cli/DefaultAgentSelection.js";
import { formatServerStatus, withConfiguredFeishuAppId } from "./cli/serverStatus.js";
import { resolveSystemSkillsRoot, SkillRegistry, type SkillRegistrationStatus } from "./cli/SkillRegistry.js";
import { readPackageVersion } from "./cli/packageVersion.js";
import { applyExplicitProfile, parseGlobalOptions } from "./cli/profile.js";
import { printVerificationQrAndLink } from "./cli/VerificationOutput.js";
import {
  startInitializedServer,
  startServer,
  type InitializationServerResult,
  type ServerStartResult,
} from "./cli/ServerStarter.js";
import { taskChatRoute } from "./cli/taskChatRoute.js";
import { isThreadContextKey } from "./feishu/contextKey.js";
import { refreshedSystemEnvironment } from "./supervision/systemEnvironment.js";
import {
  parseTaskForkGroupOptions,
  parseTaskNewGroupOptions,
} from "./cli/taskGroupOptions.js";
import { StateStore, type SessionRecord } from "./state/StateStore.js";
import {
  nodeDiagnosticReportArguments,
  prepareCrashReportDirectory,
  resolveSupervisorDiagnosticsPaths,
} from "./supervision/SupervisorDiagnostics.js";
import { agentBotHome, defaultSqlitePath } from "./config/paths.js";

const args = process.argv.slice(2);

void main(args).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${cliText("Error: ", "错误：")}${localizeCliErrorMessage(message)}\n`);
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
    await initCommand(rest, parsed.configPath, Boolean(parsed.profilePath));
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
  throw new Error(cliText(
    `Unknown command: ${command}. Run agentbot --help for usage.`,
    `未知命令：${command}。运行 agentbot --help 查看用法。`,
  ));
}

type FeishuInitializationStatus = "created" | "existing" | "skipped";

interface InitCommandResult extends InitializationResult {
  agents: InitializedAgent[];
  defaultAgent: {
    name: string;
    status: "selected" | "existing";
  };
  feishu: {
    status: FeishuInitializationStatus;
    appId?: string;
    userOpenIdStatus?: "configured" | "pending";
    configuration?: EnsureFeishuAppConfigurationResult;
  };
  server: InitializationServerResult;
}

interface InitializedAgent extends SupportedAgentInspection {
  assistance?: {
    status: "completed" | "skipped" | "unavailable" | "failed";
    error?: string;
  };
}

async function initCommand(
  input: string[],
  configPath: string | undefined,
  explicitProfile: boolean,
): Promise<void> {
  const options = parseInitCommandOptions(input, explicitProfile);
  let initializationLock = options.reset
    ? acquireInitializationLock(agentBotHome())
    : undefined;
  let paths: InitializationResult;
  let initialized: Omit<InitCommandResult, "server">;
  try {
    if (options.reset) await assertResetProfileServerStopped(configPath);
    paths = initializeAgentBot({ configPath, reset: options.reset });
    if (!options.json) printInitializationPaths(paths);
    const agents = await initializeSupportedAgents(options.json);
    const defaultAgent = await selectDefaultAgent(paths.config.path, agents, options.json);
    initializationLock ??= acquireInitializationLock(paths.home.path);
    cleanupFeishuCredentialTemporaryFiles(paths.env.path);
    const feishu = await initializeFeishu(
      paths,
      options,
    );
    initialized = { ...paths, agents, defaultAgent, feishu };
  } finally {
    initializationLock?.release();
  }

  if (!options.json) printInitializationResult(initialized);
  if (!options.json && !options.skipFeishu) {
    process.stdout.write(cliText("\nStarting Agent Bot server...\n", "\n正在启动 Agent Bot 服务...\n"));
  }
  const server = await startInitializedServer({ skipFeishu: options.skipFeishu, configPath });
  const result: InitCommandResult = { ...initialized, server };
  if (options.json) printJson(result);
  else printInitializationServerResult(server);
}

async function initializeSupportedAgents(json: boolean): Promise<InitializedAgent[]> {
  const output = json ? process.stderr : process.stdout;
  output.write(cliText(
    "\nAgent setup\nChecking Codex and TraeX...\n",
    "\nAgent 设置\n正在检查 Codex 和 TraeX...\n",
  ));
  const inspections = await inspectSupportedAgents();
  for (const inspection of inspections) printAgentInspection(inspection, output);
  const actionable = inspections.filter((inspection) => inspection.action);
  if (actionable.length === 0) return inspections;

  output.write(cliText("\nAvailable actions:\n", "\n可执行的操作：\n"));
  for (const [index, inspection] of actionable.entries()) {
    output.write(cliText(
      `  ${index + 1}. ${inspection.action?.kind === "install" ? "Install" : "Upgrade"} ${inspection.name}: ${inspection.action?.command}\n`,
      `  ${index + 1}. ${inspection.action?.kind === "install" ? "安装" : "升级"} ${inspection.name}：${inspection.action?.command}\n`,
    ));
  }

  let selected = new Set<number>();
  if (!process.stdin.isTTY) {
    output.write(cliText(
      "No interactive terminal is available. Run the commands above manually if needed.\n",
      "当前没有交互式终端，如有需要请手动执行上面的命令。\n",
    ));
  } else {
    selected = new Set(await promptForAgentMaintenance(actionable.length));
    if (selected.size === 0) {
      output.write(cliText("No Agent changes selected.\n", "已跳过 Agent 安装和升级。\n"));
    }
  }

  const initialized: InitializedAgent[] = [];
  for (const inspection of inspections) {
    if (!inspection.action) {
      initialized.push(inspection);
      continue;
    }
    const actionIndex = actionable.indexOf(inspection);
    if (!selected.has(actionIndex)) {
      initialized.push({
        ...inspection,
        assistance: { status: process.stdin.isTTY ? "skipped" : "unavailable" },
      });
      continue;
    }

    output.write(cliText(
      `\nRunning ${inspection.name} ${inspection.action.kind}: ${inspection.action.command}\n`,
      `\n正在${inspection.action.kind === "install" ? "安装" : "升级"} ${inspection.name}：${inspection.action.command}\n`,
    ));
    const maintenance = await runSupportedAgentMaintenance(inspection.id, inspection.action.kind);
    if (maintenance.status !== 0 || maintenance.error) {
      const error = maintenance.error ?? cliText(
        `Command exited with code ${maintenance.status ?? "unknown"}.`,
        `命令退出码为 ${maintenance.status ?? "未知"}。`,
      );
      output.write(cliText(
        `${inspection.name} ${inspection.action.kind} did not complete; initialization will continue.\n`,
        `${inspection.name}${inspection.action.kind === "install" ? "安装" : "升级"}未完成，初始化将继续。\n`,
      ));
      initialized.push({ ...inspection, assistance: { status: "failed", error } });
      continue;
    }

    refreshCurrentProcessPath();
    const refreshed = await inspectSupportedAgent(inspection.id);
    if (refreshed.installedVersion) {
      output.write(cliText(
        `${inspection.name} is ready (${refreshed.installedVersion}).\n`,
        `${inspection.name} 已就绪（${refreshed.installedVersion}）。\n`,
      ));
    } else {
      output.write(cliText(
        `${inspection.name} command completed, but the CLI is not visible in this process. Open a new terminal and run agentbot init again.\n`,
        `${inspection.name} 命令已完成，但当前进程仍无法找到该 CLI。请打开新终端后重新运行 agentbot init。\n`,
      ));
    }
    initialized.push({ ...refreshed, assistance: { status: "completed" } });
  }
  return initialized;
}

async function selectDefaultAgent(
  configPath: string,
  inspections: InitializedAgent[],
  json: boolean,
): Promise<InitCommandResult["defaultAgent"]> {
  const output = json ? process.stderr : process.stdout;
  const configured = readConfiguredAgentSelection(configPath);
  const choices = selectableDefaultAgents(configured.agents, inspections);
  if (!process.stdin.isTTY) {
    if (!configured.defaultAgent || !configured.agents.some((agent) => agent.name === configured.defaultAgent)) {
      throw new Error(cliText(
        "A default Agent is not configured. Run agentbot init in an interactive terminal and select one.",
        "尚未配置默认 Agent。请在交互式终端中运行 agentbot init 并选择一个 Agent。",
      ));
    }
    output.write(cliText(
      `Default Agent: ${configured.defaultAgent} (kept because no interactive terminal is available)\n`,
      `默认 Agent：${configured.defaultAgent}（当前没有交互式终端，已保留现有设置）\n`,
    ));
    return { name: configured.defaultAgent, status: "existing" };
  }
  if (choices.length === 0) {
    throw new Error(cliText(
      "No available configured Agent can be selected. Install Codex or TraeX, then run agentbot init again.",
      "没有可选择的已配置 Agent。请安装 Codex 或 TraeX，然后重新运行 agentbot init。",
    ));
  }

  output.write(cliText("\nSelect the default Agent:\n", "\n请选择默认 Agent：\n"));
  for (const [index, choice] of choices.entries()) {
    const version = choice.installedVersion ? ` (${choice.installedVersion})` : "";
    const current = choice.name === configured.defaultAgent
      ? cliText(" [current]", " [当前]")
      : "";
    output.write(`  ${index + 1}. ${choice.name} - ${choice.title}${version}${current}\n`);
  }
  const selected = choices[await promptForDefaultAgent(choices, configured.defaultAgent)];
  if (!selected) throw new Error(cliText("Default Agent selection failed.", "默认 Agent 选择失败。"));
  const updated = writeDefaultAgent(configPath, selected.name);
  output.write(updated
    ? cliText(`Saved default Agent: ${selected.name}\n`, `已保存默认 Agent：${selected.name}\n`)
    : cliText(`Default Agent unchanged: ${selected.name}\n`, `默认 Agent 保持不变：${selected.name}\n`));
  return { name: selected.name, status: updated ? "selected" : "existing" };
}

function promptForAgentMaintenance(choiceCount: number): Promise<number[]> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (selection: number[]): void => {
      settled = true;
      readline.close();
      resolve(selection);
    };
    const ask = (): void => {
      readline.question(cliText(
        "Enter action numbers separated by commas, type all, or press Enter to skip: ",
        "请输入要执行的操作编号（多个用逗号分隔），输入 all 选择全部，直接回车跳过：",
      ), (answer) => {
        const selection = parseMaintenanceSelection(answer, choiceCount);
        if (selection) {
          finish(selection);
          return;
        }
        process.stderr.write(cliText(
          `Enter numbers from 1 to ${choiceCount}, all, or press Enter to skip.\n`,
          `请输入 1 到 ${choiceCount} 之间的编号、all，或直接回车跳过。\n`,
        ));
        ask();
      });
    };
    listenForPromptCancellation(readline, () => {
      settled = true;
      reject(new Error(cliText("Initialization was cancelled.", "初始化已取消。")));
    }, () => settled);
    ask();
  });
}

function promptForDefaultAgent(
  choices: SelectableDefaultAgent[],
  currentAgent?: string,
): Promise<number> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (index: number): void => {
      settled = true;
      readline.close();
      resolve(index);
    };
    const ask = (): void => {
      const currentAvailable = choices.some((choice) => choice.name === currentAgent);
      readline.question(cliText(
        `Enter a number or Agent name${currentAvailable ? ` [${currentAgent}]` : ""}: `,
        `请输入编号或 Agent 标准名${currentAvailable ? ` [${currentAgent}]` : ""}：`,
      ), (answer) => {
        const index = resolveDefaultAgentChoice(answer, choices, currentAgent);
        if (index !== undefined) {
          finish(index);
          return;
        }
        process.stderr.write(cliText(
          `Enter a number from 1 to ${choices.length} or an Agent standard name.\n`,
          `请输入 1 到 ${choices.length} 之间的编号，或 Agent 标准名。\n`,
        ));
        ask();
      });
    };
    listenForPromptCancellation(readline, () => {
      settled = true;
      reject(new Error(cliText("Initialization was cancelled.", "初始化已取消。")));
    }, () => settled);
    ask();
  });
}

function listenForPromptCancellation(
  readline: ReturnType<typeof createInterface>,
  cancel: () => void,
  isSettled: () => boolean,
): void {
  readline.once("SIGINT", () => {
    if (!isSettled()) cancel();
    readline.close();
  });
  readline.once("close", () => {
    if (!isSettled()) cancel();
  });
}

function printAgentInspection(
  inspection: SupportedAgentInspection,
  output: NodeJS.WriteStream,
): void {
  if (inspection.state === "missing") {
    output.write(cliText(
      `  ${inspection.name}: not installed\n`,
      `  ${inspection.name}：未安装\n`,
    ));
    return;
  }
  if (inspection.state === "outdated") {
    output.write(cliText(
      `  ${inspection.name}: ${inspection.installedVersion}; update available (${inspection.latestVersion})\n`,
      `  ${inspection.name}：${inspection.installedVersion}；可升级到 ${inspection.latestVersion}\n`,
    ));
    return;
  }
  if (inspection.latestCheckFailed) {
    output.write(cliText(
      `  ${inspection.name}: ${inspection.installedVersion}; latest-version check unavailable\n`,
      `  ${inspection.name}：${inspection.installedVersion}；无法检查最新版本\n`,
    ));
    return;
  }
  output.write(cliText(
    `  ${inspection.name}: ${inspection.installedVersion} (up to date)\n`,
    `  ${inspection.name}：${inspection.installedVersion}（已是最新）\n`,
  ));
}

function refreshCurrentProcessPath(): void {
  const refreshed = refreshedSystemEnvironment();
  if (!refreshed.refreshed) return;
  const pathEntry = Object.entries(refreshed.environment)
    .find(([name]) => name.toLowerCase() === "path");
  if (pathEntry?.[1]) process.env.PATH = pathEntry[1];
}

async function initializeFeishu(
  paths: InitializationResult,
  options: InitCommandOptions,
): Promise<InitCommandResult["feishu"]> {
  const existing = readFeishuCredentials(paths.env.path);
  if (options.skipFeishu) {
    return {
      status: "skipped",
      ...(existing.appId ? { appId: existing.appId } : {}),
      ...(existing.appId && existing.appSecret
        ? { userOpenIdStatus: existing.userOpenId ? "configured" as const : "pending" as const }
        : {}),
    };
  }
  if (!options.json) {
    process.stdout.write(cliText("\nLark setup\n", "\n飞书设置\n"));
  }

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort(new Error(cliText(
    "Initialization was cancelled.",
    "初始化已取消。",
  )));
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
        process.stdout.write(cliText(
          "\nIncomplete Lark credentials were found. A new bot will be created.\n",
          "\n发现不完整的飞书凭据，将创建一个新机器人。\n",
        ));
      }
      credentials = await registerFeishuApp({
        signal: controller.signal,
        onVerification: (challenge) => printFeishuVerification(challenge, options.json),
      });
      writeFeishuCredentials(paths.env.path, credentials);
      status = "created";
    }

    if (!options.json) {
      process.stdout.write(cliText(
        "Checking app permissions, events, and callbacks...\n",
        "正在检查应用权限、事件和回调...\n",
      ));
    }
    const manualPermissionSkip = new AbortController();
    const optionalSkip = new AbortController();
    let skipListener: OptionalAuthorizationSkipListener | undefined;
    const configuration = await ensureFeishuAppConfiguration(credentials, {
      signal: controller.signal,
      manualPermissionSkipSignal: manualPermissionSkip.signal,
      optionalSkipSignal: optionalSkip.signal,
      onVerification: (challenge) => {
        printFeishuConfigurationVerification(challenge, options.json);
        if (challenge.kind === "manual_scope" && challenge.blocking) {
          skipListener?.close();
          skipListener = listenForManualPermissionSkip(() => manualPermissionSkip.abort());
        } else if (!challenge.blocking) {
          skipListener?.close();
          skipListener = listenForOptionalAuthorizationSkip(() => optionalSkip.abort());
        }
      },
    }).finally(() => skipListener?.close());
    return {
      status,
      appId: credentials.appId,
      userOpenIdStatus: credentials.userOpenId ? "configured" : "pending",
      configuration,
    };
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

async function assertResetProfileServerStopped(configPath?: string): Promise<void> {
  const endpoints = new Set<string>([controlEndpoint(defaultSqlitePath())]);
  const selectedConfigPath = configPath ?? process.env.AGENT_BOT_CONFIG;
  if (selectedConfigPath && fs.existsSync(selectedConfigPath)) {
    try {
      endpoints.add(controlEndpoint(
        loadConfigWithoutEnvironmentMutation(selectedConfigPath).storage.sqlitePath,
      ));
    } catch {
      // Reset must remain available when the existing configuration is invalid.
    }
  }
  for (const endpoint of endpoints) {
    if (await isServerReachable(endpoint)) {
      throw new Error(
        cliText(
          "Cannot reset a running profile. Stop it with agentbot --profile <directory> server stop, then try again.",
          "无法重置正在运行的 Profile。请先执行 agentbot --profile <目录> server stop，然后重试。",
        ),
      );
    }
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
      ? cliText(
          `Installed the Agent Bot Skill: ${result.status.targetPath}\n`,
          `已安装 Agent Bot Skill：${result.status.targetPath}\n`,
        )
      : cliText(
          `The Agent Bot Skill is already up to date: ${result.status.targetPath}\n`,
          `Agent Bot Skill 已是最新版本：${result.status.targetPath}\n`,
        ));
    return;
  }
  if (action === "uninstall" || action === "unregister") {
    const removed = registry.uninstall();
    if (json) printJson({ removed, targetPath: registry.targetPath });
    else process.stdout.write(removed
      ? cliText(
          `Uninstalled the Agent Bot Skill: ${registry.targetPath}\n`,
          `已卸载 Agent Bot Skill：${registry.targetPath}\n`,
        )
      : cliText(
          `The Agent Bot Skill is not installed: ${registry.targetPath}\n`,
          `Agent Bot Skill 尚未安装：${registry.targetPath}\n`,
        ));
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
      process.stdout.write(`${cliText("Built-in Skill: ", "内置 Skill：")}${paths.sourcePath}\n`);
      process.stdout.write(`${cliText("System Skills directory: ", "系统 Skills 目录：")}${paths.skillsRoot}\n`);
      process.stdout.write(`${cliText("Installation path: ", "安装路径：")}${paths.targetPath}\n`);
    }
    return;
  }
  throw new Error(cliText(`Unknown skills command: ${action}`, `未知的 skills 命令：${action}`));
}

async function consoleCommand(input: string[]): Promise<void> {
  const config = loadConfig();
  const endpoint = controlEndpoint(config.storage.sqlitePath);
  const force = input.includes("--force");
  if (!force && await isServerReachable(endpoint)) {
    throw new Error(
      cliText(
        "The Agent Bot server is running. Stop it first to avoid concurrent task-state access, or explicitly use --force.",
        "Agent Bot 服务正在运行。请先停止服务以避免并发访问任务状态，或显式使用 --force。",
      ),
    );
  }
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const reportDirectory = resolveSupervisorDiagnosticsPaths(config).crashReportDirectory;
  prepareCrashReportDirectory(reportDirectory);
  const result = spawnSync(process.execPath, [
    ...nodeDiagnosticReportArguments(reportDirectory),
    entry,
  ], {
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
      const status = withConfiguredFeishuAppId(response.data, config.feishu.appId);
      if (rest.includes("--json")) printJson(status);
      else process.stdout.write(formatServerStatus(status));
    } catch {
      const status = {
        running: false,
        feishuAppId: config.feishu.appId ?? null,
      };
      if (rest.includes("--json")) printJson(status);
      else process.stdout.write(formatServerStatus(status));
      process.exitCode = 3;
    }
    return;
  }
  if (action === "start") {
    printServerStartResult(await startServer(config));
    return;
  }
  if (action === "stop") {
    ensureOk(await sendControlRequest(endpoint, { action: "server_stop" }));
    process.stdout.write(cliText("Agent Bot server stop requested.\n", "已请求停止 Agent Bot 服务。\n"));
    return;
  }
  if (action === "restart") {
    const immediate = rest.includes("--immediate") || rest.includes("--force");
    const notificationSessionId = resolveRestartNotificationSessionId(config.storage.sqlitePath, rest);
    const reason = optionValue(rest, "--reason")
      ?? (immediate ? "通过 Agent Bot CLI 立即重启" : "通过 Agent Bot CLI 安全重启");
    ensureOk(await sendControlRequest(endpoint, {
      action: "server_restart",
      mode: immediate ? "immediate" : "safe",
      reason,
      notificationSessionId,
    }));
    process.stdout.write(immediate
      ? cliText("Immediate restart requested.\n", "已请求立即重启。\n")
      : cliText("Safe restart requested.\n", "已请求安全重启。\n"));
    return;
  }
  throw new Error(cliText(`Unknown server command: ${action}`, `未知的 server 命令：${action}`));
}

function resolveRestartNotificationSessionId(sqlitePath: string, args: string[]): string | undefined {
  const store = new StateStore(sqlitePath);
  try {
    const sessions = store.listAllSessions();
    if (args.includes("--task")) {
      const reference = optionValue(args, "--task")?.trim();
      if (!reference || reference.startsWith("--")) throw new Error(cliText(
        "server restart --task requires a task number or task ID.",
        "server restart --task 需要任务序号或任务 ID。",
      ));
      const session = resolveTask(sessions, reference);
      if (
        isThreadContextKey(session.contextKey)
        && !store.findLatestMessageIdForSession(session.localSessionId, session.contextKey)
        && !store.findLatestMessageIdForContext(session.contextKey)
      ) {
        throw new Error(cliText(
          "The task topic has no message anchor for restart notifications. Send /restart in that topic instead.",
          "该任务话题没有可用于重启通知的消息锚点，请直接在该话题中发送 /restart。",
        ));
      }
      return session.localSessionId;
    }
    const runningContexts = new Set(
      sessions.filter((session) => session.status === "running").map((session) => session.contextKey),
    );
    if (runningContexts.size > 1) throw new Error(cliText(
      "Multiple conversations are running. Pass --task <task> so restart notifications return to the requester.",
      "当前有多个会话正在运行。请传入 --task <任务>，确保重启通知返回发起会话。",
    ));
    return undefined;
  } finally {
    store.close();
  }
}

async function taskCommand(input: string[]): Promise<void> {
  const [action = "list", ...rest] = input;
  const config = loadConfig();
  const store = new StateStore(config.storage.sqlitePath);
  try {
    const allSessions = store.listAllSessions();
    if (action === "prompt" || action === "send") {
      const [reference, ...promptParts] = rest;
      if (!reference) throw new Error(cliText(
        `task ${action} requires a task number or task ID.`,
        `task ${action} 需要任务序号或任务 ID。`,
      ));
      const text = promptParts.join(" ").trim();
      if (!text) throw new Error(cliText(
        `task ${action} requires a Prompt.`,
        `task ${action} 需要提示词。`,
      ));
      const session = resolveTask(allSessions, reference);
      const endpoint = controlEndpoint(config.storage.sqlitePath);
      ensureOk(await sendControlRequest(endpoint, {
        action: "task_prompt",
        localSessionId: session.localSessionId,
        text,
      }, 60_000));
      process.stdout.write(cliText("Prompt submitted.\n", "提示词已提交。\n"));
      return;
    }
    if (action === "newgroup") {
      const options = parseTaskNewGroupOptions(rest);
      const session = resolveTask(allSessions, options.reference);
      const targetAgentName = options.agentName ?? session.agentName;
      const targetAgent = config.agents[targetAgentName];
      if (!targetAgent) {
        throw new Error(cliText(
          `Unknown Agent standard name: ${targetAgentName}.`,
          `未知的 Agent 标准名：${targetAgentName}。`,
        ));
      }
      if (options.projectless && targetAgent.kind !== "app-server") {
        throw new Error(cliText(
          "task newgroup --nodir is only available for App Server agents.",
          "task newgroup --nodir 仅适用于 App Server Agent。",
        ));
      }
      requireCliGroupUser(config.feishu.userOpenId);
      const response = await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_new_group",
        localSessionId: session.localSessionId,
        ...(options.title ? { title: options.title } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.projectless ? { projectless: true } : {}),
      }, 120_000);
      const result = taskGroupControlData(response);
      if (options.json) printJson(result);
      else printTaskGroupResult(result, "newgroup");
      return;
    }
    if (action === "forkgroup") {
      const options = parseTaskForkGroupOptions(rest);
      const session = resolveTask(allSessions, options.reference);
      requireCliGroupUser(config.feishu.userOpenId);
      const response = await sendControlRequest(controlEndpoint(config.storage.sqlitePath), {
        action: "task_fork_group",
        localSessionId: session.localSessionId,
        ...(options.title ? { title: options.title } : {}),
      }, 120_000);
      const result = taskGroupControlData(response);
      if (options.json) printJson(result);
      else printTaskGroupResult(result, "forkgroup");
      return;
    }
    const sessions = filterSessions(allSessions, rest);
    if (action === "list") {
      if (rest.includes("--json")) printJson(sessions);
      else printTaskList(sessions);
      return;
    }
    const reference = rest.find((value) => !value.startsWith("--"));
    if (!reference) throw new Error(cliText(
      `task ${action} requires a task number or task ID.`,
      `task ${action} 需要任务序号或任务 ID。`,
    ));
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
      ensureOk(await sendControlRequest(endpoint, { action: "task_stop", localSessionId: session.localSessionId }));
      process.stdout.write(cliText("Task stop requested.\n", "已请求停止任务。\n"));
      return;
    }
    if (action === "title") {
      const referenceIndex = rest.indexOf(reference);
      const titleArgs = rest.slice(referenceIndex + 1);
      const optionIndex = titleArgs.findIndex((value) => value.startsWith("--"));
      const title = titleArgs.slice(0, optionIndex < 0 ? undefined : optionIndex).join(" ").trim();
      if (!title) throw new Error(cliText(
        "task title requires a new title.",
        "task title 需要新标题。",
      ));
      ensureOk(await sendControlRequest(endpoint, {
        action: "task_title",
        localSessionId: session.localSessionId,
        title,
      }));
      process.stdout.write(cliText("Task title updated.\n", "任务标题已更新。\n"));
      return;
    }
    throw new Error(cliText(`Unknown task command: ${action}`, `未知的 task 命令：${action}`));
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
    if (!session) throw new Error(cliText(
      `Task number is out of range: ${reference}`,
      `任务序号超出范围：${reference}`,
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
  ));
  throw new Error(cliText(`Task not found: ${reference}`, `未找到任务：${reference}`));
}

function printTaskList(sessions: SessionRecord[]): void {
  if (sessions.length === 0) {
    process.stdout.write(cliText("No tasks.\n", "没有任务。\n"));
    return;
  }
  for (const [index, session] of sessions.entries()) {
    const id = session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId;
    process.stdout.write(`${index + 1}. [${taskStateLabel(session.status)}/${taskStateLabel(session.lastTurnStatus)}] ${session.title ?? cliText("Untitled task", "未命名任务")}\n`);
    process.stdout.write(`   ${id} · ${session.contextKey} · ${session.updatedAt}\n`);
  }
}

function printTaskStatus(session: SessionRecord, snapshot: unknown, remote?: TaskStatusControlData["remote"]): void {
  process.stdout.write(`${cliText("Title: ", "标题：")}${session.title ?? cliText("Untitled task", "未命名任务")}\n`);
  process.stdout.write(`${cliText("Task ID: ", "任务 ID：")}${session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId}\n`);
  process.stdout.write(`${cliText("Local ID: ", "本地 ID：")}${session.localSessionId}\n`);
  process.stdout.write(`${cliText("Context: ", "上下文：")}${session.contextKey}\n`);
  process.stdout.write(`${cliText("Status: ", "状态：")}${taskStateLabel(session.status)} / ${taskStateLabel(session.lastTurnStatus)}\n`);
  process.stdout.write(`${cliText("Directory: ", "目录：")}${session.cwd}\n`);
  process.stdout.write(`${cliText("Last turn: ", "上一轮：")}${session.lastTurnId ?? "-"}\n`);
  let displayedFinalResponse: string | undefined;
  if (snapshot && typeof snapshot === "object") {
    const state = snapshot as Record<string, unknown>;
    if (typeof state.durationMs === "number") {
      process.stdout.write(`${cliText("Duration: ", "耗时：")}${Math.round(state.durationMs / 1_000)}s\n`);
    }
    if (typeof state.totalTokens === "number") {
      process.stdout.write(`${cliText("Tokens: ", "Tokens：")}${state.totalTokens}\n`);
    }
    if (typeof state.totalToolCount === "number") {
      process.stdout.write(`${cliText("Tool calls: ", "工具调用：")}${state.totalToolCount}\n`);
    }
    if (typeof state.finalResponse === "string" && state.finalResponse.trim()) displayedFinalResponse = state.finalResponse.trim();
  }
  if (!snapshot && remote?.lastTurnToolCount !== undefined) {
    process.stdout.write(`${cliText("Tool calls: ", "工具调用：")}${remote.lastTurnToolCount}\n`);
  }
  displayedFinalResponse = remote?.finalResponse?.trim() || displayedFinalResponse;
  if (displayedFinalResponse) {
    process.stdout.write(`${cliText("Final response:\n", "最终回答：\n")}${displayedFinalResponse}\n`);
  }
}

function printSkillStatus(status: SkillRegistrationStatus): void {
  process.stdout.write(`${cliText("Agent Bot Skill: ", "Agent Bot Skill：")}${status.registered ? cliText("installed", "已安装") : cliText("not installed", "未安装")}\n`);
  process.stdout.write(`${cliText("System directory: ", "系统目录：")}${status.skillsRoot}\n`);
  process.stdout.write(`${cliText("Installation path: ", "安装路径：")}${status.targetPath}\n`);
  if (status.registered) {
    process.stdout.write(`${cliText("Ownership: ", "所有权：")}${status.managed
      ? cliText("managed by Agent Bot", "由 Agent Bot 管理")
      : cliText("external directory (will not be modified or removed)", "外部目录（不会修改或删除）")}\n`);
    process.stdout.write(`${cliText("Version: ", "版本：")}${status.upToDate
      ? cliText("up to date", "已是最新")
      : cliText("update required", "需要更新")}\n`);
  }
}

function printInitializationPaths(result: InitializationResult): void {
  process.stdout.write(cliText(
    "Profile setup\n",
    "Profile 设置\n",
  ));
  if (result.reset) {
    process.stdout.write(`${cliText("Reset backup: ", "重置备份：")}${result.reset.backupPath}\n`);
  }
  process.stdout.write(`${cliText("Home directory: ", "主目录：")}${result.home.path} (${initializationStatusLabel(result.home.status)})\n`);
  process.stdout.write(`${cliText("Config file: ", "配置文件：")}${result.config.path} (${initializationStatusLabel(result.config.status)})\n`);
  process.stdout.write(`${cliText("Environment file: ", "环境文件：")}${result.env.path} (${initializationStatusLabel(result.env.status)})\n`);
  process.stdout.write(`${cliText("Data directory: ", "数据目录：")}${result.data.path} (${initializationStatusLabel(result.data.status)})\n`);
  process.stdout.write(`${cliText("Log directory: ", "日志目录：")}${result.logs.path} (${initializationStatusLabel(result.logs.status)})\n`);
}

function printInitializationResult(result: Omit<InitCommandResult, "server">): void {
  process.stdout.write(cliText(
    "\nAgent Bot initialization completed.\n",
    "\nAgent Bot 初始化完成。\n",
  ));
  process.stdout.write(`${cliText("Default Agent: ", "默认 Agent：")}${result.defaultAgent.name}\n`);
  if (result.feishu.status === "created") {
    process.stdout.write(cliText(
      `Lark app: created and credentials saved (${result.feishu.appId})\n`,
      `飞书应用：已创建并保存凭据 (${result.feishu.appId})\n`,
    ));
  } else if (result.feishu.status === "existing") {
    process.stdout.write(cliText(
      `Lark app: already configured and unchanged (${result.feishu.appId})\n`,
      `飞书应用：已配置，未做修改 (${result.feishu.appId})\n`,
    ));
  } else {
    process.stdout.write(cliText(
      "Lark app: skipped; use Console mode or run init again later.\n",
      "飞书应用：已跳过；请使用 Console 模式或稍后重新运行 init。\n",
    ));
  }
  if (result.feishu.userOpenIdStatus === "pending") {
    process.stdout.write(cliText(
      "Lark user: pending; send the bot a direct message to save FEISHU_USER_OPEN_ID\n",
      "飞书用户：等待补全；请私聊机器人以保存 FEISHU_USER_OPEN_ID\n",
    ));
  }
  if (result.feishu.configuration?.status === "updated") {
    const added = result.feishu.configuration.added;
    process.stdout.write(cliText(
      `Lark configuration: added ${added.scopes.length} scopes, ${added.events.length} events, and ${added.callbacks.length} callbacks\n`,
      `飞书配置：已新增 ${added.scopes.length} 项权限、${added.events.length} 个事件和 ${added.callbacks.length} 个回调\n`,
    ));
  } else if (result.feishu.configuration?.status === "partial") {
    const configuration = result.feishu.configuration;
    const addedCount =
      configuration.added.scopes.length + configuration.added.events.length + configuration.added.callbacks.length;
    if (addedCount > 0) {
      process.stdout.write(cliText(
        `Lark configuration: initialization continued with missing configuration; added ${configuration.added.scopes.length} scopes, ${configuration.added.events.length} events, and ${configuration.added.callbacks.length} callbacks\n`,
        `飞书配置：仍有配置缺失，初始化已继续；新增 ${configuration.added.scopes.length} 项权限、${configuration.added.events.length} 个事件和 ${configuration.added.callbacks.length} 个回调\n`,
      ));
    } else {
      process.stdout.write(cliText(
        "Lark configuration: initialization continued with missing configuration\n",
        "飞书配置：仍有配置缺失，初始化已继续\n",
      ));
    }
    printFeishuConfigurationWarnings(configuration.remaining);
  } else if (result.feishu.configuration?.status === "ready") {
    process.stdout.write(cliText(
      "Lark configuration: scopes, events, and callbacks are ready\n",
      "飞书配置：权限、事件和回调均已就绪\n",
    ));
  }
  process.stdout.write(`${cliText("Config file: ", "配置文件：")}${result.config.path}\n`);
}

function printInitializationServerResult(result: InitCommandResult["server"]): void {
  if (result.status === "skipped") {
    process.stdout.write(cliText(
      "Agent Bot server: skipped (Lark is not configured; Console mode is available)\n",
      "Agent Bot 服务：已跳过（未配置飞书；可使用 Console 模式）\n",
    ));
    return;
  }
  if (result.status === "restart-scheduled") {
    process.stdout.write(cliText(
      "Agent Bot server: safe restart scheduled to load the current version.\n",
      "Agent Bot 服务：已安排安全重启，以加载当前版本。\n",
    ));
    return;
  }
  printServerStartResult(result);
}

function printServerStartResult(result: ServerStartResult): void {
  process.stdout.write(
    result.status === "already-running"
      ? cliText("Agent Bot server is already running.\n", "Agent Bot 服务已在运行。\n")
      : cliText("Agent Bot server started.\n", "Agent Bot 服务已启动。\n"),
  );
}

function printFeishuVerification(challenge: FeishuAppRegistrationChallenge, json: boolean): void {
  printVerificationQrAndLink(
    {
      verificationUrl: challenge.verificationUrl,
      json,
      qrInstruction: cliText(
        "Scan this QR code with Lark to create the bot app:",
        "使用飞书扫描此二维码以创建机器人应用：",
      ),
    },
  );
  process.stderr.write(cliText(
    `The link expires in about ${Math.ceil(challenge.expiresIn / 60)} minutes. Waiting for confirmation...\n`,
    `链接将在约 ${Math.ceil(challenge.expiresIn / 60)} 分钟后过期，正在等待确认...\n`,
  ));
}

function printFeishuConfigurationVerification(
  challenge: FeishuConfigurationChallenge,
  json: boolean,
): void {
  process.stderr.write(challenge.kind === "manual_scope"
    ? cliText(
        "\nThe following Lark permission must be added manually in Developer Console:\n",
        "\n必须在飞书开发者后台手动添加以下权限：\n",
      )
    : cliText(
        "\nThe Lark app is missing the following configuration:\n",
        "\n飞书应用缺少以下配置：\n",
      ));
  if (challenge.missing.scopes.length > 0) {
    process.stderr.write(`${cliText("Scopes: ", "权限：")}${challenge.missing.scopes.join(", ")}\n`);
  }
  if (challenge.missing.events.length > 0) {
    process.stderr.write(`${cliText("Events: ", "事件：")}${challenge.missing.events.join(", ")}\n`);
  }
  if (challenge.missing.callbacks.length > 0) {
    process.stderr.write(`${cliText("Callbacks: ", "回调：")}${challenge.missing.callbacks.join(", ")}\n`);
  }
  printVerificationQrAndLink(
    {
      verificationUrl: challenge.verificationUrl,
      json,
      qrInstruction: challenge.kind === "manual_scope"
        ? cliText(
            "Scan this QR code with Lark to open the filtered permission page:",
            "使用飞书扫描此二维码以打开已筛选的权限页面：",
          )
        : cliText(
            "Scan this QR code with Lark to complete the configuration:",
            "使用飞书扫描此二维码以完成配置：",
          ),
      linkLabel: challenge.kind === "manual_scope"
        ? cliText("Permission page", "权限页面")
        : undefined,
    },
  );
  if (challenge.kind === "manual_scope") {
    process.stderr.write(cliText(
      "Add the filtered permission, publish the app version, and complete tenant approval if required.\n",
      "请添加已筛选的权限、发布应用版本，并在需要时完成租户管理员审批。\n",
    ));
  }
  if (challenge.blocking) {
    process.stderr.write(cliText(
      "Waiting for the core scopes and message event to become active...\n",
      "正在等待核心权限和消息事件生效...\n",
    ));
  } else {
    process.stderr.write(cliText(
      "Waiting up to 5 minutes for these optional items to become active...\n",
      "将等待最多 5 分钟，直到这些可选配置生效...\n",
    ));
  }
}

function printFeishuConfigurationWarnings(missing: FeishuConfigurationChallenge["missing"]): void {
  process.stdout.write(cliText(
    "Warning: some Lark configuration is not active, so some features may be unavailable.\n",
    "警告：部分飞书配置尚未生效，某些功能可能不可用。\n",
  ));
  if (missing.scopes.length > 0) {
    process.stdout.write(`${cliText("Inactive scopes: ", "未生效权限：")}${missing.scopes.join(", ")}\n`);
  }
  if (missing.events.length > 0) {
    process.stdout.write(`${cliText("Inactive events: ", "未生效事件：")}${missing.events.join(", ")}\n`);
  }
  if (missing.callbacks.length > 0) {
    process.stdout.write(`${cliText("Inactive callbacks: ", "未生效回调：")}${missing.callbacks.join(", ")}\n`);
  }
  for (const feature of feishuFeatureWarnings(missing)) {
    process.stdout.write(`${cliText("Affected feature: ", "受影响功能：")}${feature}\n`);
  }
}

function feishuFeatureWarnings(missing: FeishuConfigurationChallenge["missing"]): string[] {
  const scopes = new Set(missing.scopes);
  const events = new Set(missing.events);
  const callbacks = new Set(missing.callbacks);
  const warnings: string[] = [];
  if (scopes.has("im:message.group_msg")) {
    warnings.push(cliText(
      "responding to ordinary group messages that do not mention the bot",
      "响应未 @ 机器人的普通群消息",
    ));
  }
  if (scopes.has("im:chat:create")) {
    warnings.push(cliText(
      "creating Lark groups with /newgroup and /forkgroup",
      "使用 /newgroup 和 /forkgroup 创建飞书群",
    ));
  }
  if (scopes.has("im:chat:read") || events.has("im.chat.updated_v1")) {
    warnings.push(cliText(
      "synchronizing Agent Bot task titles after Lark group renames",
      "飞书群重命名后同步 Agent Bot 任务标题",
    ));
  }
  if (scopes.has("im:message.reactions:write_only")) {
    warnings.push(cliText(
      "showing message-processing status with reactions",
      "使用 Reaction 显示消息处理状态",
    ));
  }
  if (scopes.has("im:message:readonly")) {
    warnings.push(cliText("reading images from user messages", "读取用户消息中的图片"));
  }
  if (scopes.has("im:resource")) {
    warnings.push(cliText(
      "uploading images, sending local images, or setting group avatars",
      "上传图片、发送本地图片或设置群头像",
    ));
  }
  if (scopes.has("im:message:update")) {
    warnings.push(cliText("updating sent progress cards", "更新已发送的进度卡片"));
  }
  if (callbacks.has("card.action.trigger")) {
    warnings.push(cliText("card buttons and interactive actions", "卡片按钮和交互操作"));
  }
  return warnings;
}

function initializationStatusLabel(status: InitializationStatus): string {
  if (status === "created") return cliText("created", "已创建");
  if (status === "updated") return cliText("updated with missing settings", "已补全缺失配置");
  if (status === "reset") return cliText("reset from template", "已从模板重置");
  return cliText("already exists; unchanged", "已存在，未修改");
}

function taskStateLabel(status: string | undefined): string {
  if (!status) return "-";
  const chinese: Record<string, string> = {
    starting: "启动中",
    ready: "就绪",
    running: "运行中",
    closed: "已关闭",
    failed: "失败",
    completed: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
    inProgress: "进行中",
    active: "活动中",
    idle: "空闲",
    not_loaded: "未加载",
    error: "错误",
  };
  return cliLanguage === "zh" ? chinese[status] ?? status : status;
}

function ensureOk(response: ControlResponse): void {
  if (response.ok) return;
  const message = response.message?.trim();
  const matchesLanguage = cliLanguage === "zh"
    ? Boolean(message && /[一-龥]/u.test(message))
    : Boolean(message && !/[一-龥]/u.test(message));
  throw new Error(matchesLanguage
    ? message!
    : cliText(
        "Agent Bot control operation failed. Check the server logs for details.",
        "Agent Bot 控制操作失败，请查看服务日志了解详情。",
      ));
}

function requireCliGroupUser(userOpenId: string | undefined): asserts userOpenId is string {
  if (userOpenId?.startsWith("ou_")) return;
  throw new Error(cliText(
    "The profile has no authorizing Lark user to invite. Run agentbot init again or configure FEISHU_USER_OPEN_ID.",
    "当前 Profile 没有可邀请的飞书授权用户。请重新运行 agentbot init，或配置 FEISHU_USER_OPEN_ID。",
  ));
}

function taskGroupControlData(response: ControlResponse): TaskGroupControlData {
  ensureOk(response);
  const data = response.data as Partial<TaskGroupControlData> | undefined;
  if (
    !data
    || typeof data.sourceLocalSessionId !== "string"
    || !data.group
    || typeof data.group.chatId !== "string"
    || typeof data.group.contextKey !== "string"
    || typeof data.group.name !== "string"
    || !data.task
    || typeof data.task.localSessionId !== "string"
  ) {
    throw new Error(cliText(
      "Agent Bot returned an invalid task-group result.",
      "Agent Bot 返回了无效的任务群结果。",
    ));
  }
  return data as TaskGroupControlData;
}

function printTaskGroupResult(
  result: TaskGroupControlData,
  action: "newgroup" | "forkgroup",
): void {
  process.stdout.write(cliText(
    `${action === "forkgroup" ? "Fork group" : "Lark group"} created: ${result.group.name}\n`,
    `${action === "forkgroup" ? "Fork 群" : "飞书群"}已创建：${result.group.name}\n`,
  ));
  process.stdout.write(`${cliText("Chat ID: ", "群 ID：")}${result.group.chatId}\n`);
  process.stdout.write(`${cliText("Task ID: ", "任务 ID：")}${result.task.localSessionId}\n`);
  if (result.task.remoteSessionId) {
    process.stdout.write(`${cliText("Agent task ID: ", "Agent 任务 ID：")}${result.task.remoteSessionId}\n`);
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(renderCliHelp(readPackageVersion()));
}
