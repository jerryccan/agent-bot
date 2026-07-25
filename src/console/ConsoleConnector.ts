import readline from "node:readline";
import type { Logger } from "pino";
import type { FeishuEventHandler, IncomingMessage } from "../feishu/types.js";

export class ConsoleConnector {
  private reader?: readline.Interface;

  constructor(
    private readonly handler: FeishuEventHandler,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.reader) return;
    this.logger.info("Starting local Codex test console.");
    console.log("Codex console ready. Type /help or enter a prompt.");
    const reader = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "agent-bot> " });
    this.reader = reader;
    reader.prompt();
    reader.on("line", (line) => {
      const message: IncomingMessage = {
        messageId: `console-${Date.now()}`,
        contextKey: "console:local",
        userId: "local",
        text: line,
      };
      void this.handler.onMessage(message).catch((error) => {
        this.logger.error({ error }, "Console message handling failed.");
      }).finally(() => reader.prompt());
    });
    reader.on("close", () => {
      if (this.reader === reader) this.reader = undefined;
    });
  }

  stop(): void {
    this.reader?.close();
    this.reader = undefined;
  }
}
