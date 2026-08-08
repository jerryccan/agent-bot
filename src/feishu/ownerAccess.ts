import type { AppConfig } from "../config/schema.js";

export function allowsFeishuUser(config: AppConfig, userOpenId: string | undefined): boolean {
  if (config.feishu?.respondToOwnerOnly !== true) return true;
  const ownerOpenId = config.feishu.userOpenId?.trim();
  return Boolean(ownerOpenId && userOpenId === ownerOpenId);
}
