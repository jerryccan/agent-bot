import type { AppConfig } from "../config/schema.js";

type FeishuTransportConfig = Pick<
  AppConfig["feishu"],
  "appId" | "appSecret"
>;

export function requireServerFeishuTransport(config: FeishuTransportConfig): "sdk" {
  if (!config.appId || !config.appSecret) {
    throw new Error(
      "The Lark bot is not configured. Run agentbot init first, or use agentbot console for local-only testing.",
    );
  }
  return "sdk";
}
