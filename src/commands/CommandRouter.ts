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
        return { type: "agents" };
      case "new":
        return { type: "new", agent: args[0], cwd: args[1] };
      case "ask":
        return { type: "ask", text: trimmed.slice(rawCommand.length).trim() };
      case "sessions":
        return { type: "sessions" };
      case "switch":
        return requireArg(args[0], "session id", (sessionId) => ({ type: "switch", sessionId }));
      case "agent":
        return requireArg(args[0], "agent name", (agent) => ({ type: "agent", agent }));
      case "use":
        return requireArg(args[0], "agent name", (agent) => ({ type: "use", agent, cwd: args[1] }));
      case "cancel":
        return { type: "cancel" };
      case "close":
        return { type: "close", sessionId: args[0] };
      case "status":
        return { type: "status" };
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
