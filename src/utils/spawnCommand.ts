import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface PreparedCommand {
  command: string;
  args: string[];
}

export function prepareCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
): PreparedCommand {
  if (platform !== "win32") return { command, args };
  const commandLine = [command, ...args].map(quoteCmdToken).join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", commandLine] };
}

export function spawnStdioCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const prepared = prepareCommand(command, args);
  return spawn(prepared.command, prepared.args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function quoteCmdToken(value: string): string {
  if (value.length > 0 && !/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
