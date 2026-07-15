# Startup Status Notification Design

## Goal

After every successful acp-bot restart, send one Feishu status card to each previously known Feishu conversation so the user can immediately see that the bot is online and what state it will resume from.

## Delivery behavior

- Send only after the Feishu WebSocket connector reports successful startup.
- Target every persisted `user_contexts.context_key` beginning with `chat_id:`; never send to `console:` contexts.
- Send exactly once per target during a process lifetime. A later process restart intentionally sends another card.
- Do not use a cross-restart idempotency key because each restart notification is a distinct event.
- A failed notification is logged with its context key and does not fail or stop application startup.
- If no Feishu context has been persisted yet, startup succeeds without sending anything.

## Card content

The card uses a green `acp-bot 已启动` header and contains:

- Online status.
- Local startup time.
- Configured default agent.
- Configured default working directory.
- Current persisted task ID and agent when present.
- The last persisted task/turn status, with running work described as resumable on the next message rather than currently executing.
- Short usage guidance: send a normal message to continue, `/new` to create a new task, and `/status` for details.

The card contains no callback-dependent buttons.

## Components

### StateStore

Add `listUserContexts(): UserContextRecord[]` to enumerate notification targets. Current session details continue to use the existing `getSession()` API.

### CardRenderer

Add a startup-card renderer that accepts a small view model instead of depending on storage or configuration directly. This keeps card formatting deterministic and testable.

### StartupNotifier

Add a focused service that:

1. reads persisted contexts;
2. filters Feishu chat contexts;
3. resolves each current session if present;
4. renders and sends one card per context;
5. isolates and logs per-context failures.

### Application startup

Construct the notifier only when the SDK Feishu outbound client exists. Call it immediately after `await feishuConnector.start()` and before starting the local console connector.

## Testing

- StateStore test: all persisted contexts can be listed.
- CardRenderer test: startup card contains the required status fields and no action/button elements.
- StartupNotifier tests: chat contexts receive one card, console contexts are skipped, session state is included, and one delivery failure does not block other targets or reject startup.
- Full unit suite, TypeScript typecheck, and build must pass before restarting the live server.
- The live restart is verified by observing both the startup log entry and the new Feishu status card delivery result.
