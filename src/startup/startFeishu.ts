export interface StartableFeishuConnector {
  start(): Promise<void>;
}

export interface StartupNotificationSender {
  notify(startedAt: Date): Promise<void>;
}

export async function startFeishu(
  connector: StartableFeishuConnector,
  notifier: StartupNotificationSender,
  startedAt: Date,
): Promise<void> {
  await connector.start();
  await notifier.notify(startedAt);
}
