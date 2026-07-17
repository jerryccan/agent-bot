export const RESTART_EXIT_CODE = 75;
export const INTENTIONAL_RESTART_DELAY_MS = 250;
export const STABLE_UPTIME_MS = 60_000;

export function crashRestartDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(30_000, 1_000 * (2 ** exponent));
}
