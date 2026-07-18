import { describe, expect, test } from "vitest";
import { CardRenderer } from "../../src/feishu/CardRenderer.js";
import type { TurnViewState } from "../../src/presentation/turnViewTypes.js";

function collectObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectObjects);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectObjects)];
}

function state(): TurnViewState {
  const completed = {
    id: "ok",
    title: "npm test",
    kind: "command",
    status: "completed" as const,
    command: "npm test",
    output: "\u001b[32mall passed\u001b[0m",
    exitCode: 0,
  };
  const failed = {
    id: "bad",
    title: "npm run lint",
    kind: "command",
    status: "failed" as const,
    command: "npm run lint",
    error: "命令失败",
    exitCode: 1,
  };
  return {
    sessionId: "s1",
    turnId: "turn_1",
    status: "running",
    startedAt: 1_000,
    durationMs: 51_600,
    progressText: "正在运行测试",
    assistantText: "",
    plan: [{ text: "执行测试", status: "in_progress" }],
    activities: [
      { kind: "reasoning", id: "reasoning:r1:0", text: "先检查测试配置" },
      { kind: "tool", id: "ok", tool: completed },
      { kind: "reasoning", id: "reasoning:r2:0", text: "再检查代码风格" },
      { kind: "tool", id: "bad", tool: failed },
    ],
    completedTools: [completed],
    failedTools: [failed],
    fileSummary: [{ path: "src/index.ts", additions: 5, deletions: 2 }],
  };
}

describe("CardRenderer", () => {
  test("renders a callback-free startup status card with resumable task state", () => {
    const card = new CardRenderer().renderStartupStatus({
      startedAt: new Date("2026-07-15T05:45:00.000Z"),
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      cwd: "D:\\dev\\acp-bot",
      currentTask: {
        id: "sess_1",
        title: "Startup task metadata",
        model: "gpt-test",
        reasoningEffort: "high",
        agentName: "codex",
        sessionStatus: "running",
        lastTurnStatus: "running",
      },
    });
    const serialized = JSON.stringify(card);
    const objects = collectObjects(card);

    expect(serialized).toContain("acp-bot 已启动");
    expect(serialized).toContain("在线");
    expect(serialized).toContain("Codex");
    expect(serialized).toContain("D:\\\\dev\\\\acp-bot");
    expect(serialized).toContain("sess_1");
    expect(serialized).toContain("当前模型");
    expect(serialized).toContain("gpt-test");
    expect(serialized).toContain("思考强度");
    expect(serialized).toContain("high");
    expect(serialized).toContain("Startup task metadata");
    expect(serialized).toContain("任务 ID");
    expect(serialized).toContain("下一条消息时恢复");
    expect(serialized).toContain("/new");
    expect(serialized).toContain("/status");
    expect(objects.filter((item) => item.tag === "button" || item.tag === "action")).toHaveLength(0);
  });

  test("renders default model and automatic effort when there is no current task", () => {
    const card = new CardRenderer().renderStartupStatus({
      startedAt: new Date("2026-07-15T05:45:00.000Z"),
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      cwd: "D:\\dev\\acp-bot",
      workspaceKind: "projectless",
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("当前模型");
    expect(serialized).toContain("默认");
    expect(serialized).toContain("思考强度");
    expect(serialized).toContain("自动");
    expect(serialized).toContain("任务范围");
    expect(serialized).toContain("未指定项目");
    expect(serialized).not.toContain("D:\\\\dev\\\\acp-bot");
    expect(serialized).toContain("下一条普通消息会创建新任务");
  });

  test("renders visible reasoning and one collapsed panel per tool in chronological order", () => {
    const card = new CardRenderer().renderTurn(state());
    const objects = collectObjects(card);
    const panels = objects.filter((item) => item.tag === "collapsible_panel");
    const toolPanels = panels.filter((panel) => !panelTitle(panel).startsWith("文件变更") && !panelTitle(panel).startsWith("计划"));
    const serialized = JSON.stringify(card);
    const markdownContents = objects
      .filter((item) => item.tag === "markdown")
      .map((item) => String(item.content ?? ""))
      .join("\n");
    const topLevel = ((card as { body: { elements: unknown[] } }).body.elements).map((element) => JSON.stringify(element));
    const activityOrder = ["先检查测试配置", "npm test", "再检查代码风格", "npm run lint"].map((text) =>
      topLevel.findIndex((element) => element.includes(text)),
    );

    expect(toolPanels).toHaveLength(2);
    expect(toolPanels.every((panel) => panel.expanded === false)).toBe(true);
    expect(toolPanels.every((panel) => JSON.stringify(panel.border) === JSON.stringify({ color: "grey", corner_radius: "5px" }))).toBe(true);
    expect(panels.every((panel) => (panel.header as { padding?: string }).padding === "4px 8px 4px 8px")).toBe(true);
    expect(panels.find((panel) => panelTitle(panel).startsWith("文件变更"))).toMatchObject({
      tag: "collapsible_panel",
      element_id: "turn_files",
      expanded: false,
    });
    expect(panels).toContainEqual(expect.objectContaining({
      tag: "collapsible_panel",
      expanded: true,
      direction: "vertical",
      vertical_spacing: "4px",
      padding: "8px",
      border: { color: "blue", corner_radius: "5px" },
    }));
    const completedPanel = toolPanels.find((panel) => panelTitle(panel).includes("npm test"));
    const detailElements = (completedPanel?.elements ?? []) as Array<{ content?: string }>;
    expect(detailElements).toHaveLength(1);
    expect(detailElements[0]?.content).toBe("```\n$ npm test\nall passed\n```");
    expect(activityOrder).toEqual([...activityOrder].sort((left, right) => left - right));
    expect(new Set(activityOrder).size).toBe(4);
    expect(card).toMatchObject({
      schema: "2.0",
      header: {
        subtitle: { tag: "plain_text", content: "耗时 51.6s · 2 个工具 · 1 个文件" },
        padding: "12px 12px 12px 12px",
      },
      body: {
        direction: "vertical",
        vertical_spacing: "8px",
        padding: "12px 12px 12px 12px",
        elements: expect.any(Array),
      },
    });
    expect(markdownContents).toContain("先检查测试配置");
    expect(markdownContents).toContain("> 💭 先检查测试配置");
    expect(markdownContents).toContain("```\n$ npm test\nall passed\n```");
    expect(markdownContents).toContain("```\n$ npm run lint\n命令失败\n```");
    for (const label of [
      "**状态**",
      "**耗时**",
      "**💭 思考**",
      "**工具**",
      "**命令**",
      "**退出码**",
      "**结果摘要**",
      "**错误摘要**",
    ]) {
      expect(markdownContents).not.toContain(label);
    }
    expect(markdownContents).not.toContain("\u001b");
    expect(markdownContents).not.toContain("完整内容请查看本地日志");
    expect(serialized).not.toContain("turn_details");
    expect(serialized).not.toContain("查看详情");
    expect(serialized).not.toContain("turn_cancel");
    expect(serialized).not.toContain("已完成的工具（");
    expect(serialized).not.toContain("失败的工具（");
    expect(serialized).not.toContain("/cancel");
  });

  test("uses a compact trailing ellipsis in long tool headers", () => {
    const running = state();
    const command = `Get-Content ${"x".repeat(150)}`;
    const active = { id: "long", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: active.id, tool: active }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("Get-Content"));

    expect(panelTitle(panel ?? {})).toMatch(/\.\.\.$/);
    expect(panelTitle(panel ?? {})).not.toContain("已截断");
  });

  test("unwraps PowerShell launchers in tool titles while preserving the full command in details", () => {
    const running = state();
    const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-Content src/index.ts | Select-Object -First 20"';
    const active = { id: "wrapped", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: active.id, tool: active }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("Get-Content"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe("⏳ Get-Content src/index.ts | Select-Object -First 20");
    expect(panelTitle(panel ?? {})).not.toMatch(/powershell|pwsh/i);
    expect(details).toContain(`$ ${command}`);
  });

  test("unwraps single-quoted multiline PowerShell commands into compact titles", () => {
    const running = state();
    const command = "powershell.exe -Command 'npm test -- --run\nif ($LASTEXITCODE -ne 0) { exit 1 }'";
    const tool = { id: "multiline", title: command, kind: "command", status: "completed" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("npm test"));

    expect(panelTitle(panel ?? {})).toBe("✅ npm test -- --run if ($LASTEXITCODE -ne 0) { exit 1 }");
  });

  test("keeps a stable identity for the trailing file panel as activities are inserted before it", () => {
    const running = state();
    const renderer = new CardRenderer();
    const before = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).startsWith("文件变更"));

    running.activities.push({ kind: "reasoning", id: "reasoning:new", text: "新增进度" });
    const after = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).startsWith("文件变更"));

    expect(before).toMatchObject({ element_id: "turn_files" });
    expect(after).toMatchObject({ element_id: "turn_files" });
  });

  test("preserves raw command formatting and both ends of oversized tool results", () => {
    const running = state();
    const command = `Write-Output 'first'\n${"x".repeat(900)}`;
    const output = `RESULT_HEAD\n${"a".repeat(700)}MIDDLE_SENTINEL${"b".repeat(700)}\nRESULT_TAIL`;
    const tool = { id: "long-output", title: "long output", kind: "command", status: "completed" as const, command, output };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("long output"));
    const content = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");
    const inner = content.slice(4, -4);
    const resultStart = inner.indexOf("\nRESULT_HEAD");
    const renderedCommand = inner.slice(2, resultStart);
    const renderedResult = inner.slice(resultStart + 1);

    expect(renderedCommand).toHaveLength(800);
    expect(renderedCommand).toMatch(/^Write-Output 'first'\n/);
    expect(renderedCommand).toMatch(/\.\.\.$/);
    expect(renderedResult).toHaveLength(1_200);
    expect(renderedResult).toContain("RESULT_HEAD");
    expect(renderedResult).toContain("RESULT_TAIL");
    expect(renderedResult).toContain("\n...\n");
    expect(renderedResult).not.toContain("MIDDLE_SENTINEL");
  });

  test("shows the active tool prominently and uses a completed header on completion", () => {
    const running = state();
    running.activeTool = { id: "active", title: "查看仓库", kind: "command", status: "running", command: "rg --files" };
    running.activities.push({ kind: "tool", id: "active", tool: running.activeTool });
    const runningCard = new CardRenderer().renderTurn(running);
    const runningPanel = collectObjects(runningCard).find((item) => panelTitle(item).includes("查看仓库"));
    expect(panelTitle(runningPanel ?? {})).toBe("⏳ 查看仓库");
    expect(runningPanel).toMatchObject({ border: { color: "grey", corner_radius: "5px" } });

    const completed = { ...state(), status: "completed" as const, completedAt: 4_000, durationMs: 3_000 };
    expect(JSON.stringify(new CardRenderer().renderTurn(completed))).toContain("已完成");
  });

  test("includes the current task title in every turn card header", () => {
    const completed = {
      ...state(),
      taskTitle: "优化飞书交互体验",
      status: "completed" as const,
      completedAt: 4_000,
      durationMs: 3_000,
    };

    const card = new CardRenderer().renderTurn(completed) as {
      header: { title: { content: string } };
    };

    expect(card.header.title.content).toBe("Codex 已完成：优化飞书交互体验");
  });

  test("renders approval controls with Card 2.0 callback behaviors", () => {
    const waiting = state();
    waiting.status = "waiting_for_approval";
    waiting.approval = {
      id: "approval_1",
      title: "允许运行命令？",
      command: "npm test",
      options: [
        { id: "accept", label: "允许" },
        { id: "cancel", label: "取消" },
      ],
    };

    const card = new CardRenderer().renderTurn(waiting);
    const objects = collectObjects(card);

    expect(card).toMatchObject({ schema: "2.0", body: { elements: expect.any(Array) } });
    expect(objects.some((item) => item.tag === "action")).toBe(false);
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
    }));
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "button",
      type: "primary",
      behaviors: [{
        type: "callback",
        value: {
          action: "approval",
          sessionId: "s1",
          turnId: "turn_1",
          requestId: "approval_1",
          decision: "accept",
        },
      }],
    }));
  });

  test("renders a useful Card 2.0 placeholder before the first progress event", () => {
    const starting = state();
    starting.status = "starting";
    starting.progressText = undefined;
    starting.activeTool = undefined;
    starting.plan = [];
    starting.activities = [];
    starting.completedTools = [];
    starting.failedTools = [];
    starting.fileSummary = [];

    const card = new CardRenderer().renderTurn(starting) as {
      schema: string;
      body: { elements: Array<{ tag: string; content: string }> };
    };

    expect(card.schema).toBe("2.0");
    expect(card.body.elements).toEqual([{ tag: "markdown", content: "正在连接 Codex…" }]);
  });

  test("renders commentary assistant text as plain Markdown and keeps final-answer text out of progress cards", () => {
    const generating = state();
    generating.progressText = undefined;
    generating.activeTool = undefined;
    generating.plan = [];
    generating.activities = [{
      kind: "reasoning",
      id: "commentary:1",
      text: "正在组织回答",
    }];
    generating.completedTools = [];
    generating.failedTools = [];
    generating.fileSummary = [];
    generating.assistantText = "正在组织回答正文";

    const runningCard = new CardRenderer().renderTurn(generating) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(runningCard.body.elements).toEqual([{
      tag: "markdown",
      content: "正在组织回答",
    }]);

    generating.status = "completed";
    const completedCard = new CardRenderer().renderTurn(generating) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(completedCard.body.elements).toEqual([{
      tag: "markdown",
      content: "正在组织回答",
    }]);

    const detailsCard = new CardRenderer().renderTurnDetails(generating) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(detailsCard.body.elements).toEqual([
      { tag: "markdown", content: "正在组织回答" },
      { tag: "hr" },
      { tag: "markdown", content: "**回答**\n正在组织回答正文" },
    ]);
  });

  test("renders reasoning lines without Markdown bold styling", () => {
    const running = state();
    running.activities = [{
      kind: "reasoning",
      id: "reasoning:bold:0",
      text: "**规划实现步骤**\n继续 __检查测试__",
    }];

    const card = new CardRenderer().renderTurn(running);
    const reasoning = collectObjects(card).find(
      (item) => item.tag === "markdown" && String(item.content).startsWith("> 💭"),
    );

    expect(reasoning).toEqual({
      tag: "markdown",
      content: "> 💭 规划实现步骤\n> 继续 检查测试",
    });
    expect(String(reasoning?.content)).not.toContain("**");
    expect(String(reasoning?.content)).not.toContain("__");
  });

  test("renders task actions as colored callback links below the body", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [{
      lines: ["**Task**", "就绪"],
      actions: [
        {
          text: "Switch",
          value: { action: "session_switch", sessionId: "thr_1" },
        },
        {
          text: "Status",
          value: { action: "session_status", sessionId: "thr_1" },
        },
      ],
    }], ["说明"]);
    const objects = collectObjects(card);
    const links = objects.filter((item) => item.tag === "interactive_container");

    expect(links).toContainEqual(expect.objectContaining({
      margin: "0px",
      padding: "0px",
      has_border: false,
      elements: [{
        tag: "markdown",
        content: "<font color='blue'>Switch</font>",
      }],
      behaviors: [{
        type: "callback",
        value: { action: "session_switch", sessionId: "thr_1" },
      }],
    }));
    expect(links).toContainEqual(expect.objectContaining({
      elements: [{
        tag: "markdown",
        content: "<font color='blue'>Status</font>",
      }],
      behaviors: [{
        type: "callback",
        value: { action: "session_status", sessionId: "thr_1" },
      }],
    }));
    expect(card).toMatchObject({ schema: "2.0", body: { elements: expect.any(Array) } });
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      margin: "2px 0 0 0",
    }));
    expect(objects.filter((item) => item.tag === "column")).toHaveLength(2);
    expect(objects.filter((item) => item.tag === "column")).toEqual(expect.arrayContaining([expect.objectContaining({
      tag: "column",
      width: "auto",
    })]));

    const bodyElements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    const taskBodyIndex = bodyElements.findIndex((item) => item.tag === "markdown" && item.content === "**Task**\n就绪");
    const actionRowIndex = bodyElements.findIndex((item) => item.tag === "column_set");
    expect(actionRowIndex).toBe(taskBodyIndex + 1);
  });

  test("renders status card actions as callback links after the sections", () => {
    const card = new CardRenderer().renderSectionsCard("Codex 状态", [{
      title: "指定任务",
      lines: ["空闲"],
    }], [{
      text: "Switch",
      value: { action: "session_switch", sessionId: "thr_1", cardView: "status" },
    }]);
    const bodyElements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

    expect(bodyElements.at(-1)).toMatchObject({
      tag: "column_set",
      columns: [expect.objectContaining({
        elements: [expect.objectContaining({
          tag: "interactive_container",
          elements: [{ tag: "markdown", content: "<font color='blue'>Switch</font>" }],
          behaviors: [{
            type: "callback",
            value: { action: "session_switch", sessionId: "thr_1", cardView: "status" },
          }],
        })],
      })],
    });
    expect(bodyElements.at(-2)).toEqual({ tag: "hr" });
  });

  test("renders destructive task actions as red callback links", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [{
      lines: ["**Task**"],
      actions: [{
        text: "Stop",
        type: "danger",
        value: { action: "session_stop", sessionId: "thr_1" },
      }],
    }], []);

    expect(collectObjects(card)).toContainEqual(expect.objectContaining({
      tag: "interactive_container",
      elements: [{
        tag: "markdown",
        content: "<font color='red'>Stop</font>",
      }],
      behaviors: [{
        type: "callback",
        value: { action: "session_stop", sessionId: "thr_1" },
      }],
    }));
  });

  test("allows the current task to render without an action control", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [{
      lines: ["✅ **Current task**", "执行中"],
    }], []);

    expect(collectObjects(card).some((item) => item.tag === "button" || item.tag === "interactive_container")).toBe(false);
  });

  test("renders a full-width footer action for loading more tasks", () => {
    const card = new CardRenderer().renderTaskListCard("Codex 任务", "任务", [], [], {
      text: "更多任务",
      type: "primary",
      value: { action: "session_more", visibleCount: "5" },
    });

    expect(collectObjects(card)).toContainEqual(expect.objectContaining({
      tag: "button",
      text: { tag: "plain_text", content: "更多任务" },
      type: "primary",
      width: "fill",
      behaviors: [{
        type: "callback",
        value: { action: "session_more", visibleCount: "5" },
      }],
    }));
  });
});

function panelTitle(panel: Record<string, unknown>): string {
  const header = panel.header as { title?: { content?: string } } | undefined;
  return header?.title?.content ?? "";
}
