import type { RestartNotificationTarget } from "../supervision/SafeRestartScheduler.js";

export interface StartableFeishuConnector {
  start(): Promise<void>;
}

export interface StartupNotificationSender {
  notify(startedAt: Date, restartReason: string, restartTargets?: RestartNotificationTarget[]): Promise<void>;
}

export async function startFeishu(
  connector: StartableFeishuConnector,
  notifier: StartupNotificationSender,
  startedAt: Date,
  restartReason: string,
  prepare?: () => Promise<void>,
  onConnected?: () => void,
  restartTargets: RestartNotificationTarget[] = [],
): Promise<void> {
  await prepare?.();
  await connector.start();
  await notifier.notify(startedAt, restartReason, restartTargets);
  onConnected?.();
}
