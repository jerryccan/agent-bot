import { spawn } from "node:child_process";

export type SupportedAgentId = "codex" | "traex";
export type SupportedAgentState = "missing" | "outdated" | "ready";
export type AgentMaintenanceKind = "install" | "upgrade";

export interface AgentCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface AgentCommandSpec {
  command: string;
  args: string[];
  display: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  inheritStdio?: boolean;
}

export type AgentCommandRunner = (command: AgentCommandSpec) => Promise<AgentCommandResult>;

export interface SupportedAgentInspection {
  id: SupportedAgentId;
  name: string;
  state: SupportedAgentState;
  installedVersion?: string;
  latestVersion?: string;
  latestCheckFailed?: boolean;
  action?: {
    kind: AgentMaintenanceKind;
    command: string;
  };
}

export interface InspectSupportedAgentsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: AgentCommandRunner;
}

const CODEX_PACKAGE = "@openai/codex";
const TRAEX_CHANNEL = "alpha";
const TRAEX_INSTALL_BASE_URL = "https://code.byted.org/api/tos-proxy/download";

export async function inspectSupportedAgents(
  options: InspectSupportedAgentsOptions = {},
): Promise<SupportedAgentInspection[]> {
  return Promise.all([
    inspectSupportedAgent("codex", options),
    inspectSupportedAgent("traex", options),
  ]);
}

export async function inspectSupportedAgent(
  id: SupportedAgentId,
  options: InspectSupportedAgentsOptions = {},
): Promise<SupportedAgentInspection> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runAgentCommand;
  return id === "codex"
    ? inspectCodex(platform, env, run)
    : inspectTraex(platform, env, run);
}

export async function runSupportedAgentMaintenance(
  id: SupportedAgentId,
  kind: AgentMaintenanceKind,
  options: InspectSupportedAgentsOptions = {},
): Promise<AgentCommandResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runAgentCommand;
  const command = maintenanceCommand(id, kind, platform, env);
  const result = await run({ ...command, inheritStdio: true });
  if (id !== "codex" || kind !== "upgrade" || commandSucceeded(result)) return result;
  const fallback = codexNpmInstallCommand(platform, env);
  return run({ ...fallback, inheritStdio: true });
}

async function inspectCodex(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  run: AgentCommandRunner,
): Promise<SupportedAgentInspection> {
  const installed = await run(capturedCommand("codex", ["--version"], platform, env, 5_000));
  const installedVersion = commandVersion(installed);
  if (!installedVersion) return missingInspection("codex", "Codex", platform, env);

  const latest = await run(capturedCommand(
    "npm",
    ["view", CODEX_PACKAGE, "version", "--json"],
    platform,
    env,
    15_000,
  ));
  const latestVersion = npmVersion(latest);
  if (!latestVersion) {
    return { id: "codex", name: "Codex", state: "ready", installedVersion, latestCheckFailed: true };
  }
  if (compareSemanticVersions(installedVersion, latestVersion) < 0) {
    return {
      id: "codex",
      name: "Codex",
      state: "outdated",
      installedVersion,
      latestVersion,
      action: maintenanceAction("codex", "upgrade", platform, env),
    };
  }
  return { id: "codex", name: "Codex", state: "ready", installedVersion, latestVersion };
}

async function inspectTraex(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  run: AgentCommandRunner,
): Promise<SupportedAgentInspection> {
  const installed = await run(capturedCommand("traex", ["--version"], platform, env, 5_000));
  const installedVersion = commandVersion(installed);
  if (!installedVersion) return missingInspection("traex", "TraeX", platform, env);

  const latest = await run(capturedCommand(
    "traex",
    ["update", "--channel", TRAEX_CHANNEL, "check"],
    platform,
    env,
    15_000,
  ));
  const latestVersion = /^Latest TraeCode CLI version:\s*(\S+)/mu.exec(commandOutput(latest))?.[1];
  if (!latestVersion) {
    return { id: "traex", name: "TraeX", state: "ready", installedVersion, latestCheckFailed: true };
  }
  if (compareSemanticVersions(installedVersion, latestVersion) < 0) {
    return {
      id: "traex",
      name: "TraeX",
      state: "outdated",
      installedVersion,
      latestVersion,
      action: maintenanceAction("traex", "upgrade", platform, env),
    };
  }
  return { id: "traex", name: "TraeX", state: "ready", installedVersion, latestVersion };
}

function missingInspection(
  id: SupportedAgentId,
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): SupportedAgentInspection {
  return {
    id,
    name,
    state: "missing",
    action: maintenanceAction(id, "install", platform, env),
  };
}

function maintenanceAction(
  id: SupportedAgentId,
  kind: AgentMaintenanceKind,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): SupportedAgentInspection["action"] {
  const command = maintenanceCommand(id, kind, platform, env);
  return { kind, command: command.display };
}

function maintenanceCommand(
  id: SupportedAgentId,
  kind: AgentMaintenanceKind,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): AgentCommandSpec {
  if (id === "codex") {
    return kind === "install"
      ? codexNpmInstallCommand(platform, env)
      : commandSpec("codex", ["update"], platform, env, 5 * 60_000);
  }
  if (kind === "upgrade") {
    return commandSpec("traex", ["update", "--channel", TRAEX_CHANNEL], platform, env, 5 * 60_000);
  }

  const installEnv = {
    ...env,
    TRAEX_INSTALL_ASSUME_YES: "1",
    TRAEX_INSTALL_CHANNEL: TRAEX_CHANNEL,
  };
  if (platform === "win32") {
    const scriptUrl = `${TRAEX_INSTALL_BASE_URL}/traex_install_windows.ps1`;
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Invoke-RestMethod -Uri '${scriptUrl}' | Invoke-Expression`,
      ],
      display: `$env:TRAEX_INSTALL_CHANNEL='${TRAEX_CHANNEL}'; irm '${scriptUrl}' | iex`,
      timeoutMs: 5 * 60_000,
      env: installEnv,
    };
  }
  const scriptUrl = `${TRAEX_INSTALL_BASE_URL}/traex_install.sh`;
  return {
    command: "bash",
    args: ["-c", `curl -fsSL '${scriptUrl}' | bash`],
    display: `curl -fsSL '${scriptUrl}' | TRAEX_INSTALL_CHANNEL=${TRAEX_CHANNEL} bash`,
    timeoutMs: 5 * 60_000,
    env: installEnv,
  };
}

function codexNpmInstallCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): AgentCommandSpec {
  return commandSpec(
    "npm",
    ["install", "--global", `${CODEX_PACKAGE}@latest`],
    platform,
    env,
    5 * 60_000,
  );
}

function commandSucceeded(result: AgentCommandResult): boolean {
  return result.status === 0 && !result.error;
}

function capturedCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): AgentCommandSpec {
  return commandSpec(command, args, platform, env, timeoutMs);
}

function commandSpec(
  command: string,
  args: string[],
  _platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): AgentCommandSpec {
  return {
    command,
    args,
    display: [command, ...args].join(" "),
    timeoutMs,
    env,
  };
}

function commandVersion(result: AgentCommandResult): string | undefined {
  if (result.status !== 0) return undefined;
  return versionInText(commandOutput(result));
}

function npmVersion(result: AgentCommandResult): string | undefined {
  if (result.status !== 0) return undefined;
  const output = result.stdout.trim();
  try {
    const parsed = JSON.parse(output) as unknown;
    return typeof parsed === "string" ? versionInText(parsed) : undefined;
  } catch {
    return versionInText(output);
  }
}

function commandOutput(result: AgentCommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function versionInText(value: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/u.exec(value)?.[1];
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  if (!leftVersion || !rightVersion) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = leftVersion.core[index]! - rightVersion.core[index]!;
    if (difference !== 0) return difference;
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function parseSemanticVersion(value: string): {
  core: [number, number, number];
  prerelease?: string[];
} | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { prerelease: match[4].split(".") } : {}),
  };
}

export function runAgentCommand(command: AgentCommandSpec): Promise<AgentCommandResult> {
  return new Promise((resolve) => {
    const invocation = resolveInvocation(command);
    const child = spawn(invocation.command, invocation.args, {
      env: command.env ?? process.env,
      windowsHide: true,
      stdio: command.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (!command.inheritStdio) {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    }
    let error: string | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, command.timeoutMs);
    child.once("error", (spawnError) => {
      error = spawnError.message;
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(error || timedOut ? { error: timedOut ? `Timed out after ${command.timeoutMs}ms.` : error } : {}),
      });
    });
  });
}

function resolveInvocation(command: AgentCommandSpec): { command: string; args: string[] } {
  if (process.platform !== "win32" || /\.exe$/iu.test(command.command)) {
    return { command: command.command, args: command.args };
  }
  const commandLine = [command.command, ...command.args].map(quoteCmdArgument).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function quoteCmdArgument(value: string): string {
  return /^[A-Za-z0-9_@./:\\=+-]+$/u.test(value)
    ? value
    : `"${value.replaceAll('"', '""')}"`;
}
