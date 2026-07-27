import { describe, expect, test } from "vitest";
import { AGENT_BOT_ENVIRONMENT, agentBotEnvironment } from "../../src/runtime/agentEnvironment.js";

describe("agentBotEnvironment", () => {
  test("marks spawned agents as running under Agent Bot", () => {
    expect(AGENT_BOT_ENVIRONMENT.AGENT_BOT).toBe("1");
    expect(agentBotEnvironment({}, {}).AGENT_BOT).toBe("1");
  });

  test("preserves inherited and configured environment variables", () => {
    expect(agentBotEnvironment(
      { PATH: "system-path", SHARED: "from-system" },
      { CUSTOM: "agent-value", SHARED: "from-agent" },
    )).toMatchObject({
      PATH: "system-path",
      CUSTOM: "agent-value",
      SHARED: "from-agent",
      AGENT_BOT: "1",
    });
  });

  test("does not allow agent config to hide the Agent Bot marker", () => {
    expect(agentBotEnvironment(
      { AGENT_BOT: "0" },
      { AGENT_BOT: "false" },
    ).AGENT_BOT).toBe("1");
  });
});
