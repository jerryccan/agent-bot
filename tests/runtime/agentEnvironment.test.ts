import { describe, expect, test } from "vitest";
import { AGENT_BOT_ENVIRONMENT, agentBotEnvironment } from "../../src/runtime/agentEnvironment.js";

describe("agentBotEnvironment", () => {
  test("marks spawned agents as running under Agent Bot", () => {
    expect(AGENT_BOT_ENVIRONMENT.AGENT_BOT).toBe("1");
    expect(agentBotEnvironment({}, {}).AGENT_BOT).toBe("1");
  });

  test("preserves inherited and configured environment variables", () => {
    expect(agentBotEnvironment(
      { PATH: "system-path", SHARED: "from-system", PARENT_TOKEN: "parent-value" },
      { CUSTOM: "agent-value", SHARED: "from-agent" },
    )).toMatchObject({
      PATH: "system-path",
      CUSTOM: "agent-value",
      PARENT_TOKEN: "parent-value",
      SHARED: "from-agent",
      AGENT_BOT: "1",
    });
  });

  test("removes inherited and configured Agent Bot and Feishu variables", () => {
    const environment = agentBotEnvironment({
      FEISHU_APP_ID: "inherited-app",
      Feishu_App_Secret: "inherited-secret",
      FEISHU_USER_OPEN_ID: "inherited-user",
      AGENT_BOT_SUPERVISED: "1",
      AGENT_BOT_RESTART_REASON: "old reason",
      SAFE_PARENT: "preserved",
    }, {
      FEISHU_APP_SECRET: "configured-secret",
      agent_bot_start_delay_ms: "250",
      SAFE_AGENT: "preserved",
    });

    expect(environment).toMatchObject({
      AGENT_BOT: "1",
      SAFE_PARENT: "preserved",
      SAFE_AGENT: "preserved",
    });
    expect(Object.keys(environment).some((name) => name.toUpperCase().startsWith("FEISHU_"))).toBe(false);
    expect(environment.AGENT_BOT_SUPERVISED).toBeUndefined();
    expect(environment.AGENT_BOT_RESTART_REASON).toBeUndefined();
    expect(environment.agent_bot_start_delay_ms).toBeUndefined();
  });

  test("injects only the explicit safe Agent Bot context", () => {
    expect(agentBotEnvironment({}, {}, {
      profilePath: "C:\\Users\\tester\\.agent-bot-rescue",
      configPath: "C:\\Users\\tester\\.agent-bot-rescue\\config.yaml",
      agentName: "traex",
      larkAppId: "cli_app",
      larkBotOpenId: "ou_bot",
      larkUserOpenId: "ou_user",
    })).toMatchObject({
      AGENT_BOT: "1",
      AGENT_BOT_HOME: "C:\\Users\\tester\\.agent-bot-rescue",
      AGENT_BOT_CONFIG: "C:\\Users\\tester\\.agent-bot-rescue\\config.yaml",
      AGENT_BOT_AGENT_NAME: "traex",
      AGENT_BOT_LARK_APP_ID: "cli_app",
      AGENT_BOT_LARK_BOT_OPEN_ID: "ou_bot",
      AGENT_BOT_LARK_USER_OPEN_ID: "ou_user",
    });
  });

  test("does not allow agent config to hide the Agent Bot marker", () => {
    expect(agentBotEnvironment(
      { AGENT_BOT: "0" },
      { AGENT_BOT: "false" },
    ).AGENT_BOT).toBe("1");
  });
});
