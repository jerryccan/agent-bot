import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadConfig } from "../config/loadConfig.js";
import type { AppConfig } from "../config/schema.js";
import {
  CardRenderer,
  type InitializationWelcomeFeature,
  type InitializationWelcomeKind,
} from "../feishu/CardRenderer.js";
import { FeishuMessageClient } from "../feishu/FeishuMessageClient.js";
import type { CliLanguage } from "./i18n.js";

export interface InitializationReceipt {
  version: string;
  initializedAt: string;
}

export type InitializationWelcomeResult =
  | { status: "sent"; kind: InitializationWelcomeKind }
  | { status: "skipped"; kind: InitializationWelcomeKind; reason: "feishu-skipped" | "missing-user-open-id" }
  | { status: "failed"; kind: InitializationWelcomeKind; message: string };

export interface SendInitializationWelcomeInput {
  configPath?: string;
  language: CliLanguage;
  version: string;
  previousVersion?: string;
  kind: InitializationWelcomeKind;
  activationPending?: boolean;
}

export interface InitializationWelcomeDependencies {
  loadConfig(configPath?: string): AppConfig;
  sendCard(config: AppConfig, contextKey: string, card: Record<string, unknown>): Promise<void>;
  logoPath: string;
}

const INITIALIZATION_RECEIPT_FILE = "initialization.json";
const DEFAULT_LOGO_PATH = fileURLToPath(new URL("../../assets/agent-bot-logo.png", import.meta.url));

export function resolveInitializationWelcomeKind(input: {
  firstInitialization: boolean;
  previousVersion?: string;
  currentVersion: string;
}): InitializationWelcomeKind {
  if (input.firstInitialization) return "first";
  return input.previousVersion === input.currentVersion ? "refresh" : "upgrade";
}

export function readInitializationReceipt(homePath: string): InitializationReceipt | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(initializationReceiptPath(homePath), "utf8")) as Partial<InitializationReceipt>;
    if (typeof value.version !== "string" || !value.version.trim()) return undefined;
    if (typeof value.initializedAt !== "string" || !value.initializedAt.trim()) return undefined;
    return { version: value.version.trim(), initializedAt: value.initializedAt.trim() };
  } catch {
    return undefined;
  }
}

export function writeInitializationReceipt(homePath: string, version: string, initializedAt = new Date()): void {
  const filePath = initializationReceiptPath(homePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    version,
    initializedAt: initializedAt.toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

export async function sendInitializationWelcome(
  input: SendInitializationWelcomeInput,
  dependencies: InitializationWelcomeDependencies = defaultDependencies,
): Promise<Exclude<InitializationWelcomeResult, { status: "failed" }>> {
  const config = dependencies.loadConfig(input.configPath);
  const userOpenId = config.feishu.userOpenId?.trim();
  if (!userOpenId) {
    return { status: "skipped", kind: input.kind, reason: "missing-user-open-id" };
  }
  const defaultAgentName = config.defaults.agent!;
  const defaultAgent = config.agents[defaultAgentName]!;
  const renderer = new CardRenderer();
  const card = renderer.renderInitializationWelcome({
    kind: input.kind,
    language: input.language,
    version: input.version,
    previousVersion: input.previousVersion,
    activationPending: input.activationPending,
    defaultAgentName,
    defaultAgentTitle: defaultAgent.title,
    availableAgents: Object.values(config.agents).map((agent) => agent.title),
    logoPath: dependencies.logoPath,
    features: welcomeFeatures(input.kind, input.language),
  });
  await dependencies.sendCard(config, `open_id:${userOpenId}`, card);
  return { status: "sent", kind: input.kind };
}

function initializationReceiptPath(homePath: string): string {
  return path.join(homePath, "data", INITIALIZATION_RECEIPT_FILE);
}

function welcomeFeatures(
  kind: InitializationWelcomeKind,
  language: CliLanguage,
): InitializationWelcomeFeature[] {
  if (kind === "upgrade") {
    return language === "zh"
      ? [
          { icon: "⚙️", title: "Agent 状态更透明", description: "Server 状态会显示每个 Agent 的 PID 与版本。" },
          { icon: "🧭", title: "快速定位当前任务", description: "CLI 可识别正在调用它的 Codex 或 TraeX 任务。" },
          { icon: "🗂️", title: "卡片操作更顺手", description: "Help 命令可点击，Sessions 翻页与操作更清晰。" },
          { icon: "🛡️", title: "Crash 恢复更完整", description: "服务重启后会修复历史 Turn 的父子连接。" },
        ]
      : [
          { icon: "⚙️", title: "Clearer Agent status", description: "Server status now shows each Agent's PID and version." },
          { icon: "🧭", title: "Find the current task", description: "The CLI can identify its invoking Codex or TraeX task." },
          { icon: "🗂️", title: "Better card actions", description: "Clickable Help commands and clearer Sessions pagination." },
          { icon: "🛡️", title: "Stronger crash recovery", description: "Turn graph links are repaired after service recovery." },
        ];
  }
  if (kind === "refresh") {
    return language === "zh"
      ? [
          { icon: "💬", title: "随时开始对话", description: "私聊或群聊发送消息，即可继续当前任务。" },
          { icon: "🧠", title: "统一运行设置", description: "在同一张卡片中切换 Agent、模型、思考和权限。" },
          { icon: "🌿", title: "任务分支", description: "使用 New Group 或 Fork Group 并行处理工作。" },
          { icon: "🔄", title: "安全恢复", description: "任务、进度与服务状态会持久保存并恢复。" },
        ]
      : [
          { icon: "💬", title: "Start anywhere", description: "Continue work from a private chat or group conversation." },
          { icon: "🧠", title: "Unified settings", description: "Switch Agent, model, thinking, and permissions in one card." },
          { icon: "🌿", title: "Branch tasks", description: "Use New Group or Fork Group for parallel work." },
          { icon: "🔄", title: "Safe recovery", description: "Tasks, progress, and service state persist across restarts." },
        ];
  }
  return language === "zh"
    ? [
        { icon: "💬", title: "飞书直接对话", description: "私聊、群聊和话题分别维护自己的任务上下文。" },
        { icon: "🤖", title: "连接本地 Agent", description: "目前支持 Codex、TraeX 和兼容的编程 Agent。" },
        { icon: "🌿", title: "新建与分支", description: "把新任务或对话分支放进独立群聊并行推进。" },
        { icon: "📍", title: "进度始终可见", description: "通过思考卡片查看工具调用、文件变更和最终结果。" },
      ]
    : [
        { icon: "💬", title: "Work from Lark", description: "Private chats, groups, and topics keep separate task context." },
        { icon: "🤖", title: "Connect local Agents", description: "Use Codex, TraeX, and compatible coding Agents." },
        { icon: "🌿", title: "Create and branch", description: "Move fresh tasks or conversation branches into new groups." },
        { icon: "📍", title: "See every step", description: "Follow tools, file changes, and final results in progress cards." },
      ];
}

const defaultDependencies: InitializationWelcomeDependencies = {
  loadConfig,
  logoPath: DEFAULT_LOGO_PATH,
  sendCard: async (config, contextKey, card) => {
    const logger = pino({ level: "silent" });
    await new FeishuMessageClient(config, logger).sendInteractiveCard(contextKey, card);
  },
};
