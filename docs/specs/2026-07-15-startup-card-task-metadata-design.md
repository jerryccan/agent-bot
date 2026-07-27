# Startup Card Task Metadata Design

## Goal

Make every Feishu startup card identify the current task by a human-readable title and show the model and reasoning effort that the task will use.

## User-facing behavior

When a current task exists, the startup card shows:

- the task's effective model;
- the task's effective reasoning effort;
- the task title;
- the local task ID as a separate diagnostic field;
- the existing agent and persisted task status fields.

The task title uses the Codex App Server's user-facing thread name when one is available. Until Codex generates that name, the first non-command user prompt is used as the fallback title. If neither value is available for a legacy or incomplete record, the local task ID remains the final fallback so the card never contains a blank task label.

When no current task exists, the card shows `默认` for the model, `自动` for reasoning effort, and retains the existing explanation that the next ordinary message creates a task.

Long titles are normalized to one line and truncated to a card-safe length. Card values continue to be escaped through the renderer's existing Markdown helpers.

## Chosen approach

Persist authoritative task metadata and update it as the runtime learns more:

1. Capture `thread.name` and `thread.preview` from `thread/start` and `thread/resume` responses.
2. Listen for the App Server's `thread/name/updated` notification and publish a runtime metadata event.
3. Save the first non-command prompt before starting the first turn, providing an immediate title before Codex has generated one.
4. Persist title, model, and reasoning effort in the session row.
5. Render the startup card entirely from persisted state.

For pre-existing Codex sessions whose persisted title is empty, startup performs a best-effort metadata hydration using `thread/read`. Successful results are persisted before rendering. A failed hydration is logged and falls back to the task ID; it does not delay or fail application startup indefinitely.

This is preferred over deriving every title only from the first prompt because it preserves Codex's generated titles and later title changes. It is also preferred over querying every thread on every startup because normal startup remains a local SQLite read after metadata has been persisted once.

## Data model

Add a nullable `title` column to `sessions` using `StateStore`'s additive migration pattern. Existing databases remain valid.

Expose `title?: string` on both `SessionRecord` and `RuntimeSession`. Extend runtime-session persistence so title, model, and reasoning effort are stored together whenever a session is created, resumed, hydrated, or updated by a runtime notification.

The stored title represents the best current display value. Codex's generated thread name may replace the prompt fallback. An empty or missing name notification does not erase a useful fallback title.

## Runtime flow

### Session creation and resume

`CodexRuntime` accepts the full thread metadata returned by `thread/start` and `thread/resume`. It selects the initial title in this order:

1. non-empty `thread.name`;
2. non-empty `thread.preview`;
3. persisted or locally supplied fallback title;
4. undefined.

The ACP adapter keeps title optional and does not fabricate Codex metadata.

### First prompt fallback

Before the controller starts a turn, it records a normalized form of the first ordinary user prompt if the session still has no title. Commands such as `/model` and `/thinking` never become task titles because they are handled outside the prompt path.

If turn startup fails, the prompt-derived title remains valid: it still describes the task the user attempted to create and will resume.

### Automatic title updates

`CodexRuntime` handles `thread/name/updated` separately from turn-scoped notifications because the notification contains a thread ID but no turn ID. It finds the matching local session, updates the in-memory title, and emits a `session_metadata_updated` event containing the new title.

`ProxySessionController` persists that event without forwarding it to the turn presenter. This prevents a title update from creating or modifying a progress card.

### Legacy hydration

Before sending startup notifications, the startup path asks the runtime metadata service to hydrate only current Codex sessions that have a remote thread ID and no persisted title. The service calls `thread/read` without loading turn history, persists any returned name or preview, and returns promptly on failure. Hydration is bounded per session and does not affect sessions that already have titles.

## Startup card layout

For a current task, the details appear in this order:

```text
当前模型：gpt-5.x
思考强度：high
当前任务：每次启动的卡片显示任务信息
任务 ID：sess_xxx
任务 Agent：codex
任务状态：上次已完成
```

For no current task:

```text
当前模型：默认
思考强度：自动
当前任务：无，下一条普通消息会创建新任务
```

The existing status, startup time, default agent, working directory, and usage guidance remain unchanged.

## Failure handling

- Missing model or effort on an existing task is rendered as `默认` or `自动` rather than omitted.
- Missing title falls back to the local task ID.
- Malformed or whitespace-only names are ignored.
- A metadata notification for an unknown thread is ignored.
- Legacy hydration failures are logged with the session ID and do not block other startup cards.
- SQLite migration remains additive and safe for existing state files.

## Testing

Use test-driven development with focused coverage for:

- persisting and reloading task titles through the additive SQLite migration;
- selecting `thread.name`, then `thread.preview`, from start and resume responses;
- handling `thread/name/updated` without requiring an active turn;
- persisting runtime metadata events in the controller without routing them to the turn presenter;
- recording only the first ordinary prompt as the fallback title;
- hydrating legacy current sessions through `thread/read` and tolerating hydration failures;
- rendering title, task ID, model, and reasoning effort in the startup card;
- rendering `默认` and `自动` when no task or task metadata exists;
- preserving existing startup notification fan-out and failure isolation;
- passing the full unit suite, TypeScript typecheck, and production build.

## Scope

This change affects startup-card metadata and the persistence needed to keep it accurate. It does not add manual task renaming, change `/model` or `/thinking` command semantics, alter normal turn cards, or query unrelated historical tasks during startup.
