import { describe, expect, test } from "vitest";
import { CommandRouter } from "../../src/commands/CommandRouter.js";

describe("CommandRouter", () => {
  const router = new CommandRouter();

  test("parses local shell commands before prompt routing", () => {
    expect(router.parse("! ls")).toEqual({ type: "shell", command: "ls" });
    expect(router.parse("  ! Get-ChildItem | Select-Object -First 5  ")).toEqual({
      type: "shell",
      command: "Get-ChildItem | Select-Object -First 5",
    });
    expect(() => router.parse("!")).toThrow("请输入要执行的命令");
  });

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

  test("parses goal lifecycle commands", () => {
    expect(router.parse("/goal")).toEqual({ type: "goal", action: "show" });
    expect(router.parse("/goal 完成迁移并通过全部测试")).toEqual({
      type: "goal",
      action: "set",
      objective: "完成迁移并通过全部测试",
    });
    expect(router.parse('/goal edit "完成新的迁移"')).toEqual({
      type: "goal",
      action: "edit",
      objective: "完成新的迁移",
    });
    expect(router.parse("/goal pause")).toEqual({ type: "goal", action: "pause" });
    expect(router.parse("/goal resume")).toEqual({ type: "goal", action: "resume" });
    expect(router.parse("/goal clear")).toEqual({ type: "goal", action: "clear" });
    expect(() => router.parse("/goal edit")).toThrow("修改后的 Goal");
    expect(() => router.parse("/goal pause now")).toThrow("不接受额外参数");
  });

  test("creates new tasks with a title and an optional --dir working directory", () => {
    expect(router.parse("/new")).toEqual({ type: "new", title: undefined, cwd: undefined });
    expect(router.parse("/new 修复会话列表时间")).toEqual({
      type: "new",
      title: "修复会话列表时间",
      cwd: undefined,
    });
    expect(router.parse('/new "修复 会话列表" --dir "D:\\work space\\repo"')).toEqual({
      type: "new",
      title: "修复 会话列表",
      cwd: "D:\\work space\\repo",
    });
    expect(router.parse('/new --dir "D:\\work space\\repo" 修复会话列表')).toEqual({
      type: "new",
      title: "修复会话列表",
      cwd: "D:\\work space\\repo",
    });
    expect(router.parse('/new --dir "D:\\work space\\repo"')).toEqual({
      type: "new",
      title: undefined,
      cwd: "D:\\work space\\repo",
    });
    expect(() => router.parse("/new title --dir")).toThrow("--dir 后指定工作目录");
    expect(() => router.parse("/new --dir D:\\work --dir D:\\other")).toThrow("只能指定一次");
  });

  test("creates a new group with an optional title and rejects task-only --dir", () => {
    expect(router.parse("/newgroup")).toEqual({
      type: "newgroup",
      title: undefined,
    });
    expect(router.parse("/newgroup 广州天气")).toEqual({
      type: "newgroup",
      title: "广州天气",
    });
    expect(router.parse('/newgroup "广州 天气"')).toEqual({
      type: "newgroup",
      title: "广州 天气",
    });
    expect(() => router.parse("/newgroup 广州天气 --dir D:\\work")).toThrow("不支持 --dir");
  });

  test("parses fork with an optional session reference", () => {
    expect(router.parse("/fork")).toEqual({ type: "fork" });
    expect(router.parse("/fork 2")).toEqual({ type: "fork", sessionId: "2" });
    expect(router.parse("/fork 019f-thread")).toEqual({ type: "fork", sessionId: "019f-thread" });
    expect(() => router.parse("/fork 1 extra")).toThrow("只接受一个");
  });

  test("parses a title containing spaces", () => {
    expect(router.parse("/title 修复会话列表时间")).toEqual({ type: "title", title: "修复会话列表时间" });
    expect(router.parse('/title "Fix session title"')).toEqual({ type: "title", title: "Fix session title" });
    expect(() => router.parse("/title")).toThrow("请输入新标题");
  });

  test("parses stop without a cancel compatibility alias", () => {
    expect(router.parse("/stop")).toEqual({ type: "stop" });
    expect(router.parse("/cancel")).toEqual({ type: "prompt", text: "/cancel" });
  });

  test("parses a no-steer queued prompt", () => {
    expect(router.parse("/nosteer 完成后再运行全部测试")).toEqual({
      type: "nosteer",
      text: "完成后再运行全部测试",
    });
    expect(() => router.parse("/nosteer")).toThrow("请输入要排队的 Prompt");
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
