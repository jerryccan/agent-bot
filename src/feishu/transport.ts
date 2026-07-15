import type { AppConfig } from "../config/schema.js";

export type FeishuTransportMode = "sdk" | "console";

type FeishuTransportConfig = Pick<
  AppConfig["feishu"],
  "transport" | "appId" | "appSecret" | "useConsoleWhenMissingCredentials"
>;

export function resolveFeishuTransport(config: FeishuTransportConfig): FeishuTransportMode {
  if (config.transport === "console") {
    return "console";
  }

  const hasCredentials = Boolean(config.appId && config.appSecret);
  if (config.transport === "sdk" || !config.useConsoleWhenMissingCredentials) {
    if (!hasCredentials) {
      throw new Error("Feishu appId/appSecret are required.");
    }
    return "sdk";
  }

  return hasCredentials ? "sdk" : "console";
}
