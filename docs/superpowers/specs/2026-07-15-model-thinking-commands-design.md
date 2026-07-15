# Model and Thinking Commands Design

## Goal

Make the active Codex model and reasoning effort visible and controllable from the gateway while preserving the existing model-switching command.

## Command Behavior

### `/model`

- `/model` displays the current model and current reasoning effort for the active session.
- `/model <name>` continues to switch the active session to the named model.
- The model change applies to the next turn and subsequent turns.
- The requested model must exist in the App Server model catalog.
- If the current reasoning effort is unsupported by the new model, the gateway changes it to that model's default reasoning effort and reports both the model change and the automatic fallback.

### `/thinking`

- `/thinking` displays the current reasoning effort and the reasoning efforts supported by the current model.
- `/thinking <level>` changes the active session's reasoning effort.
- The requested level must be one of the current model's `supportedReasoningEfforts` values.
- The change applies to the next turn and subsequent turns.
- Invalid levels return a concise error that includes the supported values.

## Architecture

Reasoning effort becomes first-class session state alongside model and permission mode:

- `SessionRecord` persists the selected reasoning effort in SQLite.
- `RuntimeSession`, create/resume inputs, and `AgentRuntime` expose the reasoning effort and a setter.
- `CodexRuntime` initializes in-memory effort from persisted session input when present, otherwise from the `reasoningEffort` returned by `thread/start` or `thread/resume`, and sends it as `turn/start.effort`.
- The runtime model catalog exposes each model's supported reasoning efforts and default effort.
- `ProxySessionController` owns command behavior, validation, persistence, and user-facing messages.
- The ACP adapter reports that model and reasoning configuration are unsupported instead of silently accepting changes.

## Data Flow

The current App Server protocol does not accept a reasoning-effort override on `thread/start` or `thread/resume`. When a Codex session is created or resumed, a persisted effort takes precedence in local session state; otherwise the actual `reasoningEffort` returned by App Server is used. If neither exists, the selected model's catalog default is used. The next `turn/start.effort` synchronizes that selected value to the App Server thread and subsequent turns.

Before each turn, `CodexRuntime` sends the session's current model and reasoning effort in `turn/start`. A successful `/thinking <level>` updates both the runtime session and SQLite. A successful `/model <name>` updates the model and, when required, atomically persists the default effort selected for the new model.

## Model Catalog and Validation

`model/list` entries are normalized to include:

- model ID and display name;
- default-model marker;
- `supportedReasoningEfforts` with descriptions;
- `defaultReasoningEffort`.

Commands use the normalized catalog rather than a hard-coded effort enum because supported levels can vary by model and Codex version.

If model catalog lookup fails, no local state is changed and the App Server error is returned through the controller's existing error path. If an active session has a model or effort that is no longer present in the catalog, display commands show the recorded value; mutation commands require a valid current catalog entry before changing state.

## Persistence

Add a nullable `reasoning_effort` column to the existing `sessions` table through the additive startup migration pattern used by `StateStore`. Existing databases remain valid. Session create, update, row mapping, and resume paths preserve the value.

The model and reasoning effort must be written together when a model switch triggers an automatic fallback so the stored state cannot represent an incompatible pair.

## User-Facing Messages

Responses remain concise and in Chinese, matching the current controller:

- `/model`: current model and current thinking strength.
- `/thinking`: current strength followed by supported values and descriptions when available.
- `/thinking <level>`: confirms the new strength and that it takes effect on the next request.
- `/model <name>` with fallback: confirms the new model and explicitly names the automatically selected default strength.

`/help` and `README.md` document both forms of each command.

## Testing

Use test-driven development with focused coverage for:

- parsing `/thinking` with and without an argument;
- displaying current model and reasoning effort from `/model`;
- displaying current and supported efforts from `/thinking`;
- accepting a supported effort and rejecting an unsupported effort without state changes;
- retaining a compatible effort on model switch;
- falling back to the new model's default effort when incompatible;
- persisting and reloading reasoning effort;
- mapping App Server thread response effort into runtime state;
- including `effort` in `turn/start`;
- ACP's explicit unsupported behavior;
- help text and relevant integration flow.

## Scope

This change does not add a graphical model picker, alter reasoning-summary rendering, or introduce global defaults outside the active session. It changes only the current session and takes effect from its next turn.
