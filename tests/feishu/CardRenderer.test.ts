import { describe, expect, test } from "vitest";
import type { RuntimeSession } from "../../src/acp/AcpSessionManager.js";
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
    prompt: "检查卡片渲染",
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
  test("keeps auto-sized execution-setting tabs on one dot-separated row", () => {
    const card = new CardRenderer().renderExecutionSettings({
      sessionId: "session_1",
      contextKey: "chat_id:c1",
      activeTab: "permission",
      currentAgent: "codex",
      taskAgent: "codex",
      agents: [
        { name: "codex", title: "Codex" },
        { name: "traex", title: "TraeX" },
      ],
      runtimeSettingsAvailable: true,
      currentProvider: "openai",
      currentModel: "gpt-test",
      currentEffort: "high",
      currentPermissionMode: "auto",
      providers: [],
      providerSupported: true,
      models: [],
      reasoningOptions: [],
    });
    const tabRow = collectObjects(card).find((item) => (
      item.tag === "column_set"
      && Array.isArray(item.columns)
      && item.columns.length === 9
    ));
    const columns = tabRow?.columns as Array<Record<string, unknown>>;

    expect(columns).toHaveLength(9);
    expect(tabRow).toMatchObject({ flex_mode: "none", horizontal_spacing: "2px" });
    expect(columns.every((column) => column.width === "auto")).toBe(true);
    expect(columns.filter((_, index) => index % 2 === 1).map((column) => (
      (column.elements as Array<Record<string, unknown>>)[0]?.content
    ))).toEqual(["·", "·", "·", "·"]);
    const tabActions = collectObjects(tabRow).filter((item) => item.tag === "interactive_container");
    expect(tabActions).toHaveLength(4);
    expect(tabActions.every((action) => action.padding === "6px 0px")).toBe(true);
    expect(collectObjects(tabRow)
      .filter((item) => item.tag === "markdown")
      .every((label) => label.text_align === "center" && label.text_size === "notation")).toBe(true);
    expect(JSON.stringify(tabRow)).toContain("Permission");
  });

  test("renders ACP permission buttons in English regardless of supplied names", () => {
    const card = new CardRenderer().renderPermissionRequest(
      { localSessionId: "session_1" } as RuntimeSession,
      "permission_1",
      "npm test",
      [
        { optionId: "once", name: "允许一次", kind: "allow_once" },
        { optionId: "always", name: "始终允许", kind: "allow_always" },
        { optionId: "reject", name: "拒绝一次", kind: "reject_once" },
        { optionId: "never", name: "始终拒绝", kind: "reject_always" },
      ],
    );
    const labels = collectObjects(card)
      .filter((item) => item.tag === "button")
      .map((item) => (item.text as { content: string }).content);

    expect(labels).toEqual(["Allow Once", "Always Allow", "Deny Once", "Always Deny"]);
  });

  test("renders a compact cancellable prompt queue", () => {
    const card = new CardRenderer().renderPromptQueue({
      sessionId: "session_1",
      contextKey: "chat_id:c1",
      prompts: [
        { id: "queue_1", text: "先运行全部测试" },
        { id: "queue_2", text: "然后更新文档" },
      ],
    });
    const objects = collectObjects(card);
    const buttons = objects.filter((item) => item.tag === "button");
    const columns = objects.filter((item) => item.tag === "column");

    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "fill" },
      header: { title: { content: "排队 Prompt · 2" }, padding: "8px 12px 8px 12px" },
      body: { vertical_spacing: "4px", padding: "8px 12px 8px 12px" },
    });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({
      size: "tiny",
      text: { content: "Cancel" },
      behaviors: [{
        type: "callback",
        value: { action: "queued_prompt_cancel", promptId: "queue_1", sessionId: "session_1" },
      }],
    });
    expect(JSON.stringify(card)).toContain("1. 先运行全部测试");
    expect(JSON.stringify(card)).toContain("2. 然后更新文档");
    expect(columns.every((column) => (
      (column.elements as Array<Record<string, unknown>>)
        .every((element) => element.tag !== "plain_text")
    ))).toBe(true);
  });

  test("renders an empty prompt queue without unsupported plain_text body elements", () => {
    const card = new CardRenderer().renderPromptQueue({
      sessionId: "session_1",
      contextKey: "chat_id:c1",
      prompts: [],
    });

    expect(card).toMatchObject({
      body: {
        elements: [{ tag: "markdown", content: "队列为空" }],
      },
    });
  });

  test("renders a callback-free startup status card with resumable task state", () => {
    const card = new CardRenderer().renderStartupStatus({
      startedAt: new Date("2026-07-15T05:45:00.000Z"),
      restartReason: "用户执行 /restart 命令",
      agentBotVersion: "1.2.3",
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      cwd: "D:\\dev\\agent-bot",
      currentTask: {
        id: "sess_1",
        title: "Startup task metadata",
        model: "gpt-test",
        reasoningEffort: "high",
        permissionMode: "confirm",
        agentName: "codex",
        sessionStatus: "running",
        lastTurnStatus: "running",
      },
    });
    const serialized = JSON.stringify(card);
    const objects = collectObjects(card);

    expect(card).toMatchObject({
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      header: { template: "green" },
      body: { elements: expect.any(Array) },
    });
    expect(card).not.toHaveProperty("elements");
    expect(serialized).toContain("Agent Bot 已启动");
    expect(serialized).toContain("Agent Bot 版本");
    expect(serialized).toContain("1.2.3");
    expect(serialized).toContain("在线");
    expect(serialized).toContain("重启原因");
    expect(serialized).toContain("用户执行 /restart 命令");
    expect(serialized).toContain("codex");
    expect(serialized).toContain("D:\\\\dev\\\\agent-bot");
    expect(serialized).toContain("sess_1");
    expect(serialized).toContain("模型 / 思考强度 / 权限");
    expect(serialized).toContain("gpt-test");
    expect(serialized).toContain("high");
    expect(serialized).toContain("执行前确认");
    expect(serialized).toContain("Startup task metadata");
    expect(serialized).toContain("任务 ID");
    expect(serialized).toContain("任务状态 / Agent");
    expect(serialized).toContain("服务状态 / 启动时间");
    expect(serialized).toContain("下一条消息时恢复");
    expect(serialized).toContain("> 发送消息即可开始对话；发送 `/new` 创建新任务；发送 `/help` 查看帮助。");
    expect(serialized).not.toContain("发送 /status 查看详情");
    expect(objects.filter((item) => item.tag === "button" || item.tag === "action")).toHaveLength(0);
    const content = String(objects.find((item) => item.tag === "markdown")?.content);
    expect(content.indexOf("当前任务")).toBeLessThan(content.indexOf("工作目录"));
    expect(content.indexOf("工作目录")).toBeLessThan(content.indexOf("模型 / 思考强度 / 权限"));
    expect(content.indexOf("模型 / 思考强度 / 权限")).toBeLessThan(content.indexOf("Agent Bot 版本"));
    expect(content.indexOf("Agent Bot 版本")).toBeLessThan(content.indexOf("服务状态 / 启动时间"));
  });

  test("renders default model and automatic effort when there is no current task", () => {
    const card = new CardRenderer().renderStartupStatus({
      startedAt: new Date("2026-07-15T05:45:00.000Z"),
      restartReason: "Supervisor 启动",
      agentBotVersion: "1.2.3",
      defaultAgentName: "codex",
      defaultAgentTitle: "Codex",
      cwd: "D:\\dev\\agent-bot",
      workspaceKind: "projectless",
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("模型 / 思考强度 / 权限");
    expect(serialized).toContain("默认");
    expect(serialized).toContain("自动");
    expect(serialized).toContain("自动执行");
    expect(serialized).toContain("任务范围");
    expect(serialized).toContain("未指定项目");
    expect(serialized).not.toContain("D:\\\\dev\\\\agent-bot");
    expect(serialized).toContain("下一条普通消息会创建新任务");
  });

  test("renders safe restart blockers and countdown", () => {
    const renderer = new CardRenderer();
    const waiting = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "waiting_tasks",
      pendingFinalDeliveries: 1,
      waitingTasks: [{ id: "thread_1", title: "Long build" }],
    });
    const countdown = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "countdown",
      remainingMs: 12_350,
      pendingFinalDeliveries: 0,
      waitingTasks: [],
    });

    expect(JSON.stringify(waiting)).toContain("等待任务完成");
    expect(JSON.stringify(waiting)).toContain("Long build");
    expect(JSON.stringify(waiting)).toContain("thread_1");
    expect(JSON.stringify(waiting)).toContain("等待阻塞项清空后开始");
    expect(JSON.stringify(waiting)).toContain("<font color='blue'>Cancel</font>");
    expect(JSON.stringify(waiting)).toContain('"action":"safe_restart_cancel","scheduleId":"7"');
    expect(JSON.stringify(countdown)).toContain("13s");
    expect(countdown).toMatchObject({ header: { template: "orange" } });

    const cancelled = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "cancelled",
      pendingFinalDeliveries: 0,
      waitingTasks: [],
    });
    expect(JSON.stringify(cancelled)).toContain("已取消");
    expect(JSON.stringify(cancelled)).not.toContain(">Cancel</font>");
    expect(cancelled).toMatchObject({ header: { template: "grey" } });

    const restarting = renderer.renderSafeRestartStatus({
      scheduleId: 7,
      reason: "更新卡片分页",
      phase: "restarting",
      remainingMs: 0,
      pendingFinalDeliveries: 0,
      waitingTasks: [],
    });
    expect(JSON.stringify(restarting)).not.toContain(">Cancel</font>");
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
      config: { width_mode: "fill" },
      header: {
        subtitle: { tag: "plain_text", content: "耗时 52s · 2 个工具 · 1 个文件" },
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
    expect(serialized).toContain("<font color='red'>Stop</font>");
    expect(serialized).toContain('"action":"turn_cancel","sessionId":"s1","turnId":"turn_1"');
    expect(serialized).not.toContain("已完成的工具（");
    expect(serialized).not.toContain("失败的工具（");
    expect(serialized).not.toContain("/cancel");
  });

  test.each([
    [850, "耗时 0.9s"],
    [9_849, "耗时 9.8s"],
    [9_950, "耗时 10s"],
    [10_400, "耗时 10s"],
    [10_500, "耗时 11s"],
    [188_000, "耗时 03:08"],
    [4_320_000, "耗时 01:12:00"],
    [93_600_000, "耗时 26:00:00"],
  ])("formats a %i ms turn duration with adaptive precision", (durationMs, expectedDuration) => {
    const current = { ...state(), durationMs, totalTokens: 12_345 };
    const card = new CardRenderer().renderTurn(current) as { header: { subtitle: { content: string } } };

    expect(card.header.subtitle.content).toBe(`${expectedDuration} · 12.3K tokens · 2 个工具 · 1 个文件`);
  });

  test.each([
    [9_999, "9,999 tokens"],
    [10_000, "10K tokens"],
    [12_345, "12.3K tokens"],
    [2_242_908, "2.24M tokens"],
    [117_476_956, "117M tokens"],
    [1_234_567_890, "1.23B tokens"],
  ])("formats %i tokens compactly as %s", (totalTokens, expected) => {
    const current = { ...state(), totalTokens };
    const card = new CardRenderer().renderTurn(current) as { header: { subtitle: { content: string } } };

    expect(card.header.subtitle.content).toContain(expected);
  });

  test("uses the unbounded tool counter in the subtitle", () => {
    const current = { ...state(), totalToolCount: 778 };
    const card = new CardRenderer().renderTurn(current) as { header: { subtitle: { content: string } } };

    expect(card.header.subtitle.content).toContain("778 个工具");
  });

  test.each([
    [12_400, "12.4s"],
    [72_400, "01:12.4s"],
    [7_272_400, "02:01:12.4s"],
    [59_960, "01:00.0s"],
  ])("adds a compact %s ms duration to completed tool titles", (durationMs, expectedDuration) => {
    const current = state();
    const completed = {
      id: "timed",
      title: "npm test",
      kind: "command",
      status: "completed" as const,
      command: "npm test",
      startedAt: 1_000,
      completedAt: 1_000 + durationMs,
    };
    current.activities = [{ kind: "tool", id: completed.id, tool: completed }];

    const card = new CardRenderer().renderTurn(current);
    const panel = collectObjects(card).find((item) =>
      item.tag === "collapsible_panel" && panelTitle(item).includes("npm test"));

    expect(panelTitle(panel ?? {})).toBe(`✅ npm test · ${expectedDuration}`);
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

  test("unwraps PowerShell launchers in both tool titles and expanded command details", () => {
    const running = state();
    const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-Content src/index.ts | Select-Object -First 20"';
    const active = { id: "wrapped", title: command, kind: "command", status: "running" as const, command };
    running.activities = [{ kind: "tool", id: active.id, tool: active }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("Get-Content"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe("⏳ Get-Content src/index.ts | Select-Object -First 20");
    expect(panelTitle(panel ?? {})).not.toMatch(/powershell|pwsh/i);
    expect(details).toContain("$ Get-Content src/index.ts | Select-Object -First 20");
    expect(details).not.toMatch(/powershell|pwsh/i);
  });

  test("unwraps single-quoted multiline PowerShell commands into compact titles", () => {
    const running = state();
    const command = "powershell.exe -Command 'npm test -- --run\nif ($LASTEXITCODE -ne 0) { exit 1 }'";
    const tool = { id: "multiline", title: command, kind: "command", status: "completed" as const, command };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => item.tag === "collapsible_panel" && panelTitle(item).includes("npm test"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe("✅ npm test -- --run if ($LASTEXITCODE -ne 0) { exit 1 }");
    expect(details).toContain("$ npm test -- --run\nif ($LASTEXITCODE -ne 0) { exit 1 }");
    expect(details).not.toMatch(/powershell|pwsh/i);
  });

  test("uses the useful web-search action title while keeping full details expandable", () => {
    const running = state();
    const tool = {
      id: "web_1",
      title: "打开网页 · developers.openai.com/codex/app-server",
      kind: "web_search",
      status: "completed" as const,
      command: "open_page https://developers.openai.com/codex/app-server?source=test",
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).includes("打开网页"));
    const details = String(((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content) ?? "");

    expect(panelTitle(panel ?? {})).toBe("✅ 打开网页 · developers.openai.com/codex/app-server");
    expect(details).toContain("$ open_page https://developers.openai.com/codex/app-server?source=test");
  });

  test("renders a view_image preview inside the collapsed tool panel", () => {
    const running = state();
    const imagePath = "D:\\dev\\agent-bot\\.tmp\\preview.png";
    const tool = {
      id: "image_1",
      title: `查看图片 ${imagePath}`,
      kind: "image_view",
      status: "completed" as const,
      command: `view_image ${imagePath}`,
      imagePath,
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).includes("查看图片"));
    const elements = panel?.elements as Array<Record<string, unknown>> | undefined;

    expect(panel).toMatchObject({ tag: "collapsible_panel", expanded: false });
    expect(elements?.map((element) => element.tag)).toEqual(["markdown", "img"]);
    expect(elements?.[1]).toMatchObject({
      tag: "img",
      img_key: "",
      __acp_local_image_path: imagePath,
      preview: true,
    });
  });

  test("renders a generated image preview inside its tool panel", () => {
    const running = state();
    const imagePath = "D:\\dev\\agent-bot\\.tmp\\generated.png";
    const tool = {
      id: "generated_1",
      title: "生成图片",
      kind: "image_generation",
      status: "completed" as const,
      imagePath,
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).includes("生成图片"));
    const elements = panel?.elements as Array<Record<string, unknown>> | undefined;

    expect(elements?.[1]).toMatchObject({
      tag: "img",
      __acp_local_image_path: imagePath,
      preview: true,
    });
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

  test("shows project files as relative paths and external files as absolute paths", () => {
    const running = state();
    running.projectCwd = "D:\\dev\\agent-bot";
    const files = [
      { path: "D:\\dev\\agent-bot\\src\\index.ts", additions: 1 },
      { path: "src/relative.ts", additions: 2 },
      { path: "..\\shared\\config.ts", deletions: 1 },
      { path: "E:\\external\\other.ts", additions: 3 },
    ];
    const tool = {
      id: "file_change_1",
      title: "更新文件",
      kind: "file_change",
      status: "completed" as const,
      files,
    };
    running.activities = [{ kind: "tool", id: tool.id, tool }];
    running.fileSummary = files;

    const card = new CardRenderer().renderTurn(running);
    const markdownContents = collectObjects(card)
      .filter((item) => item.tag === "markdown")
      .map((item) => String(item.content ?? ""))
      .join("\n");

    expect(markdownContents).toContain("src\\index.ts  +1 -0");
    expect(markdownContents).toContain("src\\relative.ts  +2 -0");
    expect(markdownContents).toContain("D:\\dev\\shared\\config.ts  +0 -1");
    expect(markdownContents).toContain("E:\\external\\other.ts  +3 -0");
    expect(markdownContents).not.toContain("D:\\dev\\agent-bot\\src\\index.ts");
  });

  test("preserves the Windows separator before a dot directory in the file summary", () => {
    const running = state();
    running.projectCwd = "D:\\dev\\agent-bot";
    running.fileSummary = [{
      path: "C:\\Users\\Admin\\.agent-bot\\config.yaml",
      additions: 28,
      deletions: 4,
    }];

    const card = new CardRenderer().renderTurn(running);
    const panel = collectObjects(card).find((item) => panelTitle(item).startsWith("文件变更"));
    const content = String((panel?.elements as Array<{ content?: string }> | undefined)?.[0]?.content ?? "");

    expect(content).toContain("C:\\Users\\Admin\\\\.agent-bot\\config.yaml  +28 -4");
    expect(content).not.toContain("`");
  });

  test("keeps a stable identity for a tool panel while command output is updated", () => {
    const running = state();
    const renderer = new CardRenderer();
    const command = { id: "command:with/slashes", title: "npm test", kind: "command", status: "running" as const, command: "npm test" };
    running.activities = [{ kind: "tool", id: command.id, tool: command }];
    const before = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).includes("npm test"));

    running.activities = [{ kind: "tool", id: command.id, tool: { ...command, output: "test 1 passed" } }];
    const after = collectObjects(renderer.renderTurn(running)).find((item) => panelTitle(item).includes("npm test"));

    expect(before?.element_id).toMatch(/^turn_tool_[a-f0-9]{16}$/);
    expect(after?.element_id).toBe(before?.element_id);
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
    const completedCard = JSON.stringify(new CardRenderer().renderTurn(completed));
    expect(completedCard).toContain("已完成");
    expect(completedCard).not.toContain("turn_cancel");
  });

  test("uses the current status and prompt in every turn card header", () => {
    const completed = {
      ...state(),
      taskTitle: "任务标题不应出现在思考卡片中",
      prompt: "优化飞书交互体验",
      status: "completed" as const,
      completedAt: 4_000,
      durationMs: 3_000,
    };

    const card = new CardRenderer().renderTurn(completed) as {
      header: { title: { content: string } };
    };

    expect(card.header.title).toEqual({
      tag: "plain_text",
      content: "✅ 已完成：优化飞书交互体验",
    });
  });

  test.each([
    ["starting", "⏳ 正在处理"],
    ["running", "⏳ 正在处理"],
    ["tool_running", "⏳ 正在处理"],
    ["waiting_for_approval", "🙋 等待确认"],
    ["completed", "✅ 已完成"],
    ["failed", "❌ 执行失败"],
    ["cancelled", "⏹️ 已停止"],
  ] as const)("prefixes the %s turn title with its reaction emoji", (status, expectedTitle) => {
    const card = new CardRenderer().renderTurn({
      ...state(),
      prompt: undefined,
      taskTitle: undefined,
      status,
    }) as { header: { title: { content: string } } };

    expect(card.header.title.content).toBe(expectedTitle);
  });

  test("limits the prompt part of the turn title to 40 characters with three trailing dots", () => {
    const exact = new CardRenderer().renderTurn({
      ...state(),
      prompt: "问".repeat(40),
    }) as { header: { title: { content: string } } };
    const truncated = new CardRenderer().renderTurn({
      ...state(),
      prompt: `${"问".repeat(40)}🙂`,
    }) as { header: { title: { content: string } } };

    expect(exact.header.title.content).toBe(`⏳ 正在处理：${"问".repeat(40)}`);
    expect(truncated.header.title.content).toBe(`⏳ 正在处理：${"问".repeat(37)}...`);
  });

  test("keeps markup-like prompt text literal in a plain-text turn title", () => {
    const card = new CardRenderer().renderTurn({
      ...state(),
      prompt: "<at id=all></at> :DONE:",
    }) as { header: { title: { tag: string; content: string } } };

    expect(card.header.title).toEqual({
      tag: "plain_text",
      content: "⏳ 正在处理：<at id=all></at> :DONE:",
    });
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

    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "fill" },
      body: { elements: expect.any(Array) },
    });
    expect(objects.some((item) => item.tag === "action")).toBe(false);
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "column_set",
      flex_mode: "flow",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
    }));
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "button",
      text: { tag: "plain_text", content: "Allow Once" },
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
    expect(objects).toContainEqual(expect.objectContaining({
      tag: "button",
      text: { tag: "plain_text", content: "Cancel Task" },
      type: "danger",
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
    expect(runningCard.body.elements[0]).toEqual({
      tag: "markdown",
      content: "正在组织回答",
    });
    expect(JSON.stringify(runningCard.body.elements)).toContain('"action":"turn_cancel"');

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

  test("merges consecutive reasoning entries while preserving activity boundaries", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    const tool = { ...running.completedTools[0]!, id: "boundary-tool", title: "Boundary tool" };
    running.activities = [
      { kind: "reasoning", id: "reasoning:1", text: "第一段思考" },
      { kind: "reasoning", id: "reasoning:2", text: "第二段思考" },
      { kind: "tool", id: tool.id, tool },
      { kind: "reasoning", id: "reasoning:3", text: "第三段思考" },
      { kind: "reasoning", id: "reasoning:4", text: "第四段思考" },
      { kind: "assistant", id: "commentary:1", text: "Assistant text" },
      { kind: "reasoning", id: "reasoning:5", text: "第五段思考" },
    ];

    const renderer = new CardRenderer();
    const card = renderer.renderTurn(running);
    const reasoning = collectObjects(card)
      .filter((item) => item.tag === "markdown" && String(item.content).startsWith("> 💭"))
      .map((item) => String(item.content));

    expect(reasoning).toEqual([
      "> 💭 第一段思考\n> 💭 第二段思考",
      "> 💭 第三段思考\n> 💭 第四段思考",
      "> 💭 第五段思考",
    ]);
    const serialized = JSON.stringify(card);
    expect(serialized.indexOf("第二段思考")).toBeLessThan(serialized.indexOf("Boundary tool"));
    expect(serialized.indexOf("Boundary tool")).toBeLessThan(serialized.indexOf("第三段思考"));
    expect(serialized.indexOf("第四段思考")).toBeLessThan(serialized.indexOf("Assistant text"));
    expect(serialized.indexOf("Assistant text")).toBeLessThan(serialized.indexOf("第五段思考"));

    const history = renderer.renderActivityHistory(running, 0);
    const historyReasoning = collectObjects(history)
      .filter((item) => item.tag === "markdown" && String(item.content).startsWith("> 💭"));
    expect(historyReasoning).toHaveLength(3);
  });

  test("renders steer messages inline and preserves their activity order", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    running.activities = [
      { kind: "reasoning", id: "reasoning:1", text: "先检查代码" },
      { kind: "user", id: "steer:m1", text: "同时补充测试\n并检查结果" },
      { kind: "reasoning", id: "reasoning:2", text: "继续处理" },
    ];

    const renderer = new CardRenderer();
    const card = renderer.renderTurn(running);
    const serialized = JSON.stringify(card);
    expect(collectObjects(card)).toContainEqual({
      tag: "markdown",
      content: "**🙋 同时补充测试**\n**并检查结果**",
    });
    expect(serialized).not.toContain("用户追加");
    expect(serialized.indexOf("先检查代码")).toBeLessThan(serialized.indexOf("同时补充测试"));
    expect(serialized.indexOf("同时补充测试")).toBeLessThan(serialized.indexOf("继续处理"));

    const history = renderer.renderActivityHistory(running, 0);
    expect(collectObjects(history)).toContainEqual({
      tag: "markdown",
      content: "**🙋 同时补充测试**\n**并检查结果**",
    });
  });

  test("shows an ellipsis before retained activities when older history was discarded", () => {
    const running = state();
    running.plan = [];
    running.activitiesTruncated = true;
    running.activities = [{ kind: "reasoning", id: "reasoning:recent", text: "最近的思考" }];

    const card = new CardRenderer().renderTurn(running) as {
      body: { elements: Array<Record<string, unknown>> };
    };

    expect(card.body.elements.slice(0, 2)).toEqual([
      { tag: "markdown", content: "…" },
      { tag: "markdown", content: "> 💭 最近的思考" },
    ]);
  });

  test("shows the latest 40 mixed activities and links to uniform chronological pages", () => {
    const running = state();
    running.plan = [];
    running.fileSummary = [];
    running.activities = Array.from({ length: 45 }, (_value, index) => {
      const position = index + 1;
      if (position % 3 === 1) {
        return { kind: "assistant" as const, id: `commentary:${position}`, text: `Assistant ${position}` };
      }
      if (position % 3 === 2) {
        return {
          kind: "tool" as const,
          id: `tool:${position}`,
          tool: { ...running.completedTools[0]!, id: `tool:${position}`, title: `Tool ${position}` },
        };
      }
      return { kind: "reasoning" as const, id: `reasoning:${position}`, text: `Reasoning ${position}` };
    });

    const card = new CardRenderer().renderTurn(running);
    const serialized = JSON.stringify(card);

    expect(serialized).not.toContain("Tool 5");
    expect(serialized).toContain("Reasoning 6");
    expect(serialized).toContain("Assistant 7");
    expect(serialized).toContain("Tool 44");
    expect(serialized).toContain("Reasoning 45");
    expect(serialized).toContain("查看历史思考（共 2 页）");
    expect(serialized).toContain('"action":"activity_history"');
    const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    const historyLinkIndex = elements.findIndex((element) => element.tag === "column_set");
    const firstActivityIndex = elements.findIndex((element) => element.tag === "markdown");
    expect(historyLinkIndex).toBeGreaterThanOrEqual(0);
    expect(historyLinkIndex).toBeLessThan(firstActivityIndex);
  });

  test("paginates all activity types from oldest to newest in 40-item pages", () => {
    const running = state();
    running.activities = Array.from({ length: 81 }, (_value, index) => ({
      kind: "assistant" as const,
      id: `commentary:${index + 1}`,
      text: index === 0 ? `FIRST-${"a".repeat(5_000)}` : index === 80 ? "LAST-81" : `Activity ${index + 1}`,
    }));
    const renderer = new CardRenderer();
    const firstPage = JSON.stringify(renderer.renderActivityHistory(running, 0));
    const middlePage = JSON.stringify(renderer.renderActivityHistory(running, 1));
    const lastPage = JSON.stringify(renderer.renderActivityHistory(running, 2));

    expect(firstPage).toContain("思考活动历史 · 1/3");
    expect(firstPage).toContain("FIRST-");
    expect(firstPage).not.toContain("Activity 2");
    expect(firstPage).toContain("下一页");
    expect(firstPage).toContain("最新页");
    expect(middlePage).toContain("Activity 2");
    expect(middlePage).toContain("Activity 41");
    expect(middlePage).not.toContain("Activity 42");
    expect(middlePage).not.toContain("下一页");
    expect(middlePage).toContain('"page":"latest"');
    expect(lastPage).toContain("思考活动历史 · 3/3");
    expect(lastPage).toContain("Activity 42");
    expect(lastPage).toContain("LAST-81");
    expect(lastPage).toContain("上一页");
    expect(lastPage).toContain("最新页");

    const firstPageElements = (renderer.renderActivityHistory(running, 0) as {
      body: { elements: Array<Record<string, unknown>> };
    }).body.elements;
    expect(firstPageElements[0]?.tag).toBe("column_set");
    expect(firstPageElements[1]?.tag).toBe("hr");
    expect(firstPageElements[2]?.tag).toBe("markdown");
    const firstPageLabels = collectObjects(renderer.renderActivityHistory(running, 0))
      .filter((item) => item.tag === "interactive_container")
      .map((item) => JSON.stringify(item));
    expect(firstPageLabels[0]).toContain("最新页");
    expect(firstPageLabels[1]).toContain("下一页");

    const lastPageLabels = collectObjects(renderer.renderActivityHistory(running, 2))
      .filter((item) => item.tag === "interactive_container")
      .map((item) => JSON.stringify(item));
    expect(lastPageLabels[0]).toContain("最新页");
    expect(lastPageLabels[1]).toContain("上一页");
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
    expect(card).toMatchObject({
      schema: "2.0",
      config: { width_mode: "fill" },
      body: { elements: expect.any(Array) },
    });
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
    const card = new CardRenderer().renderSectionsCard("Codex 状态", [
      {
        title: "指定任务",
        lines: ["空闲"],
      },
      {
        title: "执行详情",
        lines: ["最近步骤"],
        collapsible: true,
        elementId: "status_execution_details",
      },
    ], [{
      text: "Switch",
      value: { action: "session_switch", sessionId: "thr_1", cardView: "status" },
    }]);
    const bodyElements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

    expect(collectObjects(card)).toContainEqual(expect.objectContaining({
      tag: "collapsible_panel",
      element_id: "status_execution_details",
      expanded: false,
      header: expect.objectContaining({
        title: { tag: "plain_text", content: "执行详情" },
      }),
    }));
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
      text: "More",
      type: "primary",
      value: { action: "session_more", visibleCount: "5" },
    });

    expect(collectObjects(card)).toContainEqual(expect.objectContaining({
      tag: "button",
      text: { tag: "plain_text", content: "More" },
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
