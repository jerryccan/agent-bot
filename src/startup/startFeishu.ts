export interface StartableFeishuConnector {
  start(): Promise<void>;
}

export interface StartupNotificationSender {
  notify(startedAt: Date, restartReason: string): Promise<void>;
}

export async function startFeishu(
  connector: StartableFeishuConnector,
  notifier: StartupNotificationSender,
  startedAt: Date,
  restartReason: string,
  prepare?: () => Promise<void>,
): Promise<void> {
  await prepare?.();
  await connector.start();
  await notifier.notify(startedAt, restartReason);
}
