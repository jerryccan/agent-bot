import type { Command } from "./commandTypes.js";

export class CommandRouter {
  parse(text: string): Command {
    const trimmed = text.trim();
    if (trimmed.startsWith("!") || trimmed.startsWith("！")) {
      const command = trimmed.slice(1).trim();
      if (!command) throw new Error("请输入要执行的命令，例如：! ls 或 ！ls");
      return { type: "shell", command };
    }
    if (!trimmed.startsWith("/")) {
      return { type: "prompt", text };
    }

    const [rawCommand, ...args] = splitArgs(trimmed);
    const command = rawCommand.slice(1).toLowerCase();

    switch (command) {
      case "agents":
        return { type: "agent" };
      case "new":
        return parseNewCommand(args);
      case "newgroup":
        return parseNewGroupCommand(args);
      case "forkgroup":
        return {
          type: "forkgroup",
          title: args.join(" ").trim() || undefined,
        };
      case "fork":
        if (args.length > 1) throw new Error("/fork 只接受一个可选的任务序号或任务 ID。");
        return args[0] ? { type: "fork", sessionId: args[0] } : { type: "fork" };
      case "title":
        if (args.length === 0) throw new Error("请输入新标题，例如：/title 修复会话列表。");
        return { type: "title", title: args.join(" ") };
      case "ask":
        return { type: "ask", text: trimmed.slice(rawCommand.length).trim() };
      case "queue":
      case "nosteer": {
        const prompt = trimmed.slice(rawCommand.length).trim();
        if (!prompt) throw new Error(`请输入要排队的 Prompt，例如：/${command} 完成后再运行全部测试。`);
        return { type: "nosteer", text: prompt };
      }
      case "sessions":
        return { type: "sessions", searchTerm: trimmed.slice(rawCommand.length).trim() || undefined };
      case "switch":
        return args[0] ? { type: "switch", sessionId: args[0] } : { type: "switch" };
      case "agent":
        return args[0] ? { type: "agent", agent: args[0] } : { type: "agent" };
      case "use":
        return requireArg(args[0], "agent name", (agent) => ({ type: "use", agent, cwd: args[1] }));
      case "stop":
        return { type: "stop" };
      case "status":
        return args[0] ? { type: "status", sessionId: args[0] } : { type: "status" };
      case "goal": {
        if (args.length === 0) return { type: "goal", action: "show" };
        const action = args[0]!.toLowerCase();
        if (action === "pause" || action === "resume" || action === "clear") {
          if (args.length > 1) throw new Error(`/goal ${action} 不接受额外参数。`);
          return { type: "goal", action };
        }
        if (action === "edit") {
          const objective = args.slice(1).join(" ").trim();
          if (!objective) throw new Error("请输入修改后的 Goal，例如：/goal edit 完成迁移并通过全部测试。");
          return { type: "goal", action: "edit", objective };
        }
        return { type: "goal", action: "set", objective: args.join(" ") };
      }
      case "restart":
        return { type: "restart" };
      case "modes":
        return { type: "modes" };
      case "mode":
        return requireArg(args[0], "mode value", (value) => ({ type: "mode", value }));
      case "model":
        return { type: "model", model: args[0] };
      case "thinking":
        return { type: "thinking", effort: args[0] };
      case "permissions": {
        const mode = args[0];
        if (mode !== undefined && mode !== "auto" && mode !== "confirm") {
          throw new Error("权限模式只能是 auto 或 confirm。");
        }
        return { type: "permissions", mode };
      }
      case "help":
        return { type: "help" };
      default:
        throw new Error(`未知命令：${rawCommand}。发送 /help 查看可用命令。`);
    }
  }
}

function requireArg<T>(value: string | undefined, name: string, create: (value: string) => T): T {
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return create(value);
}

function parseNewCommand(args: string[]): Extract<Command, { type: "new" }> {
  const titleParts: string[] = [];
  let cwd: string | undefined;
  let projectless = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--nodir") {
      if (projectless) throw new Error("/new 只能指定一次 --nodir。");
      if (cwd !== undefined) throw new Error("/new 的 --dir 和 --nodir 不能同时使用。");
      projectless = true;
      continue;
    }
    if (argument !== "--dir") {
      titleParts.push(argument);
      continue;
    }
    if (projectless) throw new Error("/new 的 --dir 和 --nodir 不能同时使用。");
    if (cwd !== undefined) throw new Error("/new 只能指定一次 --dir。");
    const directory = args[index + 1];
    if (!directory || directory === "--dir") {
      throw new Error("请在 --dir 后指定工作目录，例如：/new 修复会话列表 --dir D:\\dev\\project。");
    }
    cwd = directory;
    index += 1;
  }
  return {
    type: "new",
    title: titleParts.join(" ").trim() || undefined,
    cwd,
    ...(projectless ? { projectless: true } : {}),
  };
}

function parseNewGroupCommand(args: string[]): Extract<Command, { type: "newgroup" }> {
  if (args.includes("--dir")) {
    throw new Error("/newgroup 只创建飞书群，不支持 --dir；请在新群中使用 /new --dir <cwd> 创建任务。");
  }
  return {
    type: "newgroup",
    title: args.join(" ").trim() || undefined,
  };
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}
