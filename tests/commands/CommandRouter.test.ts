import { describe, expect, test } from "vitest";
import { CommandRouter } from "../../src/commands/CommandRouter.js";

describe("CommandRouter", () => {
  const router = new CommandRouter();

  test("parses Codex permission commands", () => {
    expect(router.parse("/permissions confirm")).toEqual({ type: "permissions", mode: "confirm" });
    expect(router.parse("/permissions auto")).toEqual({ type: "permissions", mode: "auto" });
    expect(router.parse("/permissions")).toEqual({ type: "permissions" });
    expect(() => router.parse("/permissions unsafe")).toThrow("auto 或 confirm");
  });

  test("parses model selection and listing", () => {
    expect(router.parse("/model gpt-test")).toEqual({ type: "model", model: "gpt-test" });
    expect(router.parse("/model")).toEqual({ type: "model" });
  });

  test("parses thinking display and selection", () => {
    expect(router.parse("/thinking")).toEqual({ type: "thinking" });
    expect(router.parse("/thinking high")).toEqual({ type: "thinking", effort: "high" });
  });

  test("parses the process restart command", () => {
    expect(router.parse("/restart")).toEqual({ type: "restart" });
  });

  test("parses current and specified task status", () => {
    expect(router.parse("/status")).toEqual({ type: "status" });
    expect(router.parse("/status sess_1")).toEqual({ type: "status", sessionId: "sess_1" });
  });

  test("creates new tasks with only an optional working directory", () => {
    expect(router.parse("/new")).toEqual({ type: "new", cwd: undefined });
    expect(router.parse('/new "D:\\work space\\repo"')).toEqual({ type: "new", cwd: "D:\\work space\\repo" });
    expect(() => router.parse("/new codex D:\\work")).toThrow("Agent 使用当前默认值");
  });

  test("parses stop without a cancel compatibility alias", () => {
    expect(router.parse("/stop")).toEqual({ type: "stop" });
    expect(router.parse("/cancel")).toEqual({ type: "prompt", text: "/cancel" });
  });

  test("does not retain removed task aliases", () => {
    expect(router.parse("/attach 019f-thread")).toEqual({ type: "prompt", text: "/attach 019f-thread" });
    expect(router.parse("/detach")).toEqual({ type: "prompt", text: "/detach" });
    expect(router.parse("/close")).toEqual({ type: "prompt", text: "/close" });
  });

  test("parses Codex task discovery and unified switching", () => {
    expect(router.parse("/sessions desktop task")).toEqual({ type: "sessions", searchTerm: "desktop task" });
    expect(router.parse("/sessions")).toEqual({ type: "sessions" });
    expect(router.parse("/switch")).toEqual({ type: "switch" });
    expect(router.parse("/switch 019f-thread")).toEqual({ type: "switch", sessionId: "019f-thread" });
  });

  test("uses agent for both listing and selecting the default agent", () => {
    expect(router.parse("/agent")).toEqual({ type: "agent" });
    expect(router.parse("/agent codex")).toEqual({ type: "agent", agent: "codex" });
    expect(router.parse("/agents")).toEqual({ type: "agent" });
  });

});
