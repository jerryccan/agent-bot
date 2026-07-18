import type { Command } from "./commandTypes.js";

export class CommandRouter {
  parse(text: string): Command {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return { type: "prompt", text };
    }

    const [rawCommand, ...args] = splitArgs(trimmed);
    const command = rawCommand.slice(1).toLowerCase();

    switch (command) {
      case "agents":
        return { type: "agent" };
      case "new":
        if (args.length > 1) throw new Error("/new 只接受一个可选工作目录；Agent 使用当前默认值。");
        return { type: "new", cwd: args[0] };
      case "fork":
        if (args.length > 1) throw new Error("/fork 只接受一个可选的任务序号或任务 ID。");
        return args[0] ? { type: "fork", sessionId: args[0] } : { type: "fork" };
      case "title":
        if (args.length === 0) throw new Error("请输入新标题，例如：/title 修复会话列表。");
        return { type: "title", title: args.join(" ") };
      case "ask":
        return { type: "ask", text: trimmed.slice(rawCommand.length).trim() };
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
        return { type: "prompt", text };
    }
  }
}

function requireArg<T>(value: string | undefined, name: string, create: (value: string) => T): T {
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return create(value);
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
