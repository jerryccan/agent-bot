import type { MissingFeishuAppConfiguration } from "./FeishuAppConfiguration.js";
import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";

interface LocalizedFeatureDescription {
  en: string;
  zh: string;
}

export interface FeishuConfigurationFeature {
  item: string;
  feature: string;
}

const FEATURE_DESCRIPTIONS: Readonly<Record<string, LocalizedFeatureDescription>> = {
  "application:application:self_manage": {
    en: "allowing Agent Bot to inspect and complete this Lark app's configuration during initialization",
    zh: "允许 Agent Bot 在初始化时检查并补全当前飞书应用配置",
  },
  "im:chat:create": {
    en: "creating Lark groups with /newgroup and /forkgroup",
    zh: "使用 /newgroup 和 /forkgroup 创建飞书群",
  },
  "im:chat:delete": {
    en: "dissolving task groups with /dismiss",
    zh: "使用 /dismiss 解散任务群",
  },
  "im:chat:read": {
    en: "reading group information and synchronizing task titles after group renames",
    zh: "读取群信息，并在群重命名后同步任务标题",
  },
  "im:message.group_msg": {
    en: "responding to ordinary group messages that do not mention the bot",
    zh: "响应未 @ 机器人的普通群消息",
  },
  "im:message.p2p_msg:readonly": {
    en: "receiving and responding to private messages",
    zh: "接收并响应私聊消息",
  },
  "im:message.reactions:write_only": {
    en: "showing message-processing status with reactions",
    zh: "使用 Reaction 显示消息处理状态",
  },
  "im:message:readonly": {
    en: "reading referenced, forwarded, and image messages",
    zh: "读取引用消息、转发消息和图片消息",
  },
  "im:message:send_as_bot": {
    en: "sending Agent Bot replies, cards, files, and notifications",
    zh: "发送 Agent Bot 回复、卡片、文件和通知",
  },
  "im:message:update": {
    en: "updating sent progress cards",
    zh: "更新已发送的进度卡片",
  },
  "im:resource": {
    en: "uploading and downloading images or files, and setting group avatars",
    zh: "上传和下载图片或文件，以及设置群头像",
  },
  "im.message.receive_v1": {
    en: "receiving private, group, and topic messages",
    zh: "接收私聊、群聊和话题消息",
  },
  "im.chat.updated_v1": {
    en: "detecting group renames and synchronizing task titles",
    zh: "感知群名称变更并同步任务标题",
  },
  "card.action.trigger": {
    en: "using card buttons and interactive actions",
    zh: "使用卡片按钮和交互操作",
  },
};

export function feishuConfigurationFeatures(
  missing: MissingFeishuAppConfiguration,
  language: CliLanguage = cliLanguage,
): FeishuConfigurationFeature[] {
  return [...missing.scopes, ...missing.events, ...missing.callbacks].map((item) => ({
    item,
    feature: localizeFeature(item, language),
  }));
}

export function formatFeishuConfigurationFeatureIntroduction(
  missing: MissingFeishuAppConfiguration,
  language: CliLanguage = cliLanguage,
): string {
  const features = feishuConfigurationFeatures(missing, language);
  if (features.length === 0) return "";

  return [
    cliText("What this configuration enables:", "这些配置对应的功能：", language),
    ...features.map(({ item, feature }) => `  ${item}: ${feature}`),
    "",
  ].join("\n");
}

export function feishuAffectedFeatures(
  missing: MissingFeishuAppConfiguration,
  language: CliLanguage = cliLanguage,
): string[] {
  return [...new Set(feishuConfigurationFeatures(missing, language).map(({ feature }) => feature))];
}

function localizeFeature(item: string, language: CliLanguage): string {
  const description = FEATURE_DESCRIPTIONS[item];
  if (!description) {
    return cliText("supporting Agent Bot's Lark integration", "支持 Agent Bot 的飞书集成", language);
  }
  return cliText(description.en, description.zh, language);
}
