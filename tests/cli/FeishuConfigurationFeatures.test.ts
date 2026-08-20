import { describe, expect, it } from "vitest";
import {
  REQUIRED_FEISHU_CALLBACKS,
  REQUIRED_FEISHU_EVENTS,
  REQUIRED_FEISHU_SCOPES,
  type MissingFeishuAppConfiguration,
} from "../../src/cli/FeishuAppConfiguration.js";
import {
  feishuAffectedFeatures,
  feishuConfigurationFeatures,
  formatFeishuConfigurationFeatureIntroduction,
} from "../../src/cli/FeishuConfigurationFeatures.js";

const allMissing: MissingFeishuAppConfiguration = {
  scopes: [...REQUIRED_FEISHU_SCOPES],
  events: [...REQUIRED_FEISHU_EVENTS],
  callbacks: [...REQUIRED_FEISHU_CALLBACKS],
};

describe("FeishuConfigurationFeatures", () => {
  it("describes every requested scope, event, and callback", () => {
    const features = feishuConfigurationFeatures(allMissing, "en");

    expect(features.map(({ item }) => item)).toEqual([
      ...REQUIRED_FEISHU_SCOPES,
      ...REQUIRED_FEISHU_EVENTS,
      ...REQUIRED_FEISHU_CALLBACKS,
    ]);
    expect(features.every(({ feature }) => feature.trim().length > 0)).toBe(true);
  });

  it("renders localized feature explanations before authorization", () => {
    const missing: MissingFeishuAppConfiguration = {
      scopes: ["im:chat:delete", "im:message.p2p_msg:readonly"],
      events: ["im.message.receive_v1"],
      callbacks: ["card.action.trigger"],
    };

    const english = formatFeishuConfigurationFeatureIntroduction(missing, "en");
    const chinese = formatFeishuConfigurationFeatureIntroduction(missing, "zh");

    expect(english).toContain("What this configuration enables:");
    expect(english).toContain("im:chat:delete: dissolving task groups with /dismiss");
    expect(english).toContain("im:message.p2p_msg:readonly: receiving and responding to private messages");
    expect(chinese).toContain("这些配置对应的功能：");
    expect(chinese).toContain("im.message.receive_v1: 接收私聊、群聊和话题消息");
    expect(chinese).toContain("card.action.trigger: 使用卡片按钮和交互操作");
  });

  it("uses the same descriptions for skipped-authorization warnings", () => {
    const missing: MissingFeishuAppConfiguration = {
      scopes: ["im:chat:read"],
      events: ["im.chat.updated_v1"],
      callbacks: [],
    };

    expect(feishuAffectedFeatures(missing, "zh")).toEqual([
      "读取群信息，并在群重命名后同步任务标题",
      "感知群名称变更并同步任务标题",
    ]);
  });
});
