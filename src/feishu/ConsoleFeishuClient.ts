import type { FeishuOutbound } from "./types.js";

export class ConsoleFeishuClient implements FeishuOutbound {
  async sendText(contextKey: string, text: string): Promise<string> {
    console.log(`\n[${contextKey}] ${text}\n`);
    return `console-text-${Date.now()}`;
  }

  async sendMarkdown(contextKey: string, markdown: string): Promise<string> {
    console.log(`\n[${contextKey}] ${markdown}\n`);
    return `console-markdown-${Date.now()}`;
  }

  async sendInteractiveCard(contextKey: string, card: Record<string, unknown>): Promise<string> {
    console.log(`\n[${contextKey}] CARD ${JSON.stringify(card, null, 2)}\n`);
    return `console-card-${Date.now()}`;
  }

  async updateInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    console.log(`\n[${messageId}] UPDATE CARD ${JSON.stringify(card, null, 2)}\n`);
  }
}
