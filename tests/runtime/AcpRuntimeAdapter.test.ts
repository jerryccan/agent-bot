import { describe, expect, test, vi } from "vitest";
import type { AcpSessionManager } from "../../src/acp/AcpSessionManager.js";
import type { JsonValue } from "../../src/acp/acpTypes.js";
import { AcpRuntimeAdapter } from "../../src/runtime/AcpRuntimeAdapter.js";
import type { RuntimeEvent } from "../../src/runtime/types.js";

describe("AcpRuntimeAdapter tool updates", () => {
  test("updates the local title for an ACP session", async () => {
    const acp = {
      create: vi.fn(async () => ({ acpSessionId: "acp_remote_title" })),
      cancel: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as AcpSessionManager;
    const runtime = new AcpRuntimeAdapter(acp);
    await runtime.createSession({
      localSessionId: "title_session",
      agentName: "legacy-acp",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await runtime.setTitle("title_session", "Renamed ACP task");

    expect(runtime.getSession("title_session")?.title).toBe("Renamed ACP task");
  });

  test("rejects local image prompts instead of silently dropping the image", async () => {
    const acp = {
      create: vi.fn(async () => ({ acpSessionId: "acp_remote_image" })),
      prompt: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as AcpSessionManager;
    const runtime = new AcpRuntimeAdapter(acp);
    await runtime.createSession({
      localSessionId: "image_session",
      agentName: "legacy-acp",
      cwd: process.cwd(),
      permissionMode: "auto",
    });

    await expect(runtime.startTurn("image_session", {
      text: "检查图片",
      localImagePaths: ["D:\\captures\\screen.png"],
    })).rejects.toThrow("当前 ACP Agent 不支持图片输入");
    expect(acp.prompt).not.toHaveBeenCalled();
  });

  test("merges command input with the result from a partial completion update", async () => {
    let onUpdate: ((session: never, update: Record<string, JsonValue>) => void) | undefined;
    let resolvePrompt: (() => void) | undefined;
    const promptFinished = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const acp = {
      create: vi.fn(async (input: { onUpdate: typeof onUpdate }) => {
        onUpdate = input.onUpdate;
        return { acpSessionId: "acp_remote_1" };
      }),
      prompt: vi.fn(() => promptFinished),
      cancel: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as AcpSessionManager;
    const runtime = new AcpRuntimeAdapter(acp);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    await runtime.createSession({
      localSessionId: "s1",
      agentName: "coco-yolo",
      cwd: process.cwd(),
      permissionMode: "auto",
    });
    await expect(runtime.setReasoningEffort("s1", "high")).rejects.toThrow(
      "ACP runtime does not expose reasoning effort through the gateway.",
    );
    await runtime.startTurn("s1", "inspect the directory");

    onUpdate?.({} as never, {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "bash",
      status: "in_progress",
      rawInput: {
        Command: "Get-ChildItem -Force",
        Description: "查看当前目录",
        TimeoutMilliseconds: 120_000,
      },
    });
    onUpdate?.({} as never, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "README.md\nsrc\ntests" } }],
      rawOutput: { Output: { stdout: "README.md\nsrc\ntests", stderr: "", exitCode: 0 } },
    });

    const started = events.find((event) => event.type === "tool_started");
    const completed = events.find((event) => event.type === "tool_updated");
    expect(started).toMatchObject({
      type: "tool_started",
      tool: { id: "call_1", title: "查看当前目录", command: "Get-ChildItem -Force", status: "running" },
    });
    expect(completed).toMatchObject({
      type: "tool_updated",
      tool: {
        id: "call_1",
        title: "查看当前目录",
        command: "Get-ChildItem -Force",
        output: "README.md\nsrc\ntests",
        exitCode: 0,
        status: "completed",
      },
    });

    resolvePrompt?.();
    await promptFinished;
    runtime.close();
  });
});
