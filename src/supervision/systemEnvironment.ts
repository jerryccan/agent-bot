import { spawnSync } from "node:child_process";
import path from "node:path";

export interface WindowsEnvironmentSnapshot {
  machine: Record<string, string>;
  user: Record<string, string>;
}

export interface EnvironmentRefreshResult {
  environment: NodeJS.ProcessEnv;
  refreshed: boolean;
  pathChanged: boolean;
  error?: string;
}

type WindowsEnvironmentLoader = () => WindowsEnvironmentSnapshot;

const PROCESS_LOCAL_ENVIRONMENT_PREFIXES = ["AGENT_BOT_", "FEISHU_"];

export function refreshedSystemEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  loadWindowsEnvironment: WindowsEnvironmentLoader = readWindowsEnvironment,
): EnvironmentRefreshResult {
  const fallback = { ...inherited };
  if (platform !== "win32") {
    return { environment: fallback, refreshed: false, pathChanged: false };
  }

  try {
    const snapshot = loadWindowsEnvironment();
    const environment = mergeWindowsEnvironment(inherited, snapshot);
    return {
      environment,
      refreshed: true,
      pathChanged: environmentValue(environment, "Path") !== environmentValue(inherited, "Path"),
    };
  } catch (error) {
    return {
      environment: fallback,
      refreshed: false,
      pathChanged: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mergeWindowsEnvironment(
  inherited: NodeJS.ProcessEnv,
  snapshot: WindowsEnvironmentSnapshot,
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  applyEnvironment(environment, snapshot.machine);
  applyEnvironment(environment, snapshot.user);

  const machinePath = environmentValue(snapshot.machine, "Path")?.trim();
  const userPath = environmentValue(snapshot.user, "Path")?.trim();
  if (machinePath || userPath) {
    const inheritedPath = environmentValue(inherited, "Path")?.trim();
    setEnvironmentValue(
      environment,
      "Path",
      mergePathValues(
        expandEnvironmentReferences(
          [machinePath, userPath, inheritedPath].filter(Boolean).join(";"),
          environment,
        ),
      ),
    );
  }
  return environment;
}

function readWindowsEnvironment(): WindowsEnvironmentSnapshot {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$machine = @{}",
    "foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Machine).GetEnumerator()) { $machine[[string]$entry.Key] = [string]$entry.Value }",
    "$user = @{}",
    "foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::User).GetEnumerator()) { $user[[string]$entry.Key] = [string]$entry.Value }",
    "[pscustomobject]@{ machine = $machine; user = $user } | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const result = spawnSync(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `PowerShell exited with code ${result.status ?? "unknown"}.`);
  }
  const parsed = JSON.parse(result.stdout) as Partial<WindowsEnvironmentSnapshot>;
  return {
    machine: environmentRecord(parsed.machine),
    user: environmentRecord(parsed.user),
  };
}

function environmentRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, entry]) =>
      typeof entry === "string" ? [[name, entry]] : []),
  );
}

function applyEnvironment(
  target: NodeJS.ProcessEnv,
  source: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(source)) {
    if (name.toLowerCase() === "path" || isProcessLocalEnvironmentName(name)) continue;
    setEnvironmentValue(target, name, value);
  }
}

function isProcessLocalEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return PROCESS_LOCAL_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const existingName of Object.keys(environment)) {
    if (existingName !== name && existingName.toLowerCase() === name.toLowerCase()) {
      delete environment[existingName];
    }
  }
  environment[name] = value;
}

function environmentValue(
  environment: NodeJS.ProcessEnv | Record<string, string>,
  name: string,
): string | undefined {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function expandEnvironmentReferences(value: string, environment: NodeJS.ProcessEnv): string {
  let expanded = value;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = expanded.replace(/%([^%]+)%/g, (match, name: string) =>
      environmentValue(environment, name) ?? match);
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

function mergePathValues(value: string): string {
  const seen = new Set<string>();
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false;
      const normalized = entry.replace(/[\\/]+$/, "").toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(";");
}
