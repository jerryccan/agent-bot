import type { AppConfig } from "../config/schema.js";

type FeishuTransportConfig = Pick<
  AppConfig["feishu"],
  "appId" | "appSecret"
>;

export function requireServerFeishuTransport(config: FeishuTransportConfig): "sdk" {
  if (!config.appId || !config.appSecret) {
    throw new Error(
      "飞书机器人尚未配置。请先运行 agent-bot init 完成初始化；仅需本地调试时请使用 agent-bot console。",
    );
  }
  return "sdk";
}
