import { describe, expect, test } from "vitest";
import { renderCliHelp } from "../../src/cli/help.js";

describe("CLI help", () => {
  test("always renders concise English help with common commands", () => {
    const help = renderCliHelp("1.2.3");

    expect(help).toContain("Agent Bot 1.2.3");
    expect(help).toContain("Usage:");
    expect(help).toContain("Common commands:");
    expect(help).toContain("agent-bot [options] <command>");
    expect(help).toContain("Initialize the Lark app and start the service");
    expect(help).toContain("Show the server, Lark App ID, and safe-restart status");
    expect(help).toContain("task prompt <task> <prompt>");
    expect(help).toContain("-h, --help");
    expect(help).not.toMatch(/[一-龥]/u);
  });
});
