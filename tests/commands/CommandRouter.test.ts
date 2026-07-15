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
});
