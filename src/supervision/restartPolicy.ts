export const RESTART_EXIT_CODE = 75;
export const STOP_EXIT_CODE = 76;
export const INTENTIONAL_RESTART_DELAY_MS = 250;
export const STABLE_UPTIME_MS = 60_000;

export function crashRestartDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(30_000, 1_000 * (2 ** exponent));
}

export function describeRestartReason(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  intentional: boolean,
): string {
  if (intentional) return "用户执行 /restart 命令";
  if (signal) return `进程收到 ${signal} 信号后退出，Supervisor 自动重启`;
  return `进程退出（exit code ${exitCode ?? "unknown"}），Supervisor 自动重启`;
}
