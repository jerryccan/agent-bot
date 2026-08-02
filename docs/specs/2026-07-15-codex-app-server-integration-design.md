# Codex App Server Integration Design

## Summary

Integrate the locally authenticated Codex runtime into `agent-bot` through `codex app-server`. Feishu is the primary user interface; the console remains a lightweight test interface. The resulting experience preserves Codex threads, streaming progress, tool activity, steering, cancellation, model selection, and approval handling without replaying already-delivered history when a thread is resumed.

## Goals

- Use the existing local Codex authentication and capabilities without a second ChatGPT login.
- Let Feishu and the local console run concurrently with separate current-session state.
- Make Feishu feel responsive without flooding the chat or exceeding card-update limits.
- Preserve Codex threads across `agent-bot` restarts and lazily resume them on demand.
- Never resend successfully delivered historical messages when a Codex thread is resumed.
- Keep existing ACP agents working through Agent Bot.
- Default Codex sessions to automatic execution while allowing `/permissions confirm` per session.

## Non-goals

- Recreating the complete Codex terminal UI in the local console.
- Adding multi-user authorization or filesystem access controls.
- Replaying a prompt automatically after an App Server crash.
- Replaying missed historical output after an Agent Bot restart.
- Making the App Server reachable over a public WebSocket endpoint.

## User Experience

### Feishu turn lifecycle

Each user turn produces one progress card and one final Markdown answer.

1. On receipt of a prompt, send the progress card immediately. If no current session exists, create a default Codex session first.
2. Aggregate Codex delta events in memory. Do not send token-by-token Feishu updates.
3. Update the progress card with the current activity, plan, active tool, completed-tool summary, elapsed time, and file-change summary.
4. On completion, force a final card update and send the Codex final response as a separate Markdown message.
5. Do not send protocol-oriented completion messages such as `Completed: end_turn`.

The progress card has these visual states:

- `starting`: Codex is creating or resuming the thread.
- `running`: the model is working or producing text.
- `tool_running`: a command, file operation, MCP tool, or other tool is active.
- `waiting_for_approval`: the active turn is blocked on the user.
- `completed`: the turn completed successfully.
- `cancelled`: the user interrupted the turn.
- `failed`: the turn failed, with an actionable error summary.

### Card update cadence

- The first card send is immediate.
- Normal progress updates are coalesced and sent at most once every 2 seconds.
- Tool failure, approval request, cancellation, and turn completion are critical updates. They bypass the normal debounce but still keep a 500 ms minimum gap between Feishu writes.
- A dirty-state scheduler always renders the newest complete card. It never queues stale intermediate renders.
- Rate-limit retries use 2, 4, 8, 16, and 30 second delays. Newer state replaces older pending state during backoff.
- A final forced flush runs before the final Markdown response is sent.
- If the card content has not materially changed, no update call is made.

### Tool presentation

- The active tool is always visible and includes its readable title, status, and elapsed time.
- Successful completed tools are grouped under a collapsed section.
- Failed tools are automatically expanded and show an error summary.
- Command executions show command, exit code, duration, and a bounded output summary.
- File changes are aggregated as file count and line additions/deletions, with a collapsible file list.
- Large tool output is truncated inside the card. A `View turn details` button sends a separate details card built from the persisted bounded turn snapshot.
- Card actions are idempotent. The original approval card is replaced with its resolved state instead of sending an extra acknowledgement message.
- Card updates always send the complete new card document, as required by Feishu interactive-card updates.

### Final answer delivery

- The final answer is a separate Markdown message for readability, copying, and replies.
- Long output is split at safe Markdown boundaries. Fenced code blocks remain syntactically valid in every part.
- Delivery records store the generated Feishu message IDs and `final_delivered_at`.
- A successful final answer is never emitted again by resume or reconnect logic.

### Commands

- `/new [agent] [cwd]`: create a new session. Missing arguments select the default Codex agent and default directory.
- `/sessions`: list sessions in a card with switch and close actions.
- `/switch <session>`: select a session and lazily resume its remote thread if needed.
- `/model [model]`: show or change the current Codex model.
- `/permissions [auto|confirm]`: show or change the current session permission mode. The default is `auto`.
- `/status`: show App Server state, authentication mode, current session, model, directory, permission mode, and active turn.
- `/cancel`: interrupt the active Codex turn immediately.
- `/close [session]`: archive the Codex thread and close the local session.
- `/agent` and `/help`: continue to support the Agent Bot's multi-agent behavior.
- Plain text: start a turn, or steer the active turn when one is already running.

Control commands are not serialized behind a long-running turn. `/cancel` and `/status` are handled immediately. Plain text received during a turn uses `turn/steer`; if the turn is already completing, the text becomes the next queued turn.

## Architecture

```text
FeishuConnector -----\
                      -> ProxySessionController -> AgentRuntimeRegistry
ConsoleConnector ----/                              |             |
                                               ACP Runtime   Codex Runtime
                                                                  |
                                                        codex app-server

Codex events -> TurnStateReducer -> FeishuTurnPresenter -> FeishuMessageClient
                                      |
                              CardUpdateScheduler
```

### Runtime abstraction

Introduce an `AgentRuntime` abstraction so the controller no longer depends directly on `AcpSessionManager`. It supports:

- create and resume session;
- start and steer turn;
- cancel active turn;
- close or archive session;
- change model and permission mode;
- list models and runtime capabilities;
- emit normalized session and turn events.

The existing ACP implementation is adapted to this interface without changing its wire protocol. The Codex implementation uses App Server directly and retains Codex-specific fidelity in normalized events.

Agent configuration gains a runtime kind:

```yaml
agents:
  codex:
    kind: "codex"
    title: "Codex"
    command: "codex"
    args: ["app-server", "--listen", "stdio://"]
    env: {}

  example:
    kind: "acp"
    title: "Example ACP Agent"
    command: "node"
    args: ["./examples/example-acp-agent.js"]
    env: {}
```

Missing `kind` remains backward-compatible and means `acp`.

### Codex App Server process

- One long-lived `codex app-server` child process hosts all Codex threads.
- Communication uses App Server's JSON-RPC-lite JSONL protocol over stdio; it is separate from the existing ACP JSON-RPC connection.
- The Agent Bot sends `initialize`, then `initialized`, exactly once for each process generation.
- Request IDs, pending responses, notifications, and server-initiated requests are handled independently.
- TypeScript bindings are generated from the installed Codex binary during development as a protocol reference. The source tree keeps a focused, hand-audited subset of the message types used by the Agent Bot, plus contract tests against captured protocol fixtures, rather than checking in the entire generated API surface.
- The process inherits the current OS user and `CODEX_HOME`, reusing the existing ChatGPT login.
- Unexpected process exit rejects pending operations and marks active turns failed. Restart uses bounded exponential backoff.

### Session and event mapping

- Local session creation maps to `thread/start` with `cwd`, model, approval policy, and sandbox settings.
- Lazy recovery maps to `thread/resume`.
- A prompt maps to `turn/start`.
- Input during an active turn maps to `turn/steer`.
- Cancellation maps to `turn/interrupt`.
- Close maps to thread archive and local runtime cleanup.
- Agent-message deltas, plan changes, command events, file changes, MCP calls, approvals, and terminal turn states map to normalized `AgentEvent` values.

Permission modes map as follows:

- `auto`: approval policy `never`, with full local execution permissions.
- `confirm`: approval policy `on-request`, with approval requests delivered through Feishu cards.

Model and permission selections are sticky per local session and are supplied on later turns.

## Resume Without Message Replay

Resume behavior is deliberately live-only.

- `thread/resume` response data may contain historical turns and items. The runtime uses this data only to reconstruct internal Codex state and never converts it into outbound events.
- The event bridge remains closed while a thread is being resumed.
- Outbound event processing opens only after the Agent Bot starts a new turn and records its new `turnId`.
- Notifications are accepted only when they belong to the currently active locally-started turn.
- Thread-level lifecycle notifications may update internal status but never create Feishu messages.
- Persisted delivery records are used for idempotency and diagnostics, not as a replay queue.
- If the Agent Bot restarts during an active turn, that turn becomes `failed/interrupted`; the Agent Bot does not replay its prompt or fetch and resend its output.
- A manually requested details view reads the stored bounded turn snapshot. It is not automatic replay.

These rules guarantee that messages successfully delivered before a restart or resume are not sent again.

## Feishu Presentation Components

### Turn state reducer

`TurnStateReducer` is a pure state machine. It consumes normalized `AgentEvent` values and produces a complete `TurnViewState` containing:

- lifecycle status and timestamps;
- latest meaningful progress text;
- plan steps;
- active tool;
- completed and failed tool summaries;
- aggregate command and file-change statistics;
- approval state;
- final response and error summary.

It strips raw protocol details and bounds retained output before presentation or persistence.

### Card renderer

`CardRenderer` renders a complete Feishu card from `TurnViewState`. Completed tools and file lists use collapsible card sections. Unsupported or oversized detail degrades to compact Markdown summaries and the details action rather than additional chat messages.

### Card update scheduler

`CardUpdateScheduler` owns debounce, critical flushing, rate-limit backoff, material-change comparison, and final flushing. Rendering and scheduling remain separate so both are deterministic under tests.

### Outbound routing

Feishu and console connectors run concurrently. Context keys select the outbound presentation:

- `chat_id:*` -> `FeishuTurnPresenter` and `FeishuMessageClient`;
- `console:*` -> `ConsoleTurnPresenter`.

Each context has separate default-agent and current-session state. Console output is intentionally simple and exists to test the same controller and runtime behavior.

## Persistence

SQLite sessions store:

- runtime kind;
- local session ID;
- remote session ID (`threadId` for Codex, ACP session ID for ACP);
- context key, agent, and working directory;
- selected model and permission mode;
- last turn ID and status;
- last activity timestamp.

Turn snapshots store bounded presentation data for `/details`. Delivery records store the progress-card message ID, final-answer message IDs, last card hash, and successful-delivery timestamps. Existing ACP columns remain readable through a migration; no destructive migration is required.

## Failure Handling

- Initial card-send failure is retried before falling back to a concise text error.
- Card-update failures retain only the latest desired state and retry according to the update scheduler.
- Final-answer delivery uses bounded retries and records success only after the Feishu API succeeds.
- App Server crash fails the active turn and restarts the server, but never replays the prompt.
- Authentication errors instruct the user to restore the existing local Codex login.
- Missing directories, unavailable models, and resume failures produce concise actionable cards.
- A thread that cannot be resumed remains in session history as unavailable; the user is prompted to create a new thread.
- Duplicate Feishu inbound events and card actions are ignored using event or message IDs.

## Testing Strategy

### Unit tests

- App Server JSONL request, response, notification, and server-request handling.
- App Server initialization and process-generation restart behavior.
- Codex event-to-`AgentEvent` mapping.
- `TurnStateReducer` lifecycle, tool aggregation, file aggregation, and error states.
- Card rendering for running, waiting, completed, failed, collapsed-tools, and long-output states.
- Markdown-safe final-response splitting.
- Scheduler debounce, critical flush, unchanged-state suppression, final flush, and rate-limit backoff using fake timers.
- Command parsing for model and permission commands.
- State migrations and lazy session recovery.
- Resume regression: historical response items and notifications produce zero outbound messages.
- Active-turn steering and immediate cancellation bypass the normal message queue.

### Integration tests

- A deterministic fake App Server child process exercises initialize, thread start/resume, turn start/steer/interrupt, streaming events, approval requests, and process exit.
- A fake Feishu client records sends and updates, allowing assertions about message counts, ordering, complete-card replacement, and final delivery.
- Restart integration confirms that a resumed thread accepts a new turn without emitting old agent messages.
- Concurrent connector integration confirms Feishu and console contexts keep independent current sessions.

### Manual verification

- Use the existing locally authenticated Codex CLI runtime.
- Start `agent-bot` with both Feishu and console connectors enabled.
- From Feishu: create a session, run a code task, steer it, inspect tools, cancel a turn, switch permissions, and resume after restart.
- Confirm the progress card remains stable, completed tools stay folded, the final answer appears once, and no historical message reappears after resume.

## Acceptance Criteria

- A plain Feishu message automatically starts or resumes a Codex session.
- A visible progress card appears promptly and normal updates never exceed one write per 2 seconds.
- Tool progress, plan state, failures, file changes, and approvals are represented without chat-message flooding.
- The final Codex answer is readable Markdown and is delivered once.
- `/permissions auto|confirm`, `/model`, `/cancel`, steering, session switching, and session closing work.
- Feishu and console inputs can run concurrently with independent current sessions.
- Restarting `agent-bot` and resuming a thread never resends previously delivered messages.
- Existing ACP agents continue to work.
- Build, type checks, unit tests, integration tests, and the manual Feishu flow pass.
