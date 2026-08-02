import type { Logger } from "pino";
import { detectProjectlessWorkspace } from "../codex/ProjectlessWorkspace.js";
import { CardRenderer } from "../feishu/CardRenderer.js";
import type { FeishuOutbound } from "../feishu/types.js";
import type { SessionRecord, StateStore, UserContextRecord } from "../state/StateStore.js";

export interface StartupNotificationOptions {
  agentBotVersion: string;
  defaultAgentName: string;
  defaultAgentTitle: string;
  cwd: string;
  workspaceKind?: "project" | "projectless";
  defaultUserOpenId?: string;
}

export interface StartupTaskMetadataHydrator {
  hydrate(session: SessionRecord): Promise<SessionRecord>;
}

interface StartupNotificationTarget {
  contextKey: string;
  context?: UserContextRecord;
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

  async notify(startedAt: Date, restartReason: string): Promise<void> {
    let targets: StartupNotificationTarget[];
    try {
      const activeGroupSince = new Date(startedAt.getTime() - 3 * 60 * 1_000);
      const chats = [
        ...this.store.listChatContexts("p2p"),
        ...this.store.listRecentlyActiveChatContexts(activeGroupSince)
          .filter((chat) => chat.chatType === "group"),
      ];
      targets = chats.map((chat) => ({
        contextKey: chat.contextKey,
        context: this.store.getUserContext(chat.contextKey),
      }));
    } catch (error) {
      this.logger.warn({ error }, "Failed to load startup notification targets.");
      throw new Error("Failed to load startup notification targets.", { cause: error });
    }

    if (targets.length === 0) {
      const defaultUserOpenId = this.options.defaultUserOpenId?.trim();
      if (!defaultUserOpenId) return;
      targets = [{ contextKey: `open_id:${defaultUserOpenId}` }];
    }

    const deliveries = await Promise.all(targets.map(async ({ contextKey, context }) => {
      let session = context?.currentSessionId ? this.store.getSession(context.currentSessionId) : undefined;
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
      const cwd = session?.cwd ?? this.options.cwd;
      const workspaceKind = session
        ? (detectProjectlessWorkspace(session.cwd) ? "projectless" : "project")
        : this.options.workspaceKind;
      const card = this.renderer.renderStartupStatus({
        startedAt,
        restartReason,
        agentBotVersion: this.options.agentBotVersion,
        defaultAgentName: this.options.defaultAgentName,
        defaultAgentTitle: this.options.defaultAgentTitle,
        cwd,
        workspaceKind,
        currentTask: session
          ? {
              id: session.remoteSessionId ?? session.localSessionId,
              title: session.title,
              modelProvider: session.modelProvider,
              model: session.model,
              reasoningEffort: session.reasoningEffort,
              permissionMode: session.permissionMode,
              agentName: session.agentName,
              sessionStatus: session.status,
              lastTurnStatus: session.lastTurnStatus,
            }
          : undefined,
      });
      try {
        await this.outbound.sendInteractiveCard(contextKey, card);
        return true;
      } catch (error) {
        this.logger.warn(
          { error, contextKey },
          "Failed to send startup status notification.",
        );
        return false;
      }
    }));
    if (deliveries.length > 0 && !deliveries.some(Boolean)) {
      throw new Error("Failed to send any startup status notification.");
    }
  }
}
