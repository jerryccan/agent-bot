#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { loadConfig } from "./config/loadConfig.js";
import { sendControlRequest, isServerReachable } from "./cli/LocalControlClient.js";
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
import { formatServerStatus, withConfiguredFeishuAppId } from "./cli/serverStatus.js";
import { resolveSystemSkillsRoot, SkillRegistry, type SkillRegistrationStatus } from "./cli/SkillRegistry.js";
import { readPackageVersion } from "./cli/packageVersion.js";
import { applyExplicitProfile, parseGlobalOptions } from "./cli/profile.js";
import {
  startInitializedServer,
  startServer,
  type InitializationServerResult,
  type ServerStartResult,
} from "./cli/ServerStarter.js";
import { taskChatRoute } from "./cli/taskChatRoute.js";
import { StateStore, type SessionRecord } from "./state/StateStore.js";
import {
  nodeDiagnosticReportArguments,
  prepareCrashReportDirectory,
  resolveSupervisorDiagnosticsPaths,
} from "./supervision/SupervisorDiagnostics.js";

const args = process.argv.slice(2);

void main(args).catch((error: unknown) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
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
  throw new Error(`Unknown command: ${command}. Run agent-bot --help for usage.`);
}

type FeishuInitializationStatus = "created" | "existing" | "skipped";

interface InitCommandResult extends InitializationResult {
  feishu: {
    status: FeishuInitializationStatus;
    appId?: string;
    configuration?: EnsureFeishuAppConfigurationResult;
  };
  server: InitializationServerResult;
}

async function initCommand(input: string[], configPath?: string): Promise<void> {
  const supported = new Set(["--json", "--skip-feishu", "--reconfigure-feishu"]);
  const unsupported = input.filter((value) => !supported.has(value));
  if (unsupported.length > 0) throw new Error(`Unsupported init options: ${unsupported.join(" ")}`);
  const json = input.includes("--json");
  const skipFeishu = input.includes("--skip-feishu");
  const reconfigureFeishu = input.includes("--reconfigure-feishu");
  if (skipFeishu && reconfigureFeishu) {
    throw new Error("--skip-feishu and --reconfigure-feishu cannot be used together.");
  }

  const paths = initializeAgentBot({ configPath });
  if (!json) printInitializationPaths(paths);
  const initializationLock = acquireInitializationLock(paths.home.path);

  let initialized: Omit<InitCommandResult, "server">;
  try {
    cleanupFeishuCredentialTemporaryFiles(paths.env.path);
    const feishu = await initializeFeishu(
      paths,
      { json, skipFeishu, reconfigureFeishu },
    );
    initialized = { ...paths, feishu };
  } finally {
    initializationLock.release();
  }

  if (!json) printInitializationResult(initialized);
  if (!json && !skipFeishu) process.stdout.write("\nStarting Agent Bot server...\n");
  const server = await startInitializedServer({ skipFeishu, configPath });
  const result: InitCommandResult = { ...initialized, server };
  if (json) printJson(result);
  else printInitializationServerResult(server);
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
  const onInterrupt = (): void => controller.abort(new Error("Initialization was cancelled."));
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
        process.stdout.write("\nIncomplete Lark credentials were found. A new bot will be created.\n");
      }
      credentials = await registerFeishuApp({
        signal: controller.signal,
        onVerification: (challenge) => printFeishuVerification(challenge, options.json),
      });
      writeFeishuCredentials(paths.env.path, credentials);
      status = "created";
    }

    if (!options.json) process.stdout.write("\nChecking Lark app permissions, events, and callbacks...\n");
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
      ? `Installed the Agent Bot Skill: ${result.status.targetPath}\n`
      : `The Agent Bot Skill is already up to date: ${result.status.targetPath}\n`);
    return;
  }
  if (action === "uninstall" || action === "unregister") {
    const removed = registry.uninstall();
    if (json) printJson({ removed, targetPath: registry.targetPath });
    else process.stdout.write(removed
      ? `Uninstalled the Agent Bot Skill: ${registry.targetPath}\n`
      : `The Agent Bot Skill is not installed: ${registry.targetPath}\n`);
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
      process.stdout.write(`Built-in Skill: ${paths.sourcePath}\n`);
      process.stdout.write(`System Skills directory: ${paths.skillsRoot}\n`);
      process.stdout.write(`Installation path: ${paths.targetPath}\n`);
    }
    return;
  }
  throw new Error(`Unknown skills command: ${action}`);
}

async function consoleCommand(input: string[]): Promise<void> {
  const config = loadConfig();
  const endpoint = controlEndpoint(config.storage.sqlitePath);
  const force = input.includes("--force");
  if (!force && await isServerReachable(endpoint)) {
    throw new Error(
      "The Agent Bot server is running. Stop it first to avoid concurrent task-state access, or explicitly use --force.",
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
    process.stdout.write("Agent Bot server stop requested.\n");
    return;
  }
  if (action === "restart") {
    const immediate = rest.includes("--immediate") || rest.includes("--force");
    const reason = optionValue(rest, "--reason")
      ?? (immediate ? "通过 Agent Bot CLI 立即重启" : "通过 Agent Bot CLI 安全重启");
    ensureOk(await sendControlRequest(endpoint, {
      action: "server_restart",
      mode: immediate ? "immediate" : "safe",
      reason,
    }));
    process.stdout.write(immediate ? "Immediate restart requested.\n" : "Safe restart requested.\n");
    return;
  }
  throw new Error(`Unknown server command: ${action}`);
}

async function taskCommand(input: string[]): Promise<void> {
  const [action = "list", ...rest] = input;
  const config = loadConfig();
  const store = new StateStore(config.storage.sqlitePath);
  try {
    const allSessions = store.listAllSessions();
    if (action === "prompt" || action === "send") {
      const [reference, ...promptParts] = rest;
      if (!reference) throw new Error(`task ${action} requires a task number or task ID.`);
      const text = promptParts.join(" ").trim();
      if (!text) throw new Error(`task ${action} requires a Prompt.`);
      const session = resolveTask(allSessions, reference);
      const endpoint = controlEndpoint(config.storage.sqlitePath);
      ensureOk(await sendControlRequest(endpoint, {
        action: "task_prompt",
        localSessionId: session.localSessionId,
        text,
      }, 60_000));
      process.stdout.write("Prompt submitted.\n");
      return;
    }
    const sessions = filterSessions(allSessions, rest);
    if (action === "list") {
      if (rest.includes("--json")) printJson(sessions);
      else printTaskList(sessions);
      return;
    }
    const reference = rest.find((value) => !value.startsWith("--"));
    if (!reference) throw new Error(`task ${action} requires a task number or task ID.`);
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
      process.stdout.write("Task stop requested.\n");
      return;
    }
    if (action === "title") {
      const referenceIndex = rest.indexOf(reference);
      const titleArgs = rest.slice(referenceIndex + 1);
      const optionIndex = titleArgs.findIndex((value) => value.startsWith("--"));
      const title = titleArgs.slice(0, optionIndex < 0 ? undefined : optionIndex).join(" ").trim();
      if (!title) throw new Error("task title requires a new title.");
      ensureOk(await sendControlRequest(endpoint, {
        action: "task_title",
        localSessionId: session.localSessionId,
        title,
      }));
      process.stdout.write("Task title updated.\n");
      return;
    }
    throw new Error(`Unknown task command: ${action}`);
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
    if (!session) throw new Error(`Task number is out of range: ${reference}`);
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
  if (matches.length > 1) throw new Error(`Task ID prefix is ambiguous: ${reference}`);
  throw new Error(`Task not found: ${reference}`);
}

function printTaskList(sessions: SessionRecord[]): void {
  if (sessions.length === 0) {
    process.stdout.write("No tasks.\n");
    return;
  }
  for (const [index, session] of sessions.entries()) {
    const id = session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId;
    process.stdout.write(`${index + 1}. [${session.status}/${session.lastTurnStatus ?? "-"}] ${session.title ?? "Untitled task"}\n`);
    process.stdout.write(`   ${id} · ${session.contextKey} · ${session.updatedAt}\n`);
  }
}

function printTaskStatus(session: SessionRecord, snapshot: unknown, remote?: TaskStatusControlData["remote"]): void {
  process.stdout.write(`Title: ${session.title ?? "Untitled task"}\n`);
  process.stdout.write(`Task ID: ${session.remoteSessionId ?? session.acpSessionId ?? session.localSessionId}\n`);
  process.stdout.write(`Local ID: ${session.localSessionId}\n`);
  process.stdout.write(`Context: ${session.contextKey}\n`);
  process.stdout.write(`Status: ${session.status} / ${session.lastTurnStatus ?? "-"}\n`);
  process.stdout.write(`Directory: ${session.cwd}\n`);
  process.stdout.write(`Last turn: ${session.lastTurnId ?? "-"}\n`);
  let displayedFinalResponse: string | undefined;
  if (snapshot && typeof snapshot === "object") {
    const state = snapshot as Record<string, unknown>;
    if (typeof state.durationMs === "number") process.stdout.write(`Duration: ${Math.round(state.durationMs / 1_000)}s\n`);
    if (typeof state.totalTokens === "number") process.stdout.write(`Tokens：${state.totalTokens}\n`);
    if (typeof state.totalToolCount === "number") process.stdout.write(`Tool calls: ${state.totalToolCount}\n`);
    if (typeof state.finalResponse === "string" && state.finalResponse.trim()) displayedFinalResponse = state.finalResponse.trim();
  }
  if (!snapshot && remote?.lastTurnToolCount !== undefined) process.stdout.write(`Tool calls: ${remote.lastTurnToolCount}\n`);
  displayedFinalResponse = remote?.finalResponse?.trim() || displayedFinalResponse;
  if (displayedFinalResponse) process.stdout.write(`Final response:\n${displayedFinalResponse}\n`);
}

function printSkillStatus(status: SkillRegistrationStatus): void {
  process.stdout.write(`Agent Bot Skill: ${status.registered ? "installed" : "not installed"}\n`);
  process.stdout.write(`System directory: ${status.skillsRoot}\n`);
  process.stdout.write(`Installation path: ${status.targetPath}\n`);
  if (status.registered) {
    process.stdout.write(`Ownership: ${status.managed ? "managed by Agent Bot" : "external directory (will not be modified or removed)"}\n`);
    process.stdout.write(`Version: ${status.upToDate ? "up to date" : "update required"}\n`);
  }
}

function printInitializationPaths(result: InitializationResult): void {
  process.stdout.write("Preparing the Agent Bot user environment...\n");
  process.stdout.write(`Home directory: ${result.home.path} (${initializationStatusLabel(result.home.status)})\n`);
  process.stdout.write(`Config file: ${result.config.path} (${initializationStatusLabel(result.config.status)})\n`);
  process.stdout.write(`Environment file: ${result.env.path} (${initializationStatusLabel(result.env.status)})\n`);
  process.stdout.write(`Data directory: ${result.data.path} (${initializationStatusLabel(result.data.status)})\n`);
  process.stdout.write(`Log directory: ${result.logs.path} (${initializationStatusLabel(result.logs.status)})\n`);
}

function printInitializationResult(result: Omit<InitCommandResult, "server">): void {
  process.stdout.write("\nAgent Bot initialization completed.\n");
  if (result.feishu.status === "created") {
    process.stdout.write(`Lark app: created and credentials saved (${result.feishu.appId})\n`);
  } else if (result.feishu.status === "existing") {
    process.stdout.write(`Lark app: already configured and unchanged (${result.feishu.appId})\n`);
  } else {
    process.stdout.write("Lark app: skipped; use Console mode or run init again later.\n");
  }
  if (result.feishu.configuration?.status === "updated") {
    const added = result.feishu.configuration.added;
    process.stdout.write(
      `Lark configuration: added ${added.scopes.length} scopes, ${added.events.length} events, and ${added.callbacks.length} callbacks\n`,
    );
  } else if (result.feishu.configuration?.status === "partial") {
    const configuration = result.feishu.configuration;
    const addedCount =
      configuration.added.scopes.length + configuration.added.events.length + configuration.added.callbacks.length;
    if (addedCount > 0) {
      process.stdout.write(
        `Lark configuration: core capabilities are ready; added ${configuration.added.scopes.length} scopes, ${configuration.added.events.length} events, and ${configuration.added.callbacks.length} callbacks\n`,
      );
    } else {
      process.stdout.write("Lark configuration: core capabilities are ready\n");
    }
    printOptionalFeishuConfigurationWarnings(configuration.remaining);
  } else if (result.feishu.configuration?.status === "ready") {
    process.stdout.write("Lark configuration: scopes, events, and callbacks are ready\n");
  }
  process.stdout.write(`Config file: ${result.config.path}\n`);
}

function printInitializationServerResult(result: InitCommandResult["server"]): void {
  if (result.status === "skipped") {
    process.stdout.write("Agent Bot server: skipped (Lark is not configured; Console mode is available)\n");
    return;
  }
  printServerStartResult(result);
}

function printServerStartResult(result: ServerStartResult): void {
  process.stdout.write(
    result.status === "already-running"
      ? "Agent Bot server is already running.\n"
      : "Agent Bot server started.\n",
  );
}

function printFeishuVerification(challenge: FeishuAppRegistrationChallenge, json: boolean): void {
  process.stderr.write("\nScan with Lark or open the link below in a browser to create the bot app:\n\n");
  process.stderr.write(`${challenge.verificationUrl}\n\n`);
  if (!json) {
    qrcode.generate(challenge.verificationUrl, { small: true }, (output) => {
      process.stderr.write(`${output}\n`);
    });
  }
  process.stderr.write(`The link expires in about ${Math.ceil(challenge.expiresIn / 60)} minutes. Waiting for confirmation...\n`);
}

function printFeishuConfigurationVerification(
  challenge: FeishuConfigurationChallenge,
  json: boolean,
): void {
  process.stderr.write("\nThe Lark app is missing the following configuration:\n");
  if (challenge.missing.scopes.length > 0) {
    process.stderr.write(`Scopes: ${challenge.missing.scopes.join(", ")}\n`);
  }
  if (challenge.missing.events.length > 0) {
    process.stderr.write(`Events: ${challenge.missing.events.join(", ")}\n`);
  }
  if (challenge.missing.callbacks.length > 0) {
    process.stderr.write(`Callbacks: ${challenge.missing.callbacks.join(", ")}\n`);
  }
  process.stderr.write("\nScan with Lark or open the link below in a browser to complete the configuration:\n\n");
  process.stderr.write(`${challenge.verificationUrl}\n\n`);
  if (!json) {
    qrcode.generate(challenge.verificationUrl, { small: true }, (output) => {
      process.stderr.write(`${output}\n`);
    });
  }
  if (challenge.blocking) {
    process.stderr.write("Waiting for the core scopes and message event to become active...\n");
  } else {
    process.stderr.write("These optional items do not block basic messaging. Initialization will continue; grant them later using the link.\n");
  }
}

function printOptionalFeishuConfigurationWarnings(missing: FeishuConfigurationChallenge["missing"]): void {
  process.stdout.write("Warning: some optional configuration is not active, so some features may be unavailable.\n");
  if (missing.scopes.length > 0) {
    process.stdout.write(`Inactive scopes: ${missing.scopes.join(", ")}\n`);
  }
  if (missing.events.length > 0) {
    process.stdout.write(`Inactive events: ${missing.events.join(", ")}\n`);
  }
  if (missing.callbacks.length > 0) {
    process.stdout.write(`Inactive callbacks: ${missing.callbacks.join(", ")}\n`);
  }
  for (const feature of optionalFeishuFeatureWarnings(missing)) {
    process.stdout.write(`Affected feature: ${feature}\n`);
  }
}

function optionalFeishuFeatureWarnings(missing: FeishuConfigurationChallenge["missing"]): string[] {
  const scopes = new Set(missing.scopes);
  const events = new Set(missing.events);
  const callbacks = new Set(missing.callbacks);
  const warnings: string[] = [];
  if (scopes.has("im:chat:create")) {
    warnings.push("creating Lark groups with /newgroup and /forkgroup");
  }
  if (scopes.has("im:chat:read") || events.has("im.chat.updated_v1")) {
    warnings.push("synchronizing Agent Bot task titles after Lark group renames");
  }
  if (scopes.has("im:message.reactions:write_only")) {
    warnings.push("showing message-processing status with reactions");
  }
  if (scopes.has("im:message:readonly")) {
    warnings.push("reading images from user messages");
  }
  if (scopes.has("im:resource")) {
    warnings.push("uploading images, sending local images, or setting group avatars");
  }
  if (scopes.has("im:message:update")) {
    warnings.push("updating sent progress cards");
  }
  if (callbacks.has("card.action.trigger")) {
    warnings.push("card buttons and interactive actions");
  }
  return warnings;
}

function initializationStatusLabel(status: InitializationStatus): string {
  if (status === "created") return "created";
  return "already exists; unchanged";
}

function ensureOk(response: ControlResponse): void {
  if (response.ok) return;
  const message = response.message?.trim();
  throw new Error(message && !/[一-龥]/u.test(message)
    ? message
    : "Agent Bot control operation failed. Check the server logs for details.");
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
