import type { Logger } from "pino";
import { CardRenderer } from "../feishu/CardRenderer.js";
import type { FeishuOutbound } from "../feishu/types.js";
import type { StateStore } from "../state/StateStore.js";

export interface StartupNotificationOptions {
  defaultAgentName: string;
  defaultAgentTitle: string;
  cwd: string;
}

export class StartupNotifier {
  constructor(
    private readonly store: StateStore,
    private readonly outbound: FeishuOutbound,
    private readonly renderer: CardRenderer,
    private readonly logger: Pick<Logger, "warn">,
    private readonly options: StartupNotificationOptions,
  ) {}

  async notify(startedAt: Date): Promise<void> {
    let contexts;
    try {
      contexts = this.store.listUserContexts().filter((context) => context.contextKey.startsWith("chat_id:"));
    } catch (error) {
      this.logger.warn({ error }, "Failed to load startup notification targets.");
      return;
    }

    await Promise.all(contexts.map(async (context) => {
      const session = context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
      const card = this.renderer.renderStartupStatus({
        startedAt,
        defaultAgentName: this.options.defaultAgentName,
        defaultAgentTitle: this.options.defaultAgentTitle,
        cwd: this.options.cwd,
        currentTask: session
          ? {
              id: session.localSessionId,
              agentName: session.agentName,
              sessionStatus: session.status,
              lastTurnStatus: session.lastTurnStatus,
            }
          : undefined,
      });
      try {
        await this.outbound.sendInteractiveCard(context.contextKey, card);
      } catch (error) {
        this.logger.warn(
          { error, contextKey: context.contextKey },
          "Failed to send startup status notification.",
        );
      }
    }));
  }
}
