import type { Logger } from "pino";
import { CardRenderer } from "../feishu/CardRenderer.js";
import { isThreadContextKey } from "../feishu/contextKey.js";
import type { FeishuOutbound } from "../feishu/types.js";
import type { SessionRecord, StateStore } from "../state/StateStore.js";

export interface StartupNotificationOptions {
  defaultAgentName: string;
  defaultAgentTitle: string;
  cwd: string;
  workspaceKind?: "project" | "projectless";
}

export interface StartupTaskMetadataHydrator {
  hydrate(session: SessionRecord): Promise<SessionRecord>;
}

export class StartupNotifier {
  constructor(
    private readonly store: StateStore,
    private readonly outbound: FeishuOutbound,
    private readonly renderer: CardRenderer,
    private readonly logger: Pick<Logger, "warn">,
    private readonly options: StartupNotificationOptions,
    private readonly metadataHydrator?: StartupTaskMetadataHydrator,
  ) {}

  async notify(startedAt: Date): Promise<void> {
    let contexts;
    try {
      contexts = this.store.listUserContexts().filter((context) =>
        context.contextKey.startsWith("chat_id:") && !isThreadContextKey(context.contextKey),
      );
    } catch (error) {
      this.logger.warn({ error }, "Failed to load startup notification targets.");
      return;
    }

    await Promise.all(contexts.map(async (context) => {
      let session = context.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
      if (session && this.metadataHydrator) {
        try {
          session = await this.metadataHydrator.hydrate(session);
        } catch (error) {
          this.logger.warn(
            { error, sessionId: session.localSessionId },
            "Failed to hydrate startup task metadata.",
          );
        }
      }
      const card = this.renderer.renderStartupStatus({
        startedAt,
        defaultAgentName: this.options.defaultAgentName,
        defaultAgentTitle: this.options.defaultAgentTitle,
        cwd: this.options.cwd,
        workspaceKind: this.options.workspaceKind,
        currentTask: session
          ? {
              id: session.remoteSessionId ?? session.localSessionId,
              title: session.title,
              model: session.model,
              reasoningEffort: session.reasoningEffort,
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
